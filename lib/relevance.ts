import type { DiscordMessage } from "@/lib/discord";

/**
 * Is this message any of this user's business, and what is it?
 *
 * A message is kept ONLY when it explicitly tags the user's own tracker bot.
 * Tagging the bot is how a person says "track this"; an instruction to a
 * colleague that does not tag it stays a conversation, however task-like it
 * reads. Lucky35's first round of feedback (2026-09-28) was that reading every
 * message he wrote filled the board with things he never meant as tasks.
 *
 * Three kinds are kept, and nothing else:
 *   sent      the user tagged the bot — work they handed out or took on
 *   received  someone else tagged the user's bot AND @-mentioned the user —
 *             work handed to them
 *   command   the user tagged the bot in a REPLY that names nobody else — an
 *             instruction about the task that reply points at. The worker hands
 *             it back to classification if the reply points at no task.
 *
 * "Tags" means markup in the text: `<@botId>`, or `<@&roleId>` for the role
 * Discord creates for the bot in each server. The @ picker offers that role
 * right beside the bot under the same name, and picking it was the commonest
 * way a task went silently unrecorded (Lucky35, 2026-09-29) — so it counts.
 * `mentions` is never read for this: Discord also lists the author of a
 * replied-to message there when the reply pings them, so replying to one of the
 * bot's own messages would otherwise read as tagging it.
 *
 * Everything else in a watched channel is deliberately dropped, unread. That is
 * a privacy position as much as a cost one: watching a channel must not mean
 * harvesting conversations the user is not part of.
 *
 * Someone else tagging the user's bot without naming the user is work handed
 * to a third person (or to themselves) through the owner's bot. Since Lucky35's
 * ruling of 2026-10-06 that is kept as `sent` when its author has signed in to
 * the tracker (`team`): a teammate handing out work through the team's bot.
 * It is filed on the owner's board as asked by them (`requesterOf`), and they
 * can see it. A stranger's is still the dropped-but-ANSWERED kind (`foreign`):
 * nothing of it is stored and no card is made, but a tag must never go
 * unanswered (Lucky35, 2026-09-30), so the poller puts 👀 on it and replies
 * with a fixed line saying whose tasks this bot tracks.
 *
 * Tags that arrive another way count the same (Lucky35, 2026-09-30, "tags
 * imported from another source were skipped silently"): a FORWARDED message is
 * read by what it forwards (`readableMessage`), and a message an integration
 * wrote — a bot or a webhook (`isApp`) — is read like anyone else's. Only the
 * tracker's own bot is never read: an answer must not answer itself.
 */
export type Direction = "sent" | "received" | "command" | "report";

/**
 * Who is reporting on work from this owner (Lucky35's PO, 2026-10-07): the
 * people with an open task on the owner's board, and the bot's own "which
 * task is this for?" lists still waiting for an answer.
 */
export type Reporting = {
  /** Discord ids with an open task given to them on this owner's board. */
  reporters?: ReadonlySet<string>;
  /** Ids of the bot's pick lists still waiting for a number. */
  picks?: ReadonlySet<string>;
};

export type Relevance = { keep: true; direction: Direction } | { keep: false; foreign?: true };

/** Discord message types worth reading: a normal message, or a reply. */
const READABLE_TYPES = new Set([0, 19]);

export function relevanceOf(
  raw: DiscordMessage,
  discordUserId: string,
  botUserId?: string | null,
  botRoleIds: readonly string[] = [],
  /** Discord ids of everyone signed in to the tracker (`tt_tracker_discord_ids`). */
  team: ReadonlySet<string> = new Set(),
  reporting: Reporting = {},
): Relevance {
  if (!READABLE_TYPES.has(raw.type)) return { keep: false };
  const message = readableMessage(raw);
  if (message.content.trim().length === 0) return { keep: false };

  // No bot, nothing can tag it, so nothing is anybody's task.
  if (!botUserId) return { keep: false };
  // The tracker's own words — a help line quotes `<@bot>` — are never a tag.
  if (message.author.id === botUserId) return { keep: false };

  // The number someone gives in answer to the bot's "which task is this
  // for?" — a reply to it, tagged or not: that list was a question to them.
  const answered = repliesTo(message);
  if (
    message.author.id !== discordUserId &&
    answered &&
    reporting.picks?.has(answered) &&
    reporting.reporters?.has(message.author.id)
  ) {
    return { keep: true, direction: "report" };
  }

  if (!tagsBot(message.content, botUserId, botRoleIds)) return { keep: false };

  if (message.author.id === discordUserId) {
    const namesSomeone = assigneesOf(message, discordUserId, botUserId).length > 0;
    return { keep: true, direction: repliesTo(message) && !namesSomeone ? "command" : "sent" };
  }

  // Someone with open work from this owner, tagging the bot: read first as a
  // report about that work — done with its proof, started, stop — and only if
  // it is none of those, as what it would otherwise be (`fallbackDirection`).
  if (reporting.reporters?.has(message.author.id) && !isApp(message)) return { keep: true, direction: "report" };

  if (mentionIdsFromContent(message.content).includes(discordUserId)) {
    return { keep: true, direction: "received" };
  }

  // A teammate handing out work through this bot: filed as asked by them.
  // Never a command — only the owner changes the owner's tasks by reply.
  if (team.has(message.author.id) && !isApp(message)) return { keep: true, direction: "sent" };

  // A stranger's work, tagged to this user's bot: answered, never stored.
  return { keep: false, foreign: true };
}

