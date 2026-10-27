/**
 * What happens to a message that tagged the bot — pure, so it is testable.
 *
 * Lucky35's second round of feedback (2026-09-29) found the two ways tagging
 * the bot went wrong: SILENCE (the tag never counted, and the sender believed
 * it had) and NOISE (every "thanks @bot" became a card somebody had to clear).
 * The answer to both is the same: every tagged message the tracker reads gets
 * a visible answer on the message itself, and only real work gets a card.
 *
 *   ✅  filed — it is on the board.
 *   👀  read, and deliberately not filed. It sits in the board's "Not filed"
 *       list, one click from becoming a task, so a wrong call costs a click
 *       rather than a missed deadline.
 *
 * No reaction at all therefore means the tracker never read it — the bot is
 * not in that channel, the channel is not watched, or the tag was not a tag —
 * and the sender can see that within a minute instead of after the deadline.
 *
 * Client-safe: imported by the board as well as the worker.
 */

import { colorForKey } from "@/lib/colors";
import { decideAutoDeadline, pickDeadlinePhrase, resolveSuggestedDeadline } from "@/lib/deadlines";
import { computeNextAlertAt } from "@/lib/reminders";
import { requesterOf, stripMentions } from "@/lib/relevance";
import type { SkipCategory, SkippedMessage, Task } from "@/lib/types/database";

export const FILED_REACTION = "✅";
export const SKIPPED_REACTION = "👀";

/** What the classifier may call a tagged message. Only "task" makes a card. */
export const TRIAGE_CATEGORIES = ["task", "thanks", "chatter", "question", "command"] as const;
export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

export function isSkip(category: TriageCategory): category is Exclude<TriageCategory, "task"> {
  return category !== "task";
}

/**
 * How the board names each kind of message it did not file. "duplicate" is
 * never the model's call: it is the worker noticing the same request is
 * already on the board (`requestKey`).
 */
export const SKIP_LABELS: Record<SkipCategory, string> = {
  thanks: "thanks",
  chatter: "chatter",
  question: "question for the bot",
  command: "command it could not apply",
  duplicate: "already on the board",
};

// ---------------------------------------------------------------------------
// The same request, tagged twice
// ---------------------------------------------------------------------------

/**
 * Below this many characters a request is too generic to call a repeat —
 * "fix it" twice is two tasks until a person says otherwise.
 */
export const MIN_REQUEST_KEY_LENGTH = 12;

/** How far back an open task counts as "already on the board" for a repeat. */
export const DUPLICATE_WINDOW_DAYS = 14;

/**
 * What a tagged message asks for, and of whom, reduced to compare with
 * another: the words with case and punctuation gone, plus every person and role
 * it @-mentions other than the bot itself (`botIds`: its user id and its
 * roles, so tagging the bot by name or by role is the same tag). Null when too
 * few words are left to tell one request from another.
 *
 * Lucky35, 2026-09-29: where the bot could not react, nobody saw a ✅, the
 * guide said that meant "never read", and people tagged again — so the board
 * filled with copies of work already on it. The same request tagged again while
 * the first is still open is recognised and answered ✅ rather than filed twice.
 *
 * The people are part of the key (2026-09-30): "@alice submit your timesheet"
 * and "@bob submit your timesheet" are the same words and two tasks, and
 * reading the second as a repeat left Bob with no card and no reminder while
 * the sender saw ✅. Two different asks that share words AND people are rare
 * enough, and "File it anyway" is one click on the Not filed list.
 */
export function requestKey(content: string, botIds: readonly string[] = []): string | null {
  const words = stripMentions(content)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (words.length < MIN_REQUEST_KEY_LENGTH) return null;

  const named = new Set<string>();
  for (const match of content.matchAll(/<@(!|&)?(\d+)>/g)) {
    if (botIds.includes(match[2])) continue;
    named.add(match[1] === "&" ? `&${match[2]}` : match[2]);
  }
  return named.size > 0 ? `${words} @ ${[...named].sort().join(" ")}` : words;
}

