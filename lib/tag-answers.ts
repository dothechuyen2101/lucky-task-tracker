import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DiscordError,
  type DiscordMessage,
  addReaction,
  jumpUrl,
  replyTo,
  sendDirectMessage,
  sendReminder,
} from "@/lib/discord";
import { isApp } from "@/lib/relevance";
import { siteUrl } from "@/lib/site";
import {
  ANSWER_DM_EVERY_MS,
  type OwedRow,
  SKIPPED_REACTION,
  foreignTagReply,
  lateAnswer,
  receiptDigest,
  receiptFor,
} from "@/lib/triage";
import type { Channel } from "@/lib/types/database";

/**
 * Answering a tag on Discord, where the person who tagged will see it —
 * shared by the worker (every live tag) and Backfill (tags found in history).
 *
 * Server-only: it calls Discord with the bot token and writes with the
 * service role. The rule it exists for (Lucky35, 2026-09-28 to -30): every tag
 * of the bot is answered, and answered where the tagger will notice. A ✅ / 👀
 * on the message is enough only while they are looking at it; a tag read late,
 * or one the bot could not react to, is owed a DM (`tt_messages.answer_owed`),
 * and `sendOwedAnswers` pays that debt from the database, so a run that dies
 * in between loses nothing.
 */

export const REACT_BLOCKED = "The bot is not allowed to add reactions in this channel. Invite it again from Settings.";

/** `tt_alerts.kind` for a DM answering tags. */
const RECEIPT_ALERT_KIND = "receipt";

/** Owed rows answered per account per pass — keeps the `in (...)` filter short. */
const OWED_PER_PASS = 200;

export type ReactOutcome = "ok" | "forbidden" | "gone" | "failed";

/**
 * Put the reaction on. A short rate limit is waited out once, because
 * reactions are limited per channel and a burst of tags in one channel is
 * exactly when the sender is watching. "forbidden" is the bot lacking the
 * permission; "gone" is a message deleted since it was read.
 */
export async function acknowledge(
  errors: string[],
  botToken: string,
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<ReactOutcome> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await addReaction(botToken, channelId, messageId, emoji);
      return "ok";
    } catch (error) {
      if (error instanceof DiscordError && error.status === 429 && attempt === 0 && (error.retryAfterMs ?? 0) <= 2_000) {
        await new Promise((resolve) => setTimeout(resolve, error.retryAfterMs ?? 500));
        continue;
      }
      if (error instanceof DiscordError && error.status === 403) return "forbidden";
      if (error instanceof DiscordError && error.status === 404) return "gone";
      errors.push(`reaction: ${describe(error)}`);
      return "failed";
    }
  }
  return "failed";
}

/**
 * What a reaction attempt says about the channel: refused means the bot may
 * not react there (the board warns, with the re-invite); one that went through
 * clears that warning.
 */
