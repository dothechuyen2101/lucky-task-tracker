/**
 * Discord, over REST only.
 *
 * There is no gateway here and there cannot be: this app runs on Vercel, where
 * nothing holds a websocket open between requests. So instead of subscribing to
 * MESSAGE_CREATE, the worker polls `GET /channels/{id}/messages?after=<cursor>`
 * once a minute per watched channel. The cursor is a Discord snowflake, which
 * encodes its own timestamp, so "everything since last time" is a single
 * parameter and no state is duplicated.
 *
 * What that costs, stated plainly:
 *   - Up to a minute of latency between a message and it appearing. For a task
 *     tracker whose fastest reminder is 15 minutes, that is free.
 *   - A message is recorded as it read when first stored. An edit that ADDS a
 *     tag is seen while the message is among the channel's newest page
 *     (`getNewestMessages`); further back, Backfill finds it. Deletes are not
 *     seen.
 *   - Only channels the bot is a member of and can read. A bot can never read
 *     a DM between two humans, on any architecture — that is a Discord rule,
 *     not a limitation of this design. It can read a DM sent to the BOT, and
 *     does (`pollDms`), for the people it already knows.
 *
 * Every call takes the caller's own bot token. There is no shared bot.
 */

import { dateToSnowflake, jumpUrl, snowflakeToDate } from "@/lib/snowflake";

export { dateToSnowflake, jumpUrl, snowflakeToDate };

const API = "https://discord.com/api/v10";

export type DiscordGuild = { id: string; name: string };

export type DiscordChannel = {
  id: string;
  name: string;
  type: number;
  guild_id?: string;
  parent_id?: string | null;
};

export type DiscordMessage = {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  /** Set once the message has been edited — how a tag added afterwards is noticed. */
  edited_timestamp?: string | null;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  /** Set when a webhook — an integration relaying work in — wrote it. */
  webhook_id?: string;
  /** Users @-mentioned in the message. How work gets assigned on Discord. */
  mentions?: Array<{ id: string; username: string }>;
  /**
   * Present on a reply (type 19), whose `message_id` is what it replies to —
   * and on a FORWARD, `type` 1, whose `message_id` is the message forwarded.
   */
  message_reference?: { type?: number; message_id?: string; channel_id?: string; guild_id?: string };
  /**
   * A forwarded message: its own `content` is empty and what was forwarded
   * lives here — including any tag of the bot it carried.
   */
  message_snapshots?: Array<{ message?: { content?: string; mentions?: Array<{ id: string; username: string }> } }>;
  /** The files on the message — the proof a report of done carries (`20261007_01`). */
  attachments?: Array<{ id: string; filename: string; url: string; content_type?: string; size?: number }>;
  type: number;
};

/**
 * Discord's attachment URLs are signed and expire within a day. A link stored
 * with a proof is refreshed, with the owner's own bot, when someone opens it.
 * Null when Discord would not refresh it — the caller falls back to the
 * message's own link.
 */
export async function refreshAttachmentUrl(token: string, url: string): Promise<string | null> {
  const answer = await call<{ refreshed_urls?: Array<{ original: string; refreshed: string }> }>(token, "/attachments/refresh-urls", {
    method: "POST",
    body: JSON.stringify({ attachment_urls: [url] }),
  });
  return answer.refreshed_urls?.[0]?.refreshed ?? null;
}

export type DiscordUser = { id: string; username: string; global_name?: string | null };

export type DiscordUserGuild = {
  id: string;
  name: string;
  icon: string | null;
  owner?: boolean;
  /** The signed-in user's permission bitfield in this guild, as a string. */
  permissions?: string;
};

/** Channel types we can poll: plain text, and announcement channels. */
export const READABLE_CHANNEL_TYPES = [0, 5];

export class DiscordError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "DiscordError";
  }

  /** A 403/404 means the bot lost access — worth surfacing, not worth retrying. */
  get isAccess(): boolean {
    return this.status === 403 || this.status === 404;
  }
}