// ---------------------------------------------------------------------------
// Answering a tag where the person who tagged will see it
//
// A ✅ / 👀 is an answer only while the tagger is looking at the message:
// Discord tells nobody when a reaction lands on a message from an hour ago,
// let alone one from last spring. Lucky35, 2026-09-30 (twice): tags read late —
// added by an edit, forwarded in, found by Backfill — were answered where
// nobody would see it, the tagger heard nothing, tagged again, and the board
// got a copy. So such a tag is OWED an answer by DM (`tt_messages.answer_owed`)
// and the worker sends what is owed, per person, batched and spaced.
// ---------------------------------------------------------------------------

/**
 * A tag answered more than this long after it was written is answered by DM
 * too. Above the worker's normal lag — a large account's channels are read
 * every few minutes — so an ordinary tag is answered by its reaction alone.
 */
export const LATE_ANSWER_MS = 10 * 60_000;

/**
 * At most one answering DM per person in this long. What piles up meanwhile —
 * a Backfill of a busy year classifies sixty tags a minute — waits for the
 * next, so it arrives as two or three DMs rather than one per minute.
 */
export const ANSWER_DM_EVERY_MS = 10 * 60_000;

/** Why a tag is owed a DM: read late, or no reaction could be put on it. */
export type AnswerOwed = "late" | "unmarked";

/** 'late' when a tag written at `sentAt` is being answered too late for its reaction to be seen. */
export function lateAnswer(sentAt: string, now: Date): AnswerOwed | null {
  const at = Date.parse(sentAt);
  return Number.isFinite(at) && now.getTime() - at > LATE_ANSWER_MS ? "late" : null;
}

export type ReceiptKind = "filed" | "duplicate" | "skipped" | "command";

/** One tag, as its answering DM reports it. */
export type Receipt = {
  kind: ReceiptKind;
  /** The task's title, the words of a message not filed, or what a command did. */
  text: string;
  channelName: string | null;
  /** For a message not filed: why (a `SKIP_LABELS` value). */
  note: string | null;
  /** When it was written — shown as Discord's own "3 hours ago". */
  sentAt: string | null;
  /** The message itself, so the reader can see which tag is meant. */
  jumpUrl: string | null;
  owed: AnswerOwed;
};

/** The columns of a tagged `tt_messages` row its receipt is rebuilt from. */
export type OwedRow = {
  content: string;
  sent_at: string;
  channel_name: string | null;
  jump_url: string | null;
  is_task: boolean | null;
  skip_category: SkipCategory | null;
  classification_reason: string | null;
  command_result: string | null;
  answer_owed: AnswerOwed;
};

const DUPLICATE_REASON_PREFIX = "Already on the board: ";

/** The reason a repeat carries — `receiptFor` reads the title back out of it. */
export function duplicateReason(title: string): string {
  return `${DUPLICATE_REASON_PREFIX}${title}`.slice(0, 500);
}

/**
 * What the DM says about one owed tag, rebuilt from its row — the debt lives in
 * the database, so a run that dies before sending loses nothing. `taskTitle` is
 * the card it became, when it became one.
 */
export function receiptFor(row: OwedRow, taskTitle: string | null): Receipt {
  const base = { channelName: row.channel_name, sentAt: row.sent_at, jumpUrl: row.jump_url, owed: row.answer_owed };
  const words = stripMentions(row.content) || row.content;

  if (row.is_task) return { ...base, kind: "filed", text: taskTitle ?? words, note: null };
  if (row.skip_category === "duplicate") {
    const reason = row.classification_reason ?? "";
    const title = reason.startsWith(DUPLICATE_REASON_PREFIX) ? reason.slice(DUPLICATE_REASON_PREFIX.length) : words;
    return { ...base, kind: "duplicate", text: title, note: null };
  }
  if (row.skip_category) return { ...base, kind: "skipped", text: words, note: SKIP_LABELS[row.skip_category] };
  if (row.command_result) return { ...base, kind: "command", text: row.command_result, note: null };
  return { ...base, kind: "skipped", text: words, note: null };
}

