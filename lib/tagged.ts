/**
 * Everyone a message tags gets the task — pure, so it is testable.
 *
 * Lucky35's PO, 2026-10-05: a message that tagged Cenri and Rea filed a card
 * with nobody on it. A card holds one person, and with two named the
 * classifier refused to guess (`chooseAssignee`). Now each person tagged gets
 * their own card — the same words, the same deadline — so each has their own
 * reminders, their own "done", their own review and their own score, and a
 * late finish costs the person who was late.
 *
 * Every card a message files carries `source_message_id` and its place among
 * them, `message_part`; only the first keeps `message_id`, which the
 * one-card-per-message index — and every reader written before this — keys on
 * (`20261005_01_everyone_tagged.sql`). Imported by client components: nothing
 * here reaches the network, the database or the clock.
 */

import { FRESH_ASSIGNEE_STREAM, nextAlertFor } from "./reminders";
import type { Task } from "./types/database";

/** A person a message @-mentioned, as `tt_messages.mentions` stores them. */
export type TaggedPerson = { id: string; name: string | null };

/**
 * Someone a message only copied in (`tt_tasks.cc`): no card, no reminders,
 * named on the task. A name typed as words in a DM has no id.
 */
export type CcPerson = { id: string | null; name: string | null };

// ---------------------------------------------------------------------------
// "cc @umer" — tagged to be told, not to do it (Cenri, 2026-10-20)
// ---------------------------------------------------------------------------
//
// Everyone a message tags gets a card (below). But people tag others only to
// keep them in the loop — "@jfabbs … share it here with @umer" made umer a
// card, reminders and a "done" that was never his. A person tagged ONLY after
// "cc", "cc:", "/cc" or "fyi" is copied in: no card, named on the task as CC.
// Anyone tagged anywhere else in the message is still a doer — "cc" never
// takes a person off work the message also gives them. The words decide, not
// a model's reading of them: the PO asked for no guessing here.

/** A mention, as markup or (in a DM) as a typed handle. Same handle shape as `plainHandles`. */
const MENTION = String.raw`(?:<@!?\d+>|@[\p{L}\p{N}][\p{L}\p{N}._-]{0,31})`;
/** Between two mentions of one cc list: a comma, "&", "+", "and" / "và", or plain spaces — never a new line. */
const JOIN = String.raw`(?:[ \t]*(?:,|&|\+|\band\b|và)[ \t]*|[ \t]+)`;
/** "cc @a @b", "cc: @a, @b and @c", "/cc @a", "FYI @a" — the cue, then a run of mentions. */
const CC_CLAUSE = new RegExp(String.raw`(?<![\p{L}\p{N}_])\/?(?:cc|fyi)(?![\p{L}\p{N}_'’])[ \t]*[:\-–—]?[ \t]*(${MENTION}(?:${JOIN}${MENTION})*)`, "giu");

/** Where each cc list sits in the text, `[start, end)`. */
function ccSpans(content: string): Array<[number, number]> {
  return [...content.matchAll(CC_CLAUSE)].map((match) => [match.index ?? 0, (match.index ?? 0) + match[0].length]);
}

/** The text with every cc list taken out — what the message asks of people. */
export function withoutCc(content: string | null | undefined): string {
  const text = content ?? "";
  let out = "";
  let at = 0;
  for (const [start, end] of ccSpans(text)) {
    out += text.slice(at, start) + " ";
    at = end;
  }
  return out + text.slice(at);
}

/** Everyone a cc list names: ids from markup, and handles typed as words (lower-cased), in order. */
export function ccMentions(content: string | null | undefined): { ids: string[]; handles: string[] } {
  const ids: string[] = [];
  const handles: string[] = [];
  for (const match of (content ?? "").matchAll(CC_CLAUSE)) {
    for (const mention of match[1].matchAll(new RegExp(MENTION, "gu"))) {
      const markup = /^<@!?(\d+)>$/.exec(mention[0]);
      if (markup) {
        if (!ids.includes(markup[1])) ids.push(markup[1]);
        continue;
      }
      const handle = mention[0].slice(1).replace(/[._-]+$/, "").toLowerCase();
      if (!handles.includes(handle)) handles.push(handle);
    }
  }
  return { ids, handles };
}

/**
 * Who a message gives the work to, and who it only copies in. A person is
 * CC when every mention of them is inside a cc list; otherwise they get a
 * card. Order is kept.
 */
export function splitCc<P extends { id: string }>(
  people: readonly P[] | null | undefined,
  content: string | null | undefined,
): { doers: P[]; cc: P[] } {
  const listed = new Set(ccMentions(content).ids);
  const rest = withoutCc(content);
  const doers: P[] = [];
  const cc: P[] = [];
  for (const person of people ?? []) {
    const elsewhere = new RegExp(String.raw`<@!?${person.id}>`).test(rest);
    (listed.has(person.id) && !elsewhere ? cc : doers).push(person);
  }
  return { doers, cc };
}