async function call<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "TaskTracker (https://github.com/Ro8ch/task-tracker, 0.1.0)",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (response.status === 429) {
    // Discord answers a rate limit with seconds; we hand back milliseconds so
    // the caller can decide to wait or to give the slot back to the next tick.
    const body = (await response.json().catch(() => ({}))) as { retry_after?: number };
    throw new DiscordError("Rate limited by Discord.", 429, Math.ceil((body.retry_after ?? 1) * 1000));
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new DiscordError(
      `Discord ${response.status} on ${path}${text ? `: ${text.slice(0, 300)}` : ""}`,
      response.status,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * The servers a USER belongs to, using their own OAuth token from sign-in
 * rather than a bot token. Needs the `guilds` scope.
 *
 * `permissions` is that user's permission bitfield in each guild. Bit 5
 * (0x20, MANAGE_GUILD) is the one that decides whether they may add a bot at
 * all — without it Discord refuses the invite, so the UI uses this to avoid
 * offering a button that cannot work.
 */
export async function getUserGuilds(userToken: string): Promise<DiscordUserGuild[]> {
  const response = await fetch(`${API}/users/@me/guilds?limit=200`, {
    headers: {
      Authorization: `Bearer ${userToken}`,
      "User-Agent": "TaskTracker (https://github.com/Ro8ch/task-tracker, 0.1.0)",
    },
    cache: "no-store",
  });

  if (response.status === 429) {
    const retry = (await response.json().catch(() => ({}))) as { retry_after?: number };
    throw new DiscordError("Rate limited by Discord.", 429, Math.ceil((retry.retry_after ?? 1) * 1000));
  }

  if (!response.ok) {
    throw new DiscordError(
      response.status === 401
        ? "Your Discord sign-in has expired. Sign out and back in to refresh the server list."
        : `Discord ${response.status} listing your servers.`,
      response.status,
    );
  }

  return (await response.json()) as DiscordUserGuild[];
}

const MANAGE_GUILD = 0x20n;

export function canInviteBot(permissions: string | undefined): boolean {
  if (!permissions) return false;
  try {
    return (BigInt(permissions) & MANAGE_GUILD) === MANAGE_GUILD;
  } catch {
    return false;
  }
}

/** Who is this token? Also the validity check when a user pastes one in. */
export function getBotUser(token: string): Promise<DiscordUser> {
  return call<DiscordUser>(token, "/users/@me");
}

export function getBotGuilds(token: string): Promise<DiscordGuild[]> {
  return call<DiscordGuild[]>(token, "/users/@me/guilds?limit=200");
}

export function getGuildChannels(token: string, guildId: string): Promise<DiscordChannel[]> {
  return call<DiscordChannel[]>(token, `/guilds/${guildId}/channels`);
}

/** A channel category's type. Channels sit in one through their `parent_id`. */
export const CATEGORY_CHANNEL_TYPE = 4;

/**
 * Make a channel category in a server — "Active projects" or "Done projects".
 * Needs Manage Channels, which only the project-channels invite asks for
 * (`PROJECT_BOT_PERMISSIONS`). The reason lands in the server's audit log.
 */
export function createCategory(token: string, guildId: string, name: string): Promise<DiscordChannel> {
  return call<DiscordChannel>(token, `/guilds/${guildId}/channels`, {
    method: "POST",
    // Discord reads this header URL-encoded.
    headers: { "X-Audit-Log-Reason": encodeURIComponent("Task Tracker: project channel categories") },
    body: JSON.stringify({ name, type: CATEGORY_CHANNEL_TYPE }),
  });
}

/**
 * Put a channel in a category. Only `parent_id` is sent: the channel keeps
 * its own permission overwrites, so a private project channel stays private
 * wherever it moves. Needs Manage Channels.
 */
export function moveChannel(token: string, channelId: string, parentId: string, reason: string): Promise<DiscordChannel> {
  return call<DiscordChannel>(token, `/channels/${channelId}`, {
    method: "PATCH",
    headers: { "X-Audit-Log-Reason": encodeURIComponent(reason) },
    body: JSON.stringify({ parent_id: parentId }),
  });
}

export type DiscordRole = { id: string; name: string; managed?: boolean; tags?: { bot_id?: string } };

/**
 * The role Discord created for this bot in a server, or null.
 *
 * Every bot gets one "managed" role per server, named like the bot, and the @
 * picker offers it right beside the bot itself — so `<@&thatRole>` is how a
 * good share of real tags arrive. Its `tags.bot_id` is what ties it to the bot.
 * Any member may list a server's roles; no permission beyond being in it.
 */
export async function getBotRoleId(token: string, guildId: string, botUserId: string): Promise<string | null> {
  const roles = await call<DiscordRole[]>(token, `/guilds/${guildId}/roles`);
  return roles.find((role) => role.tags?.bot_id === botUserId)?.id ?? null;
}

/**
 * React to a message as the bot — the tracker's answer to being tagged: ✅
 * filed, 👀 read and not filed. Needs Add Reactions in that channel, which
 * the invite link now asks for; callers treat a refusal as non-fatal.
 */
export function addReaction(token: string, channelId: string, messageId: string, emoji: string): Promise<unknown> {
  return call(token, `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, {
    method: "PUT",
  });
}

/**
 * One page of messages after `afterId`, oldest first.
 *
 * Discord returns newest-first and its `after` window semantics are worth not
 * relying on, so the caller sorts ascending and advances its cursor to the
 * highest id it saw. Under either reading of the API that terminates and makes
 * forward progress.
 */
export async function getMessagesAfter(
  token: string,
  channelId: string,
  afterId: string,
  limit = 100,
): Promise<DiscordMessage[]> {
  const messages = await call<DiscordMessage[]>(
    token,
    `/channels/${channelId}/messages?limit=${limit}&after=${afterId}`,
  );
  return [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

/**
 * The newest page of a channel, oldest first. The poller reads this first: it
 * holds every new message when there are fewer than a page of them, AND the
 * recent ones that were edited since — the only way a tag added to a message
 * afterwards is ever seen (`pollChannel`).
 */
export async function getNewestMessages(token: string, channelId: string, limit = 100): Promise<DiscordMessage[]> {
  const messages = await call<DiscordMessage[]>(token, `/channels/${channelId}/messages?limit=${limit}`);
  return [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

/**
 * One page of messages BEFORE `beforeId`, oldest first.
 *
 * The mirror of getMessagesAfter, used by backfill to walk backwards through
 * a channel's history. Discord's `before` window is unambiguous in a way
 * `after` is not, but the caller still advances its cursor to the LOWEST id
 * it saw, so a page that comes back in any order still makes progress.
 */
export async function getMessagesBefore(
  token: string,
  channelId: string,
  beforeId: string,
  limit = 100,
): Promise<DiscordMessage[]> {
  const messages = await call<DiscordMessage[]>(
    token,
    `/channels/${channelId}/messages?limit=${limit}&before=${beforeId}`,
  );
  return [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

/**
 * Open (or reuse) the bot's DM channel with a user. Sends nothing: it only
 * hands back the channel's id — which is also how the worker finds a DM to
 * READ (`pollDms`): without a live connection a bot cannot discover a DM
 * someone else opened, but it can open one with anyone it knows and read it.
 */
export async function openDmChannel(token: string, recipientId: string): Promise<string> {
  const channel = await call<{ id: string }>(token, "/users/@me/channels", {
    method: "POST",
    body: JSON.stringify({ recipient_id: recipientId }),
  });
  return channel.id;
}

/** One member of a server, as `searchGuildMembers` returns them. */
export type DiscordMember = {
  nick?: string | null;
  user: { id: string; username: string; global_name?: string | null; bot?: boolean };
};

/**
 * Members of a server whose username or nickname starts with `query`. How a
 * name typed in a DM ("@minh" — the @ list offers nobody there) is matched to
 * a person. Unlike listing every member, this needs no privileged intent.
 */
export function searchGuildMembers(token: string, guildId: string, query: string, limit = 5): Promise<DiscordMember[]> {
  return call<DiscordMember[]>(
    token,
    `/guilds/${guildId}/members/search?query=${encodeURIComponent(query)}&limit=${limit}`,
  );
}

/**
 * Every member of a server, a page of up to 1000 at a time from `after` (a
 * user id; "0" from the start). Needs the Server Members Intent switched on
 * for the bot in the Developer Portal — without it Discord answers 403, and
 * the caller falls back to `searchGuildMembers`.
 */
export function listGuildMembers(token: string, guildId: string, after = "0", limit = 1000): Promise<DiscordMember[]> {
  return call<DiscordMember[]>(token, `/guilds/${guildId}/members?limit=${limit}&after=${after}`);
}

export function postMessage(token: string, channelId: string, content: string): Promise<{ id: string }> {
  return call(token, `/channels/${channelId}/messages`, {
    method: "POST",
    // No allowed_mentions: a reminder addressed to you should ping you. It
    // still cannot ping @everyone, because the bot is never given that
    // permission by the invite link in the README.
    body: JSON.stringify({ content }),
  });
}

/**
 * Answer one message in its own channel, as a reply to it, pinging nobody —
 * not whoever tagged, not anyone named in the text. Every public answer the
 * tracker gives (to a question, a command, a tag meant for someone else) goes
 * through here: it is posted in somebody's server, so it must never ping a
 * room. A message deleted since it was read does not fail the post.
 */
export function replyTo(token: string, channelId: string, messageId: string, content: string): Promise<{ id: string }> {
  return call(token, `/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content,
      message_reference: { message_id: messageId, fail_if_not_exists: false },
      allowed_mentions: { parse: [], replied_user: false },
    }),
  });
}