/** Lines itemised in one digest before the rest are counted. */
export const RECEIPT_DIGEST_MAX_LINES = 15;

/** Discord's hard limit on one message. */
const DISCORD_MESSAGE_MAX = 2000;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function receiptLine(receipt: Receipt): string {
  const unix = receipt.sentAt ? Math.floor(Date.parse(receipt.sentAt) / 1000) : NaN;
  // Discord renders <t:…:R> as "3 hours ago" in the reader's own clock; the
  // link is in angle brackets so it does not unfurl under every line.
  const where = [
    `#${receipt.channelName ?? "unknown"}`,
    Number.isFinite(unix) ? `<t:${unix}:R>` : null,
    receipt.jumpUrl ? `<${receipt.jumpUrl}>` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const text = clip(receipt.text, 80);
  if (receipt.kind === "filed") return `${FILED_REACTION} Filed: **${text}** — ${where}`;
  if (receipt.kind === "duplicate") return `${FILED_REACTION} Already on the board: **${text}** — ${where}`;
  if (receipt.kind === "command") return `↪ ${text} — ${where}`;
  return `${SKIPPED_REACTION} Not filed (${receipt.note ?? "not a task"}): "${text}" — ${where}`;
}

function counted(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n} ${many}`;
}

/**
 * The one DM that answers every tag of one person's that is owed an answer —
 * read late, or left without a ✅ / 👀 — saying what became of each and that
 * none needs tagging again. The first lines itemised, the rest counted.
 *
 * `toOwner` is true when it goes to the account owner, who alone can re-invite
 * the bot; `onBehalfOf` names the tagger when the owner is told in their place
 * (the tagger could not be DMed — a webhook, or DMs closed). Null when there is
 * nothing to say.
 */
export function receiptDigest(
  receipts: Receipt[],
  options: { link: string | null; toOwner: boolean; onBehalfOf?: string | null },
): string | null {
  if (receipts.length === 0) return null;

  const n = receipts.length;
  const late = receipts.some((r) => r.owed === "late");
  const unmarked = receipts.some((r) => r.owed === "unmarked");

  const head = options.onBehalfOf
    ? `I couldn't DM ${options.onBehalfOf} about ${counted(n, "a tag", "tags")} of theirs, so here is what became of ${n === 1 ? "it" : "them"}:`
    : late && unmarked
      ? `Some of your tags I read late, and on some I couldn't put ✅ / 👀 — so you may not have seen my answer. Here is what I did with each:`
      : late
        ? `I read ${counted(n, "your tag", "of your tags")} a while after you wrote ${n === 1 ? "it" : "them"}, so you may not have seen my ✅ / 👀. Here is what I did:`
        : `I couldn't put ✅ / 👀 on ${counted(n, "your tag", "of your tags")}, so here is what I did with ${n === 1 ? "it" : "them"}:`;
  const foot =
    `None of ${n === 1 ? "it" : "these"} needs tagging again — ${n === 1 ? "it has" : "every one has"} been read.` +
    (unmarked && options.toOwner ? " Invite me again from Settings so I can react there." : "") +
    (options.link ? `\n<${options.link}>` : "");

  const lines = receipts.map(receiptLine);
  for (let shown = Math.min(lines.length, RECEIPT_DIGEST_MAX_LINES); shown >= 0; shown -= 1) {
    const rest = lines.length - shown;
    const more = rest > 0 ? [`…and ${rest} more, every one of them read.`] : [];
    const text = [head, ...lines.slice(0, shown), ...more, foot].join("\n");
    if (text.length <= DISCORD_MESSAGE_MAX) return text;
  }
  return clip(`${head}\n${foot}`, DISCORD_MESSAGE_MAX);
}

