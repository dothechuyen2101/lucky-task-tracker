import { NextResponse } from "next/server";

import { getUser } from "@/lib/auth";
import { ensureBotRole } from "@/lib/bot-roles";
import { tryOpen } from "@/lib/crypto";
import { DiscordError, type DiscordMessage, getMessagesBefore, jumpUrl } from "@/lib/discord";
import { assigneesOf, authorName, isApp, readableMessage, relevanceOf, repliesTo } from "@/lib/relevance";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { answerForeignTags } from "@/lib/tag-answers";

/**
 * Walk backwards through a watched channel's history, keeping the messages
 * that tagged the user's bot — by name or by the role Discord made for it.
 *
 * The role is learned BEFORE the first page is read (`ensureBotRole`). History
 * read without it passed over every tag of the role and said nothing, which is
 * the gap Lucky35 found on 2026-09-29; a server whose roles Discord will not
 * list is refused outright rather than read blind.
 *
 * Watching a channel deliberately starts from "now", so everything said before
 * that moment is invisible. This is the button that goes and gets it.
 *
 * It runs BACKWARDS from `backfill_before_id`, which starts at the same
 * snowflake the forward cursor started from. The two walks therefore never
 * overlap and never collide: one goes forward from the switch-on point, this
 * one goes back from it. Progress is written after every page, so a run cut
 * short by the serverless time limit resumes exactly where it stopped instead
 * of restarting or double-reading.
 *
 * Nothing here classifies. Messages land unclassified and the normal tick
 * grades them on its own schedule — live tags first — which keeps this
 * endpoint fast and means a huge backfill cannot blow a hole in someone's
 * Claude limits in one go.
 *
 * One channel that cannot be read does not stop the rest. It is reported back
 * as `failed`, the caller adds it to `skip` and asks again, and the walk moves
 * on to the next channel; before, every press stopped on the same broken
 * channel and nothing after it in the list was ever read (2026-09-30).
 */

export const runtime = "nodejs";
export const maxDuration = 60;