/**
 * Who asked for a task, when it was not the board's owner: the author of the
 * message that tagged their bot — asking the owner (received), or handing it
 * to someone through the owner's bot (sent). They can read the task
 * (`tasks I asked for readable`). Nothing when the owner wrote it.
 */
export function requesterOf(
  authorId: string | null | undefined,
  authorName: string | null | undefined,
  ownerDiscordId: string | null | undefined,
): { requested_by_discord_id: string | null; requested_by_name: string | null } {
  const id = (authorId ?? "").trim();
  if (id === "" || id === (ownerDiscordId ?? "").trim()) return { requested_by_discord_id: null, requested_by_name: null };
  return { requested_by_discord_id: id, requested_by_name: authorName?.trim() || null };
}

/**
 * The message as a person reads it. A forward's own text is empty — what was
 * forwarded, tag included, is in its snapshot — so a forward is read by the
 * snapshot's text and the people it named. Everything else is itself.
 */
export function readableMessage(message: DiscordMessage): DiscordMessage {
  if (message.content.trim() !== "" || message.message_reference?.type !== 1) return message;
  const forwarded = message.message_snapshots?.[0]?.message;
  if (!forwarded?.content) return message;
  return { ...message, content: forwarded.content, mentions: forwarded.mentions ?? [] };
}

/** The message this one REPLIES to, or null. A forward points at a message too, but answers nothing. */
export function repliesTo(message: DiscordMessage): string | null {
  const reference = message.message_reference;
  if (!reference?.message_id || (reference.type ?? 0) !== 0) return null;
  return reference.message_id;
}

/** Written by a bot or a webhook — an integration relaying work in — rather than a person. */
export function isApp(message: DiscordMessage): boolean {
  return Boolean(message.author.bot || message.webhook_id);
}

/**
 * True when the text tags this bot: its user markup, or the markup of one of
 * the roles Discord made for it (`botRoleIds`, one per server, learned by the
 * worker from each server's role list).
 */
export function tagsBot(
  content: string,
  botUserId: string | null | undefined,
  botRoleIds: readonly string[] = [],
): boolean {
  if (!botUserId) return false;
  if (mentionIdsFromContent(content).includes(botUserId)) return true;
  return roleIdsFromContent(content).some((id) => botRoleIds.includes(id));
}

/** The `<@&id>` role mentions in a message, de-duplicated, in order. */
export function roleIdsFromContent(content: string): string[] {
  return [...new Set(Array.from(content.matchAll(/<@&(\d+)>/g), (match) => match[1]))];
}

/**
 * The words of a message with every mention, role and channel markup taken out
 * — what a person reads, and the fallback title when nothing better exists.
 */