// ---------------------------------------------------------------------------
// Finding a row on "Not filed"
//
// The list holds every unreviewed row, however old, and a person looking for
// the one message the tracker misjudged must be able to reach it (Lucky35,
// 2026-09-30: past the newest hundred, rows were only a number). Two ways in:
// page back through all of them, or search all of them on the server.
// ---------------------------------------------------------------------------

/** Rows fetched per page of "Not filed". */
export const NOT_FILED_PAGE = 100;

/** The `tt_messages` columns a "Not filed" row carries — one list for every query that fetches them. */
export const NOT_FILED_COLUMNS =
  "id, content, jump_url, sent_at, channel_name, author_name, author_id, direction, mentions, classification_reason, skip_category, via_dm";

/**
 * Where a message was read, for a person: "#design", or "a DM to your bot" —
 * a DM has no channel name, and "#unknown" read like a fault.
 */
export function placeOf(message: { channel_name: string | null; via_dm?: boolean | null }): string {
  return message.via_dm ? "a DM to your bot" : `#${message.channel_name ?? "unknown"}`;
}

/**
 * A search box's words as an `ilike` pattern matching them anywhere, with the
 * characters `ilike` treats as wildcards taken literally. Null below two
 * characters, where every row matches and the search only costs a request.
 *
 * `*` is the exception: PostgREST rewrites it to `%` in a like pattern before
 * Postgres sees it, and no escape survives that, so a literal `*` would match
 * any run of text. It becomes `_` — exactly one character, which includes the
 * `*` itself.
 */
export function likeContains(query: string): string | null {
  const words = query.trim();
  if (words.length < 2) return null;
  return `%${words.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, "_")}%`;
}

/** A PostgREST filter value, double-quoted so `:`, `.` and `,` inside it are data. */
function quoted(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * The `or` filter for the page after `last`, in the list's order (newest
 * first, then id): strictly older, or the same instant and a lower id. Keyed on
 * the row, not an offset, because rows leave the list as people review them —
 * an offset would then skip whatever slid up into the gap.
 */
export function olderThanFilter(last: { sent_at: string; id: string }): string {
  const at = quoted(last.sent_at);
  return `sent_at.lt.${at},and(sent_at.eq.${at},id.lt.${quoted(last.id)})`;
}

/**
 * The reply posted in the channel, or null for none.
 *
 * Fixed text, never the model's words: this is posted publicly in somebody's
 * server. Thanks and chatter get no reply — a 👀 is answer enough, and a bot
 * that answers every "thanks" is its own kind of noise.
 */
export function skipReply(category: SkipCategory, botUserId: string): string | null {
  const bot = `<@${botUserId}>`;
  if (category === "question") {
    return (
      `I track tasks. Tag me with who it is for and when — ` +
      `\`${bot} @name redo the thumbnail, deadline is 24 hours\` — and it goes on the board. ` +
      `${FILED_REACTION} means filed, ${SKIPPED_REACTION} means I read it and did not file it.`
    );
  }
  if (category === "command") {
    return (
      `I could not apply that, so nothing was filed. To change a task, reply to the message that ` +
      `created it and tag me with \`done\`, \`dismiss\`, \`deadline friday 5pm\` or \`remind me daily\`.`
    );
  }
  // Thanks and chatter: the 👀 is the answer. A duplicate's answer is ✅.
  return null;
}

/**
 * The reply to someone else tagging this bot about work for a third person
 * (`relevanceOf`'s `foreign`). Nothing of their message is stored and no card
 * is made — this bot tracks one person's tasks — but the tag is answered, with
 * 👀 and this, so nobody waits on a card that will never exist (Lucky35,
 * 2026-09-30). Names the owner as text, never as a mention: it must not ping.
 */
export function foreignTagReply(ownerName: string | null, site: string | null = null): string {
  const owner = ownerName ? `**${ownerName}**` : "the person who set me up";
  return (
    `I only take tasks from ${owner}'s team, so I did not file this — nothing of it was saved. ` +
    `To give work through me, sign in to the tracker once${site ? ` (<${site}>)` : ""} and tag me again; ` +
    `to ask ${ownerName ?? "them"} for something, tag me and @-mention them in the same message.`
  );
}

