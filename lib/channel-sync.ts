/**
 * The bot's servers and channels, kept in step with Discord — the pure half,
 * so it is testable. `lib/channel-sync-server.ts` calls Discord and writes.
 *
 * 2026-10-06: Lucky35 tagged the bot in #cenri-john and nothing happened. The
 * channel sat in a server the bot joined after the last "Refresh from
 * Discord", so it was on no list and never read — eight tags there, and
 * nothing anywhere said so. Channels are now found by themselves: the worker
 * lists them every `CHANNEL_SYNC_EVERY_MS`, and a channel it has not seen is
 * watched from the moment it could first have been missed (`seedCursor`).
 *
 * Watched without asking because capture is "@bot": only a message that tags
 * the bot is ever stored, so reading one more channel files nothing unasked —
 * while NOT reading it silently drops every tag made there. The owner can
 * still switch any channel off in Settings, and a channel switched off stays
 * off: only channels never seen before are added.
 *
 * Imported by nothing in the browser today, but kept free of network,
 * database and clock all the same: `now` is passed in.
 */

import { dateToSnowflake } from "@/lib/snowflake";

/** How often the worker lists each account's servers and channels. */
export const CHANNEL_SYNC_EVERY_MS = 5 * 60_000;

/**
 * The furthest back a newly found channel is ever read. A look older than this
 * — a sync that kept failing, an account that never pressed Refresh — must not
 * pour an old channel's history in as fresh tags.
 */
export const MAX_LOOK_BACK_MS = 14 * 86_400_000;

/** Channel types read: plain text and announcement (`READABLE_CHANNEL_TYPES`). */
const READABLE = new Set([0, 5]);
const CATEGORY = 4;

/** Whether this account's channels are due to be listed again. */
export function syncDue(syncedAt: string | null, now: Date): boolean {
  if (!syncedAt) return true;
  const last = Date.parse(syncedAt);
  return !Number.isFinite(last) || now.getTime() - last >= CHANNEL_SYNC_EVERY_MS;
}

/**
 * The moment this account last looked at its whole channel list: the last full
 * sync, or — before the first — the newest channel row it has (when Refresh
 * last added one), never further back than `MAX_LOOK_BACK_MS`. Null when it
 * never listed a channel at all.
 */
export function lastLook(syncedAt: string | null, newestRowCreatedAt: string | null, now: Date): string | null {
  const look = syncedAt ?? newestRowCreatedAt;
  if (!look) return null;
  const floor = now.getTime() - MAX_LOOK_BACK_MS;
  return Date.parse(look) < floor ? new Date(floor).toISOString() : look;
}

/**
 * Where a newly found channel starts being read: from the later of its own
 * creation and the account's previous look. A channel made since then is read
 * whole, so the tags made before it was found are answered (late, by DM). One
 * that existed before — the bot was only now let in — starts at that look,
 * never pouring its whole history in. With no previous look at all (a first
 * listing), it starts now, like switching a channel on.
 *
 * A message's id sorts after its channel's, so the channel id itself is the
 * cursor that reads it from its first message.
 */
export function seedCursor(channelId: string, previousLook: string | null, now: Date): string {
  if (!previousLook) return dateToSnowflake(now);
  const look = BigInt(dateToSnowflake(new Date(previousLook)));
  const created = BigInt(channelId);
  return (created > look ? created : look).toString();
}

export type ListedServer = {
  guild: { id: string; name: string };
  channels: ReadonlyArray<{ id: string; name: string; type: number; parent_id?: string | null }>;
};

export type KnownChannel = {
  channel_id: string;
  channel_name: string | null;
  guild_name: string | null;
  parent_id: string | null;
  parent_name: string | null;
};

type ChannelFields = {
  user_id: string;
  guild_id: string;
  guild_name: string;
  channel_id: string;
  channel_name: string;
  parent_id: string | null;
  parent_name: string | null;
};

export type ChannelSyncPlan = {
  /** Channels never seen before: watched, read from `seedCursor`. */
  added: Array<ChannelFields & { watching: true; last_message_id: string }>;
  /** Channels known already whose name, server name or category changed. Nothing else on them is touched. */
  renamed: ChannelFields[];
  /** Servers with no channel on the list before — the bot's role there is learned up front. */
  newServers: string[];
};

/**
 * What one listing of the bot's servers changes. Only readable channels are
 * kept; a known channel keeps its watch switch, its cursor and its history,
 * and only its labels follow Discord.
 */
export function planChannelSync(
  userId: string,
  servers: readonly ListedServer[],
  known: readonly KnownChannel[],
  previousLook: string | null,
  now: Date,
): ChannelSyncPlan {
  const byId = new Map(known.map((row) => [row.channel_id, row]));
  const plan: ChannelSyncPlan = { added: [], renamed: [], newServers: [] };

  for (const { guild, channels } of servers) {
    const categories = new Map(channels.filter((c) => c.type === CATEGORY).map((c) => [c.id, c.name]));
    let hadAny = false;
    for (const channel of channels) {
      if (!READABLE.has(channel.type)) continue;
      const fields: ChannelFields = {
        user_id: userId,
        guild_id: guild.id,
        guild_name: guild.name,
        channel_id: channel.id,
        channel_name: channel.name,
        parent_id: channel.parent_id ?? null,
        parent_name: channel.parent_id ? (categories.get(channel.parent_id) ?? null) : null,
      };
      const row = byId.get(channel.id);
      if (!row) {
        plan.added.push({ ...fields, watching: true, last_message_id: seedCursor(channel.id, previousLook, now) });
        continue;
      }
      hadAny = true;
      if (
        row.channel_name !== fields.channel_name ||
        row.guild_name !== fields.guild_name ||
        row.parent_id !== fields.parent_id ||
        row.parent_name !== fields.parent_name
      ) {
        plan.renamed.push(fields);
      }
    }
    if (!hadAny && channels.some((c) => READABLE.has(c.type))) plan.newServers.push(guild.id);
  }
  return plan;
}