export async function noteReaction(db: SupabaseClient, userId: string, channelId: string, outcome: ReactOutcome) {
  if (outcome === "ok") {
    await db
      .from("tt_channels")
      .update({ react_error: null, react_error_at: null })
      .eq("user_id", userId)
      .eq("channel_id", channelId)
      .not("react_error", "is", null);
  } else if (outcome === "forbidden") {
    await db
      .from("tt_channels")
      .update({ react_error: REACT_BLOCKED, react_error_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("channel_id", channelId);
  }
}

/**
 * Someone else tagged this bot about work for a third person (`relevanceOf`'s
 * `foreign`). Nothing of it is stored and no card is made — the bot tracks its
 * owner's tasks — but the tag is answered: 👀, and a fixed line saying whose
 * tasks it tracks.
 *
 * The line is a reply under the message when `publicReply` (a live tag; never
 * history, never an integration's post, which an echo bot would answer back).
 * It goes to the tagger by DM as well when the tag was read late — a reply
 * under an old message pings nobody — or when nothing could be put on the
 * message at all. An integration cannot be DMed; its 👀 is its answer.
 */
export async function answerForeignTags(
  db: SupabaseClient,
  errors: string[],
  input: { userId: string; botToken: string; channel: Channel; tags: DiscordMessage[]; ownerName: string | null; publicReply: boolean },
) {
  const { userId, botToken, channel, tags, ownerName, publicReply } = input;
  if (tags.length === 0) return;
  const text = foreignTagReply(ownerName, siteUrl());
  const now = new Date();
  const byAuthor = new Map<string, string[]>();

  for (const tag of tags) {
    const reacted = await acknowledge(errors, botToken, channel.channel_id, tag.id, SKIPPED_REACTION);
    await noteReaction(db, userId, channel.channel_id, reacted);
    if (reacted === "gone") continue;

    const app = isApp(tag);
    let replied = false;
    if (publicReply && !app) {
      try {
        await replyTo(botToken, channel.channel_id, tag.id, text);
        replied = true;
      } catch (error) {
        errors.push(`reply to a tag for someone else: ${describe(error)}`);
      }
    }

    const writtenAt = tag.edited_timestamp ?? tag.timestamp;
    const late = lateAnswer(writtenAt, now) !== null;
    if (!app && (late || (!replied && reacted !== "ok"))) {
      byAuthor.set(tag.author.id, [...(byAuthor.get(tag.author.id) ?? []), jumpUrl(channel.guild_id, channel.channel_id, tag.id)]);
    }
  }

  for (const [author, links] of byAuthor) {
    try {
      await sendDirectMessage(botToken, author, [text, ...links.map((link) => `↪ <${link}>`)].join("\n"));
    } catch (error) {
      errors.push(`a tag for someone else went unanswered: ${describe(error)}`);
    }
  }
}

type OwedMessage = OwedRow & {
  id: string;
  author_id: string | null;
  author_name: string | null;
  from_app: boolean;
};

/**
 * Pay what is owed: every tag of this account's that was answered where its
 * tagger may not have seen it (`answer_owed`), in ONE DM per person, and at
 * most one per person every `ANSWER_DM_EVERY_MS` — the rest wait for the next.
 *
 * It goes to whoever tagged. The owner hears it instead when the tagger cannot
 * be told — an integration's post, an unknown author, a DM Discord refuses —
 * so nothing owed ends silent. Only when the owner cannot be reached either is
 * a debt given up, and that is logged in `tt_alerts`. A rate limit gives up
 * nothing: the rows stay owed for the next pass.
 */
export async function sendOwedAnswers(
  db: SupabaseClient,
  errors: string[],
  input: { userId: string; botToken: string; ownerId: string | null; reminderChannelId: string | null },
): Promise<number> {
  const { userId, botToken, ownerId, reminderChannelId } = input;

  const { data, error } = await db
    .from("tt_messages")
    .select(
      "id, content, sent_at, channel_name, jump_url, author_id, author_name, from_app, is_task, skip_category, classification_reason, command_result, answer_owed",
    )
    .eq("user_id", userId)
    .not("answer_owed", "is", null)
    .is("answered_at", null)
    .not("classified_at", "is", null)
    .order("sent_at", { ascending: true })
    .limit(OWED_PER_PASS);
  if (error) {
    errors.push(`owed answers: ${error.message}`);
    return 0;
  }
  const owed = (data ?? []) as OwedMessage[];
  if (owed.length === 0) return 0;

  // The card each filed tag became, for its title.
  const filed = owed.filter((row) => row.is_task).map((row) => row.id);
  const titles = new Map<string, string>();
  if (filed.length > 0) {
    const { data: tasks } = await db.from("tt_tasks").select("message_id, title").in("message_id", filed);
    for (const task of (tasks ?? []) as Array<{ message_id: string; title: string }>) titles.set(task.message_id, task.title);
  }

  // Who hears it: the person who tagged, or the owner in their place.
  const groups = new Map<string, OwedMessage[]>();
  for (const row of owed) {
    const recipient = !row.from_app && row.author_id ? row.author_id : ownerId;
    if (!recipient) continue;
    groups.set(recipient, [...(groups.get(recipient) ?? []), row]);
  }

  const now = new Date();
  const since = new Date(now.getTime() - ANSWER_DM_EVERY_MS).toISOString();
  let sent = 0;

  for (const [recipient, rows] of groups) {
    // Spaced: one answering DM per person per window.
    const { data: recent } = await db
      .from("tt_messages")
      .select("id")
      .eq("user_id", userId)
      .eq("answered_to", recipient)
      .gte("answered_at", since)
      .limit(1);
    if ((recent ?? []).length > 0) continue;

    const receipts = rows.map((row) => receiptFor(row, titles.get(row.id) ?? null));
    const toOwner = recipient === ownerId;
    const text = receiptDigest(receipts, { link: siteUrl(), toOwner });
    if (!text) continue;

    const direct = await deliver(db, errors, { userId, botToken, recipient, text, owner: toOwner ? reminderChannelId : undefined });
    if (direct === "sent") {
      sent += 1;
      await settle(db, errors, rows, recipient);
      continue;
    }
    if (direct === "later") continue;

    // The tagger cannot be told: the owner is, in their place.
    if (!toOwner && ownerId) {
      const name = rows.find((row) => row.author_name)?.author_name ?? "someone";
      const onBehalf = receiptDigest(receipts, { link: siteUrl(), toOwner: true, onBehalfOf: name });
      const fallback = onBehalf
        ? await deliver(db, errors, { userId, botToken, recipient: ownerId, text: onBehalf, owner: reminderChannelId })
        : "failed";
      if (fallback === "sent") {
        sent += 1;
        await settle(db, errors, rows, ownerId);
        continue;
      }
      if (fallback === "later") continue;
    }

    // Nobody can be reached. Given up — and logged above — rather than
    // retried every minute for ever.
    await settle(db, errors, rows, null);
  }

  return sent;
}

/**
 * One DM. `owner` set (a channel id or null) means the recipient is the owner,
 * whose own reminder channel stands in when their DMs are closed.
 */
async function deliver(
  db: SupabaseClient,
  errors: string[],
  input: { userId: string; botToken: string; recipient: string; text: string; owner?: string | null },
): Promise<"sent" | "later" | "failed"> {
  let target: string | null = null;
  let failure: string | null = null;
  let later = false;
  try {
    target =
      input.owner === undefined
        ? await sendDirectMessage(input.botToken, input.recipient, input.text)
        : await sendReminder(input.botToken, input.recipient, input.text, input.owner);
  } catch (error) {
    failure = describe(error);
    later = error instanceof DiscordError && error.status === 429;
    errors.push(`answering DM: ${failure}`);
  }
  await db.from("tt_alerts").insert({
    user_id: input.userId,
    task_id: null,
    kind: RECEIPT_ALERT_KIND,
    target,
    ok: failure === null,
    error: failure,
  });
  return failure === null ? "sent" : later ? "later" : "failed";
}

/** Mark rows answered — to `recipient`, or given up on when null. */
async function settle(db: SupabaseClient, errors: string[], rows: Array<{ id: string }>, recipient: string | null) {
  const { error } = await db
    .from("tt_messages")
    .update({ answered_at: new Date().toISOString(), answered_to: recipient })
    .in(
      "id",
      rows.map((row) => row.id),
    );
  if (error) errors.push(`answered: ${error.message}`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