/**
 * Who gets a card: everyone tagged, once each, in the order they were named —
 * or one card for nobody when nobody was. Never the owner (a self-mention is
 * not handing work out) and never the bot; ingest already leaves both out, and
 * this does not lean on it.
 */
export function peopleOnCards(
  people: readonly TaggedPerson[] | null | undefined,
  exclude: ReadonlyArray<string | null | undefined> = [],
): Array<TaggedPerson | null> {
  const skip = new Set(exclude.filter((id): id is string => Boolean(id)));
  const seen = new Set<string>();
  const out: TaggedPerson[] = [];
  for (const person of people ?? []) {
    const id = (person?.id ?? "").trim();
    if (id === "" || skip.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: person.name?.trim() || null });
  }
  return out.length > 0 ? out : [null];
}

/**
 * The fields that make a card one person's, and one of its message's: who it
 * is on, a fresh reminder stream for them, and where it sits among the cards
 * the message filed. Told already when a channel message @-mentioned them; a
 * DM to the bot was seen by nobody else, so the worker DMs them
 * (`tellAssignees`).
 */
export function cardFields(
  person: TaggedPerson | null,
  part: number,
  source: {
    messageId: string | null;
    viaDm: boolean;
    people: readonly TaggedPerson[];
    toldAt: string;
    /** Who the message only copied in (`splitCc`): named on every card, on none of them. */
    cc?: readonly CcPerson[];
  },
): Partial<Task> {
  return {
    ...FRESH_ASSIGNEE_STREAM,
    assignee_discord_id: person?.id ?? null,
    assignee_name: person?.name ?? null,
    assignee_told_at: person && !source.viaDm ? source.toldAt : null,
    message_id: part === 0 ? source.messageId : null,
    source_message_id: source.messageId,
    message_part: part,
    source_mentions: source.people.map((p) => ({ id: p.id, name: p.name })),
    cc: (source.cc ?? []).map((p) => ({ id: p.id, name: p.name })),
  };
}

/**
 * One row per person a message tagged, from the draft its first card would
 * be — each scheduled from the row as it will stand (`nextAlertFor`), never
 * typed, because the second person's reminders are not the first's.
 */
export function cardsForEveryone<T extends Partial<Task>>(
  draft: T,
  people: readonly TaggedPerson[] | null | undefined,
  context: {
    messageId: string | null;
    viaDm: boolean;
    now: Date;
    ownerDiscordId: string | null;
    /** The message's words: anyone tagged only in a "cc" list gets no card (`splitCc`). */
    content?: string | null;
  },
): Array<T & Partial<Task>> {
  const { doers, cc } = splitCc(people, context.content);
  const onCards = peopleOnCards(doers, [context.ownerDiscordId]);
  const named = onCards.filter((p): p is TaggedPerson => p !== null);
  return onCards.map((person, part) => {
    const row = {
      ...draft,
      ...cardFields(person, part, {
        messageId: context.messageId,
        viaDm: context.viaDm,
        people: named,
        toldAt: context.now.toISOString(),
        cc: cc.filter((person) => person.id !== context.ownerDiscordId),
      }),
    };
    const next = nextAlertFor(
      {
        ...row,
        status: row.status ?? "open",
        direction: row.direction ?? "given",
        deadline: row.deadline ?? null,
        alert_every_minutes: row.alert_every_minutes ?? null,
        last_alert_at: row.last_alert_at ?? null,
      } as Task,
      context.now,
      context.ownerDiscordId,
    );
    return { ...row, next_alert_at: next ? next.toISOString() : null };
  });
}

/** "Rea", "Rea and Cenri", "Rea, Cenri and Minh". */
export function namesText(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * A message as people read it: `<@123>` becomes "@Rea", `<@&456>` the role's
 * name when it is known (the bot's own role is the bot), and `<#789>`
 * "#channel". An id nothing names reads "@someone" — never the raw snowflake,
 * which says nothing to anybody (Lucky35's PO, 2026-10-05).
 */
export function readableMentions(text: string, nameOf: (id: string) => string | null | undefined): string {
  return text
    .replace(/<@!?(\d+)>/g, (_, id: string) => `@${nameOf(id) || "someone"}`)
    .replace(/<@&(\d+)>/g, (_, id: string) => `@${nameOf(id) || "role"}`)
    .replace(/<#(\d+)>/g, "#channel");
}

/**
 * The other cards a message filed, beside this one — "Also given to" — from
 * whatever the board holds. A card on its own, or one added by hand, has none.
 */
export function siblingsOf<T extends Pick<Task, "id" | "source_message_id">>(task: T, tasks: readonly T[]): T[] {
  if (!task.source_message_id) return [];
  return tasks.filter((other) => other.id !== task.id && other.source_message_id === task.source_message_id);
}