/**
 * Send a reminder. DM by default; a channel id overrides that, which is the
 * fallback for a user whose privacy settings refuse bot DMs (Discord answers
 * that with a 403 on the DM open, not on the send).
 */
export async function sendReminder(
  token: string,
  recipientId: string,
  content: string,
  channelOverride: string | null,
): Promise<string> {
  return (await sendReminderMessage(token, recipientId, content, channelOverride)).channelId;
}

/** `sendReminder`, saying which message it posted — so a reply to it can be matched to its task. */
export async function sendReminderMessage(
  token: string,
  recipientId: string,
  content: string,
  channelOverride: string | null,
): Promise<{ channelId: string; messageId: string }> {
  const channelId = channelOverride ?? (await openDmChannel(token, recipientId));
  const posted = await postMessage(token, channelId, content);
  return { channelId, messageId: posted.id };
}

/**
 * Send a hand-typed note to one person as a Discord DM.
 *
 * DM ONLY — there is deliberately no channel argument. `sendReminder` above has
 * one (`channelOverride`) and that is a foot-gun here: it is the *caller's own*
 * reminder channel, so passing it would post a message meant for one person
 * into another person's channel. This function has no such escape hatch, and it
 * must not grow one.
 *
 * No `allowed_mentions` is set, matching `postMessage`. That is safe **because
 * this is a DM**: the target is a one-to-one channel, and the bot's invite
 * permissions (`BOT_PERMISSIONS` in `lib/discord-links.ts`) withhold Mention
 * Everyone. If anyone ever adds a channel target to this
 * path, that reasoning stops holding and `allowed_mentions` becomes MANDATORY.
 *
 * Two steps, both through the private `call()` helper so the bot-token
 * Authorization prefix and the 429 -> `DiscordError.retryAfterMs` decode are
 * inherited, never re-implemented: open (or reuse) the DM channel, then post
 * into it.
 *
 * What comes back IS read now — but only by the worker, only in the DMs of
 * people the owner works with (`pollDms`), and only as answers to the bot.
 *
 * @returns the DM channel id the message was posted to.
 */
export async function sendDirectMessage(
  token: string,
  recipientId: string,
  content: string,
): Promise<string> {
  return (await sendDm(token, recipientId, content)).channelId;
}

/** `sendDirectMessage`, saying which message it posted — so a reply to it can be matched to its task. */
export async function sendDm(
  token: string,
  recipientId: string,
  content: string,
): Promise<{ channelId: string; messageId: string }> {
  const channelId = await openDmChannel(token, recipientId);
  const posted = await postMessage(token, channelId, content);
  return { channelId, messageId: posted.id };
}