// ---------------------------------------------------------------------------
// A message Claude cannot read
// ---------------------------------------------------------------------------

/**
 * How many unusable answers a message may get before it is filed from its own
 * words (`taskFromMessage`) instead. The failed batch it was in counts as the
 * first; after that it is tried alone, so it is filed after two tries of its
 * own — a couple of minutes — rather than holding every later tag without an
 * answer.
 */
export const MAX_CLASSIFY_ATTEMPTS = 3;

/** The note a card filed that way carries, so the person knows why it reads rough. */
export const UNREAD_FILED_NOTE = "Filed from the message's own words — Claude could not read it.";

// ---------------------------------------------------------------------------
// "Make it a task" — turning a skipped message into a card by hand
// ---------------------------------------------------------------------------

export type ManualFileContext = {
  /** The account filing it: `tt_tasks.user_id`. */
  userId: string;
  /** `tt_profiles.timezone` — the message's own words are read in it. */
  timezone: string;
  now: Date;
  /** The owner's Discord id: a message someone else wrote was asked by them (`requesterOf`). */
  ownerDiscordId?: string | null;
};

/**
 * The row a skipped message becomes when a person overrules the tracker.
 *
 * It is built the way the worker would have built it: the title is the
 * message's own words, the assignee is the one person it named (never a guess
 * between several), and a deadline stated in plain words is read and set with
 * its cadence and derived `next_alert_at` — so the card is live the moment it
 * is filed, exactly like one the worker filed. This is the FIRST card's draft:
 * `cardsForEveryone` (`lib/tagged.ts`) turns it into one card for each person
 * the message tagged, as the worker does (Lucky35's PO, 2026-10-05).
 */
export function taskFromMessage(message: SkippedMessage, ctx: ManualFileContext): Partial<Task> & { user_id: string } {
  const words = stripMentions(message.content);
  const phrase = pickDeadlinePhrase("", message.content, {
    sentAt: message.sent_at,
    timezone: ctx.timezone,
    now: ctx.now,
  });
  const decision = decideAutoDeadline({
    suggested: phrase,
    sentAt: message.sent_at,
    timezone: ctx.timezone,
    now: ctx.now,
  });

  const received = message.direction === "received";
  const only = !received && message.mentions.length === 1 ? message.mentions[0] : null;

  return {
    user_id: ctx.userId,
    message_id: message.id,
    title: (words || "Untitled task").slice(0, 80),
    source_excerpt: message.content.slice(0, 500),
    source_url: message.jump_url,
    // Kept even when it is not applied (in the past, say), so the detail's
    // "Use <date>" offers what the message said — as the worker does.
    suggested_deadline: phrase
      ? resolveSuggestedDeadline(phrase, { sentAt: message.sent_at, timezone: ctx.timezone, now: ctx.now })
      : null,
    color: colorForKey(message.id),
    direction: received ? "received" : "given",
    counterparty: received ? message.author_name : null,
    // Someone else wrote it — asking the owner, or handing it out through the
    // owner's bot: they asked for it, and can see it.
    ...requesterOf(message.author_id, message.author_name, ctx.ownerDiscordId),
    assignee_discord_id: only?.id ?? null,
    assignee_name: only?.name ?? null,
    // A message in a channel @-mentioned its assignee, so they saw it; one sent
    // to the bot by DM was seen by nobody else, so they are told by DM.
    assignee_told_at: only && !message.via_dm ? ctx.now.toISOString() : null,
    ...(decision.write
      ? {
          deadline: decision.deadline,
          deadline_source: "auto" as const,
          alert_every_minutes: decision.alertEveryMinutes,
          next_alert_at:
            computeNextAlertAt({
              now: ctx.now,
              status: "open",
              deadline: decision.deadline,
              alertEveryMinutes: decision.alertEveryMinutes,
              lastAlertAt: null,
            })?.toISOString() ?? null,
        }
      : {}),
  };
}