/** Pages of 100 per request. The UI calls repeatedly until done. */
const PAGES_PER_CALL = 8;
const BUDGET_MS = 45_000;

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { channelId?: string; skip?: unknown };
  // Channels that already failed in this run of presses, by Discord channel id.
  const skip = Array.isArray(body.skip)
    ? body.skip.filter((id): id is string => typeof id === "string" && /^\d{1,25}$/.test(id)).slice(0, 500)
    : [];
  const db = createSupabaseServiceRoleClient();

  const [{ data: connection }, { data: profile }] = await Promise.all([
    db
      .from("tt_connections")
      .select("discord_bot_token_cipher, discord_bot_user_id, discord_bot_role_ids")
      .eq("user_id", user.id)
      .single(),
    db.from("tt_profiles").select("discord_user_id, discord_username").eq("id", user.id).single(),
  ]);

  const botToken = tryOpen(connection?.discord_bot_token_cipher);
  if (!botToken) return NextResponse.json({ error: "Connect a Discord bot first." }, { status: 400 });
  if (!profile?.discord_user_id) {
    return NextResponse.json({ error: "No Discord identity on your profile." }, { status: 400 });
  }

  // One channel if named, otherwise the next watched channel with work left.
  let query = db
    .from("tt_channels")
    .select("*")
    .eq("user_id", user.id)
    .eq("watching", true)
    .eq("backfill_done", false);

  if (body.channelId) query = query.eq("channel_id", body.channelId);
  if (skip.length > 0) query = query.not("channel_id", "in", `(${skip.join(",")})`);

  const { data: channels } = await query.order("channel_name", { ascending: true }).limit(1);
  let channel = channels?.[0];

  if (!channel) {
    return NextResponse.json({ ok: true, done: true, remaining: 0, ingested: 0 });
  }

  // This channel could not be read. Say so on it, and hand it back so the
  // caller skips it and carries on with the others.
  const failed = async (detail: string) => {
    await db.from("tt_channels").update({ last_error: detail }).eq("id", channel!.id);
    const remaining = await remainingAfter(db, user.id, [...skip, channel!.channel_id]);
    return NextResponse.json({
      ok: true,
      failed: { channelId: channel!.channel_id, channel: channel!.channel_name, error: detail },
      ingested: 0,
      remaining,
      done: remaining === 0,
    });
  };

  let botRoleIds = (connection?.discord_bot_role_ids as string[] | null) ?? [];

  // Teammates — everyone signed in to the tracker — hand out work through this

  // bot too, as the poller reads it (Lucky35, 2026-10-06).

  const { data: teamIds } = await db.rpc("tt_tracker_discord_ids");

  const team: ReadonlySet<string> = new Set(((teamIds ?? []) as string[]).filter(Boolean));
  if (connection?.discord_bot_user_id) {
    const roles = await ensureBotRole(db, {
      userId: user.id,
      botToken,
      botUserId: connection.discord_bot_user_id,
      guildId: channel.guild_id,
    });
    if (!roles) {
      return failed(
        `Could not list the roles in ${channel.guild_name ?? "this server"}, so messages that tagged the bot's role could not be recognised. Its history was not read — press Backfill again later.`,
      );
    }
    botRoleIds = roles.known;

    // Learning the role just now reopened this server's already-read history
    // (`rescan_reason`), this channel's included: read its row again so the
    // walk starts from the top instead of from a cursor set without the role.
    if (roles.learned) {
      const { data: fresh } = await db.from("tt_channels").select("*").eq("id", channel.id).single();
      if (fresh) channel = fresh;
    }
  }

  const deadline = Date.now() + BUDGET_MS;
  let cursor: string | null = channel.backfill_before_id ?? channel.last_message_id;
  let ingested = 0;
  let scanned = 0;
  let finished = false;
  // Someone else's tags of the bot, for someone else, found in this history:
  // never stored, but answered — 👀, and a DM to whoever tagged — before this
  // request returns (`answerForeignTags`).
  const foreign: DiscordMessage[] = [];
  const answerStrangers = () =>
    answerForeignTags(db, [], {
      userId: user.id,
      botToken,
      channel: channel!,
      tags: foreign,
      ownerName: profile.discord_username ?? null,
      publicReply: false,
    });

  if (!cursor) {
    await db.from("tt_channels").update({ backfill_done: true, rescan_reason: null }).eq("id", channel.id);
    return NextResponse.json({ ok: true, done: true, remaining: 0, ingested: 0 });
  }

  try {
    for (let page = 0; page < PAGES_PER_CALL; page += 1) {
      if (Date.now() > deadline) break;

      const batch = await getMessagesBefore(botToken, channel.channel_id, cursor);

      // An empty page means the start of the channel. That is the only way
      // this ever completes, so it must set backfill_done or the button would
      // spin forever on a fully-read channel.
      if (batch.length === 0) {
        finished = true;
        break;
      }

      scanned += batch.length;
      cursor = batch[0].id; // oldest of this page — keep walking back from there

      // Answered only once this page's progress is saved, so a page that is
      // read again after a failure never answers the same tag twice.
      const pageForeign: DiscordMessage[] = [];
      const relevant = batch.flatMap((m) => {
        // The bot's role in this server, learned above, counts as a tag.
        const verdict = relevanceOf(m, profile.discord_user_id!, connection?.discord_bot_user_id, botRoleIds, team);
        if (!verdict.keep && verdict.foreign) pageForeign.push(m);
        return verdict.keep ? [{ message: m, direction: verdict.direction }] : [];
      });

      if (relevant.length > 0) {
        const { error } = await db.from("tt_messages").upsert(
          relevant.map(({ message: m, direction: read }) => ({
            user_id: user.id,
            guild_id: channel.guild_id,
            channel_id: channel.channel_id,
            channel_name: channel.channel_name,
            message_id: m.id,
            // A forward is stored as what it forwards (`readableMessage`).
            content: readableMessage(m).content.slice(0, 4000),
            jump_url: jumpUrl(channel.guild_id, channel.channel_id, m.id),
            sent_at: m.timestamp,
            author_id: m.author.id,
            author_name: authorName(m),
            // A historical "@tracker deadline friday" was answered — or not — at
            // the time, and must never be replayed months later. It is stored
            // as the tagged message it is instead, so classification files it
            // or puts it on "Not filed": never closed off unseen (2026-09-30).
            direction: read === "command" ? "sent" : read,
            // Same field, same reason, as the poller in lib/worker.ts: there
            // are two ingest paths with one insert shape, and a change to
            // only one of them leaves half the data without an assignee.
            //
            // ignoreDuplicates: true below means an existing row is SKIPPED,
            // not merged, so re-running Backfill does not fill this column in
            // on messages already stored. Only messages ingested after this
            // shipped carry mentions; older rows are repaired from their
            // stored content instead. Do not "fix" that by flipping
            // ignoreDuplicates to false — a re-run would then overwrite the
            // classification of rows the worker has already processed.
            mentions: assigneesOf(readableMessage(m), profile.discord_user_id!, connection?.discord_bot_user_id),
            reply_to_message_id: repliesTo(m),
            // Posted by an integration: never replied to in public.
            from_app: isApp(m),
            // History, not a live tag: answered with its reaction and, since a
            // reaction on an old message is seen by nobody, by a DM to whoever
            // tagged (`answer_owed = 'late'`) — never by a public reply.
            backfilled: true,
          })),
          { onConflict: "user_id,message_id", ignoreDuplicates: true },
        );

        if (error) throw new Error(error.message);
        ingested += relevant.length;
      }

      // Persist after every page so a killed request loses nothing.
      await db
        .from("tt_channels")
        .update({
          backfill_before_id: cursor,
          backfill_messages: (channel.backfill_messages ?? 0) + ingested,
          backfilled_at: new Date().toISOString(),
        })
        .eq("id", channel.id);
      foreign.push(...pageForeign);
    }
  } catch (error) {
    const detail =
      error instanceof DiscordError && error.isAccess
        ? "The bot cannot read this channel's history. Check Read Message History."
        : error instanceof Error
          ? error.message
          : String(error);

    await answerStrangers();
    return failed(detail);
  }

  await answerStrangers();

  if (finished) {
    // Read to the very start with the bot's role known: whatever reopened it
    // for a re-read is now done.
    await db
      .from("tt_channels")
      .update({ backfill_done: true, backfilled_at: new Date().toISOString(), rescan_reason: null })
      .eq("id", channel.id);
  }

  const remaining = await remainingAfter(db, user.id, skip);

  return NextResponse.json({
    ok: true,
    channel: channel.channel_name,
    scanned,
    ingested,
    finished,
    remaining,
    done: remaining === 0,
  });
}

/** Watched channels with history still to read, not counting the ones this run is skipping. */
async function remainingAfter(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
  skip: string[],
): Promise<number> {
  let query = db
    .from("tt_channels")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("watching", true)
    .eq("backfill_done", false);
  if (skip.length > 0) query = query.not("channel_id", "in", `(${skip.join(",")})`);
  const { count } = await query;
  return count ?? 0;
}