export function stripMentions(content: string): string {
  return content.replace(/<[@#][!&]?\d+>/g, " ").replace(/\s+/g, " ").trim();
}

export function authorName(message: DiscordMessage): string {
  return message.author.global_name ?? message.author.username;
}

/**
 * How long a gap still counts as "the same thought".
 *
 * People split one request across several lines on Discord constantly — a
 * mention, then the ask, then an afterthought, all inside a minute. Judged
 * individually the fragments look like banter; judged together they are one
 * clear request. Five minutes is generous enough to catch typing pauses and
 * tight enough that a later, unrelated message does not get swallowed.
 */
export const RUN_GAP_MS = 5 * 60_000;

export type Runnable = {
  id: string;
  sentAt: string;
  channelName: string | null;
  authorName: string | null;
  direction: string;
};

/**
 * Mark which messages continue the one before them: same channel, same author,
 * within RUN_GAP_MS. The classifier is told about this so it can read a run as
 * a single request rather than as a string of half-sentences.
 *
 * Expects `messages` in ascending time order, which is how the worker selects
 * them.
 */
export function markRuns<T extends Runnable>(messages: T[]): Array<T & { continues: boolean }> {
  return messages.map((message, i) => {
    const previous = messages[i - 1];
    if (!previous) return { ...message, continues: false };

    const sameThread =
      previous.channelName === message.channelName &&
      previous.authorName === message.authorName &&
      previous.direction === message.direction;

    const gap = new Date(message.sentAt).getTime() - new Date(previous.sentAt).getTime();

    return { ...message, continues: sameThread && gap >= 0 && gap <= RUN_GAP_MS };
  });
}

/**
 * One person named in a message: the Discord snowflake that identifies them, and
 * a human label for it.
 *
 * The label is a **username**, not a display name. The mention payload Discord
 * puts on a REST message is typed `{ id, username }` only (`lib/discord.ts:46`) —
 * there is no `global_name` on it and no `bot` flag, so a mentioned bot account
 * other than the tracker itself cannot be filtered out here. The upside is that a
 * username is more stable than the `global_name` that feeds `counterparty` via
 * `authorName` above, and the id is the real identity either way.
 */
export type Mentioned = { id: string; name: string };

/**
 * Who a message hands work to: everybody it @-mentions in its text, minus the
 * author themselves and minus the tracker bot.
 *
 * Self-exclusion is not cosmetic. People @-mention themselves constantly ("<@me>
 * remember to..."), and a self-mention becoming your own assignee would put your
 * own name on work you handed to nobody.
 *
 * Only mentions written into the text count. A reply that pings the author of
 * the message it answers lists them in `mentions` without anyone having typed
 * their name, and "@bot done" in reply to Alice's update does not hand Alice a
 * task.
 *
 * De-duplicated by id, in the order Discord returned them — that order is the
 * order the names appear in the message, which is the only ranking signal there
 * is when several people are named.
 *
 * Pure: no network, no database, no secrets.
 */
export function assigneesOf(
  message: DiscordMessage,
  selfDiscordUserId: string,
  botUserId?: string | null,
): Mentioned[] {
  const written = new Set(mentionIdsFromContent(message.content));
  const seen = new Set<string>();
  const out: Mentioned[] = [];

  for (const mention of message.mentions ?? []) {
    if (!written.has(mention.id)) continue;
    if (mention.id === selfDiscordUserId) continue;
    if (botUserId && mention.id === botUserId) continue;
    if (seen.has(mention.id)) continue;
    seen.add(mention.id);
    out.push({ id: mention.id, name: mention.username });
  }

  return out;
}

/**
 * Pull mention ids out of raw stored message text.
 *
 * Historical rows kept the markup Discord sent and nothing else, so this is the
 * only way back to who was named months ago. Three shapes share one silhouette
 * and only the first two are people:
 *
 *   <@123>   a user
 *   <@!123>  the same user, legacy nickname form
 *   <@&456>  a ROLE — never a person, must not match
 *   <#789>   a channel — never a person, must not match
 *
 * `!?` followed by `\d+` is what separates them: `&` and `#` are neither.
 *
 * De-duplicated, in the order they appear. Carries no username — the markup has
 * none — which is why a repaired historical row gets an id and a null name.
 */
export function mentionIdsFromContent(content: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const match of content.matchAll(/<@!?(\d+)>/g)) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

/**
 * What a tag kept as a `report` is, when it turns out to report nothing about
 * the sender's own work: work asked of the owner when it names them, work a
 * teammate hands out through the owner's bot, or — from anyone else — a
 * stranger's tag, answered and not stored (`relevanceOf`, the same rules).
 */
export function fallbackDirection(
  content: string,
  authorId: string,
  ownerDiscordId: string,
  team: ReadonlySet<string>,
): "received" | "sent" | "foreign" {
  if (mentionIdsFromContent(content).includes(ownerDiscordId)) return "received";
  if (team.has(authorId)) return "sent";
  return "foreign";
}

/**
 * Turn the model's free-text answer into one of the candidates it was shown, or
 * into nobody.
 *
 * The model's only job is disambiguation — it can never introduce a person. An
 * answer matching no candidate is discarded rather than trusted, which is the
 * same discipline `suggested_deadline` keeps: an unknown value is empty, never a
 * guess.
 *
 * The order below is deliberate:
 *   1. an exact id match — unambiguous, the model copied the snowflake;
 *   2. a case-insensitive name match — the model copied the label instead;
 *   3. exactly one candidate — one person named on a message the user wrote is
 *      not a guess, it is the only person named;
 *   4. otherwise nobody. Never "first of several".
 */
export function chooseAssignee(candidates: Mentioned[], modelAnswer: string): Mentioned | null {
  const answer = (modelAnswer ?? "").trim();

  if (answer.length > 0) {
    const byId = candidates.find((candidate) => candidate.id === answer);
    if (byId) return byId;

    const lowered = answer.toLowerCase();
    const byName = candidates.find((candidate) => candidate.name.toLowerCase() === lowered);
    if (byName) return byName;
  }

  if (candidates.length === 1) return candidates[0];

  return null;
}
