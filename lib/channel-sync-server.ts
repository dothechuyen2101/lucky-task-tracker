import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { ensureBotRole } from "@/lib/bot-roles";
import { type KnownChannel, type ListedServer, lastLook, planChannelSync } from "@/lib/channel-sync";
import { getBotGuilds, getGuildChannels } from "@/lib/discord";

/**
 * List the bot's servers and channels and bring `tt_channels` in step: new
 * channels added and watched (from `seedCursor`), known ones relabelled, and
 * nothing else on a known channel touched — its switch, cursor and history are
 * the owner's. Shared by the worker (every `CHANNEL_SYNC_EVERY_MS`) and
 * "Refresh from Discord" in Settings.
 *
 * Server-only: it calls Discord with the bot token and writes with the
 * service role. A server Discord would not list is reported, and the account's
 * `channels_synced_at` is then left where it was, so the next sync still reads
 * a channel made meanwhile from the earlier look.
 */

export type ChannelSyncResult = {
  servers: number;
  channels: number;
  added: Array<{ guild: string; channel: string }>;
  problems: string[];
};

/** Servers listed at once. Each is one request; Discord's cap is ~50/s per token. */
const SERVERS_AT_ONCE = 4;

/** The channel rows the plan compares against, a page at a time (PostgREST caps at 1000). */
const PAGE = 1000;

export async function syncChannels(
  db: SupabaseClient,
  {
    userId,
    botToken,
    botUserId,
    now = new Date(),
    learnRoles = "new",
  }: { userId: string; botToken: string; botUserId: string | null; now?: Date; learnRoles?: "new" | "all" },
): Promise<ChannelSyncResult> {
  // Throws on a bad token (401) — nothing can be listed, and the caller says so.
  const guilds = await getBotGuilds(botToken);

  const servers: ListedServer[] = [];
  const problems: string[] = [];
  // Whether every server was listed and every change written — only then may
  // the mark a new channel is read from move on.
  let complete = true;
  for (let i = 0; i < guilds.length; i += SERVERS_AT_ONCE) {
    await Promise.all(
      guilds.slice(i, i + SERVERS_AT_ONCE).map(async (guild) => {
        try {
          servers.push({ guild, channels: await getGuildChannels(botToken, guild.id) });
        } catch (error) {
          complete = false;
          problems.push(`${guild.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
  }

  const known: Array<KnownChannel & { created_at: string }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("tt_channels")
      .select("channel_id, channel_name, guild_name, parent_id, parent_name, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .order("channel_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`channel list: ${error.message}`);
    known.push(...((data ?? []) as Array<KnownChannel & { created_at: string }>));
    if (!data || data.length < PAGE) break;
  }

  const { data: connection } = await db.from("tt_connections").select("channels_synced_at").eq("user_id", userId).maybeSingle();
  const previous = lastLook((connection?.channels_synced_at as string | null) ?? null, known[0]?.created_at ?? null, now);
  const plan = planChannelSync(userId, servers, known, previous, now);

  // `ignoreDuplicates`: a channel Settings added a moment ago keeps whatever
  // the owner has done to it since.
  if (plan.added.length > 0) {
    const { error } = await db.from("tt_channels").upsert(plan.added, { onConflict: "user_id,channel_id", ignoreDuplicates: true });
    if (error) {
      complete = false;
      problems.push(`adding channels: ${error.message}`);
    }
  }
  // Labels only: the payload carries no switch, cursor or history column.
  if (plan.renamed.length > 0) {
    const { error } = await db.from("tt_channels").upsert(plan.renamed, { onConflict: "user_id,channel_id" });
    if (error) problems.push(`renaming channels: ${error.message}`);
  }

  // The bot's role in a server, learned before a tag of it can arrive there.
  if (botUserId) {
    const roleServers = learnRoles === "all" ? servers.map((s) => s.guild) : servers.map((s) => s.guild).filter((g) => plan.newServers.includes(g.id));
    for (const guild of roleServers) {
      const roles = await ensureBotRole(db, { userId, botToken, botUserId, guildId: guild.id });
      if (!roles) problems.push(`${guild.name}: could not list its roles; the bot's role there is learned the first time it is tagged`);
    }
  }

  // Only a complete look moves the mark a new channel is read from. (A role
  // lookup that failed is not a gap in the list; it is learned on first tag.)
  if (complete) {
    await db.from("tt_connections").update({ channels_synced_at: now.toISOString() }).eq("user_id", userId);
  }

  const name = new Map(servers.map((s) => [s.guild.id, s.guild.name]));
  return {
    servers: guilds.length,
    channels: servers.reduce((n, s) => n + s.channels.filter((c) => c.type === 0 || c.type === 5).length, 0),
    added: plan.added.map((row) => ({ guild: name.get(row.guild_id) ?? row.guild_id, channel: row.channel_name })),
    problems,
  };
}
