/**
 * Tasks by direct message — pure, so it is testable.
 *
 * Lucky35, 2026-10-02: Luka hands out work in private messages, and the
 * people who work with him needed one place to see what is on them. A bot can
 * never read a DM between two people; it can read a DM sent to the BOT. So the
 * owner writes a task to their own bot exactly as they would tag it in a
 * channel — "@minh redo the thumbnail, 36 hours" — and the people they give
 * work to talk to the same bot: `done`, `stop`, "my tasks", or a request for
 * the owner. The worker reads those DMs (`pollDms`, `runDirectMessages`);
 * every word the bot says back is built here.
 *
 * Everything the bot says in a DM is fixed text with the task's own fields
 * dropped in — never the model's words — like every other answer it gives.
 */

import type { Mentioned } from "@/lib/relevance";
import type { AssigneeCandidate, Task } from "@/lib/types/database";

/**
 * How far back a conversation the bot has only just started reading is read:
 * a DM written a little before the bot first looked is still answered, a
 * conversation from last year is not replayed.
 */
export const DM_FIRST_READ_MS = 24 * 3_600_000;

/**
 * The bot reads the DMs of everyone the owner gave work to (or wrote a note
 * about) in this many days. Without a live connection a bot cannot discover a
 * DM someone else opened; it can open — and read — one with anyone it knows.
 */
export const DM_PEOPLE_WINDOW_DAYS = 30;

/** Lines listed in one DM before the rest are counted. */
export const DM_LIST_MAX = 15;

/** Discord's hard limit on one message. */
const DISCORD_MESSAGE_MAX = 2000;

// ---------------------------------------------------------------------------
// Who a DM names
// ---------------------------------------------------------------------------

const NOT_A_PERSON = new Set(["everyone", "here", "channel"]);

/**
 * "@minh" typed as plain text. In a DM, Discord's @ list offers only the two
 * people in it, so a name typed there never becomes a mention — it arrives as
 * words. Mention markup is taken out first; `@everyone` and `@here` are not
 * people. In the order written, each once.
 */
export function plainHandles(content: string): string[] {
  const text = content.replace(/<[@#][!&]?\d+>/g, " ");
  const names: string[] = [];
  for (const match of text.matchAll(/(?:^|[\s(,;:])@([\p{L}\p{N}][\p{L}\p{N}._-]{0,31})/gu)) {
    const name = match[1].replace(/[._-]+$/, "");
    if (NOT_A_PERSON.has(name.toLowerCase()) || names.some((n) => n.toLowerCase() === name.toLowerCase())) continue;
    names.push(name);
  }
  return names;
}

function folded(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/**
 * Someone a name typed in a DM might be: their id, every name they go by, a
 * label to show the owner, and where they were found.
 */
export type PersonOption = { id: string; names: string[]; label: string; where: string | null };

function asCandidate(option: PersonOption): AssigneeCandidate {
  return { id: option.id, name: option.names[0] ?? option.label, label: option.label, where: option.where };
}

/** Everyone the owner has worked with, one option per person. */
export function knownOptions(people: readonly Mentioned[]): PersonOption[] {
  const byId = new Map<string, PersonOption>();
  for (const person of people) {
    const option = byId.get(person.id) ?? { id: person.id, names: [], label: person.name, where: "worked with before" };
    if (!option.names.some((n) => folded(n) === folded(person.name))) option.names.push(person.name);
    byId.set(person.id, option);
  }
  return [...byId.values()];
}

/** Server members found by search, one option per person; bots left out. */
export function memberOptions(
  found: ReadonlyArray<{
    where: string | null;
    member: { nick?: string | null; user: { id: string; username: string; global_name?: string | null; bot?: boolean } };
  }>,
): PersonOption[] {
  const byId = new Map<string, PersonOption>();
  for (const { where, member } of found) {
    if (member.user.bot || byId.has(member.user.id)) continue;
    const display = member.nick || member.user.global_name || member.user.username;
    const names = [member.user.username, member.user.global_name, member.nick].filter((n): n is string => Boolean(n));
    byId.set(member.user.id, {
      id: member.user.id,
      names,
      label: display === member.user.username ? `@${display}` : `${display} (@${member.user.username})`,
      where,
    });
  }
  return [...byId.values()];
}

/**
 * The one person the owner has worked with whose name IS what was written
 * (case and accents aside) — or nobody. The only match that assigns a task
 * without asking (Lucky35, 2026-10-03): a name that merely starts the same,
 * or a stranger found in a server, could be the wrong person, and the task and
 * its DMs would go to them with nobody the wiser.
 */
export function exactKnown(known: readonly PersonOption[], written: string): Mentioned | null {
  const name = folded(written.replace(/^@/, ""));
  if (name.length < 2) return null;
  const hits = known.filter((p) => p.names.some((n) => folded(n) === name));
  if (hits.length !== 1) return null;
  return { id: hits[0].id, name: hits[0].names.find((n) => folded(n) === name) ?? hits[0].label };
}

/** At most this many people are offered to the owner to pick from. */
export const MAX_CANDIDATES = 5;

/**
 * Everyone a written name might mean — people the owner knows first, then
 * server members — whose name equals it or starts with it, each once. Offered
 * to the owner to pick from; never assigned on its own.
 */
export function candidatesFor(written: string, known: readonly PersonOption[], members: readonly PersonOption[]): AssigneeCandidate[] {
  const name = folded(written.replace(/^@/, ""));
  if (name.length < 2) return [];
  const fits = (p: PersonOption) => p.names.some((n) => folded(n) === name || folded(n).startsWith(name) || folded(n).split(/\s+/).includes(name));
  const seen = new Set<string>();
  const out: AssigneeCandidate[] = [];
  for (const option of [...known.filter(fits), ...members.filter(fits)]) {
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    out.push(asCandidate(option));
  }
  return out.slice(0, MAX_CANDIDATES);
}

/**
 * The owner's pick from a list of candidates: its number ("2"), or a name
 * matching exactly one of them. Null when the answer picks nobody.
 */
export function pickCandidate(answer: string, candidates: readonly AssigneeCandidate[]): AssigneeCandidate | null {
  const said = folded(answer.replace(/<[@#][!&]?\d+>/g, " ")).replace(/[.!)#]+$/, "").replace(/^#/, "").trim();
  if (/^\d{1,2}$/.test(said)) return pickNumbered(candidates, Number(said));
  const hits = candidates.filter((c) => folded(c.label) === said || folded(c.label).includes(`@${said.replace(/^@/, "")})`));
  return hits.length === 1 ? hits[0] : null;
}

// ---------------------------------------------------------------------------
// A request from someone else: their "yes" files it
// ---------------------------------------------------------------------------

const YES = new Set(["yes", "y", "yeah", "yep", "yup", "ok", "okay", "sure", "send", "co", "dong y", "u", "um", "vang", "gui", "uh"]);
const NO = new Set(["no", "n", "nope", "cancel", "khong", "thoi", "huy", "dung", "ko", "k"]);

function shortAnswer(text: string): string {
  return folded(text.replace(/<[@#][!&]?\d+>/g, " "))
    .replace(/đ/g, "d")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A short "yes" — "yes", "ok", "send it", "có", "đồng ý". Never a longer sentence that merely starts with "ok". */
export function isYes(text: string): boolean {
  const said = shortAnswer(text);
  if (said.split(" ").length > 3) return false;
  return YES.has(said) || YES.has(said.split(" ")[0]) && /^(\S+)( it| di| nhe| please| pls)?$/.test(said);
}

/** A short "no" — "no", "cancel", "không", "thôi". */
export function isNo(text: string): boolean {
  const said = shortAnswer(text);
  return said.split(" ").length <= 3 && (NO.has(said) || NO.has(said.split(" ")[0]));
}

/** The question a request from someone else waits on. */
export function requestConfirmQuestion(ownerName: string | null, words: string): string {
  const quoted = words.replace(/\s+/g, " ").trim();
  return fit([
    `Send this to **${ownerName ?? "them"}** as a task?`,
    `> ${quoted.length > 200 ? `${quoted.slice(0, 199)}…` : quoted}`,
    "Reply `yes` to this message to send it, or `no` to drop it.",
  ]);
}

// ---------------------------------------------------------------------------
// What the bot says
// ---------------------------------------------------------------------------

function unixOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.floor(at / 1000) : null;
}

/** "<t:…:F> (<t:…:R>)" — Discord renders both in the READER's own clock. */
function when(iso: string | null | undefined): string | null {
  const unix = unixOf(iso);
  return unix === null ? null : `<t:${unix}:F> (<t:${unix}:R>)`;
}

/** An address in angle brackets, so Discord does not unfurl it under the message. */
function bracketed(url: string | null | undefined): string | null {
  return url ? `<${url}>` : null;
}

function fit(lines: Array<string | null | false | undefined>): string {
  const text = lines.filter(Boolean).join("\n");
  return text.length > DISCORD_MESSAGE_MAX ? `${text.slice(0, DISCORD_MESSAGE_MAX - 1)}…` : text;
}

/** What the owner is told after a task they DMed the bot is filed. */
export function filedReply(input: {
  title: string;
  deadline: string | null;
  assigneeName: string | null;
  /** A name the message gave that matched nobody exactly. */
  unknownName: string | null;
  /** Who that name might be: the owner picks, and nobody is told until then. */
  candidates?: readonly AssigneeCandidate[];
  link: string | null;
}): string {
  const choices = input.candidates ?? [];
  const who = input.assigneeName
    ? `For **${input.assigneeName}** — they get a DM about it.`
    : choices.length > 0
      ? [
          `Who is "${input.unknownName ?? "that"}"? It isn't given to anyone until you say — reply to this message with the number:`,
          ...choices.map((c, i) => `${i + 1}. ${c.label}${c.where ? ` · ${c.where}` : ""}`),
        ].join("\n")
      : input.unknownName
        ? `No assignee: I don't know who "${input.unknownName}" is. Pick them on the board.`
        : "No assignee yet — pick one on the board, or name them as `@name` next time.";
  return fit([
    `✅ Filed: **${input.title}**`,
    who,
    input.deadline ? `Due ${when(input.deadline)}` : "No deadline yet.",
    choices.length > 0 ? null : "Reply to this message to change it: `done`, `dismiss`, `deadline friday 5pm`, `6 more hours`, `remind me daily`.",
    bracketed(input.link),
  ]);
}

/** A repeat of something already on the board, answered in the DM. */
export function alreadyFiledReply(title: string, link: string | null): string {
  return fit([`✅ Already on the board: **${title}** — nothing new filed.`, bracketed(link)]);
}

/** What someone other than the owner is told when their DM became a task for the owner. */
export function passedOnReply(ownerName: string | null, title: string): string {
  return `📌 Passed to **${ownerName ?? "them"}** as a task: **${title}**. It's on their board now.`;
}

/**
 * The DM the person a task is for gets when nobody else told them: a task
 * given by DM to the bot, made by hand on the board, or moved to them. A task
 * given in a channel @-mentioned them, so they already know.
 */
export function assignedNotice(input: {
  ownerName: string | null;
  title: string;
  deadline: string | null;
  detail: string | null;
  sourceUrl: string | null;
  /** The task on the board. */
  link: string | null;
  /** Everything on them, from everyone. */
  mine: string | null;
}): string {
  // Only the two people in a DM can open a link into it.
  const source = input.sourceUrl && !input.sourceUrl.includes("/channels/@me/") ? `↪ ${input.sourceUrl}` : null;
  return fit([
    `📌 **${input.ownerName ?? "Someone"}** gave you a task:`,
    `**${input.title}**`,
    input.deadline ? `Deadline ${when(input.deadline)}` : "No deadline yet.",
    input.detail || null,
    source,
    "Reply to this message with `start` when you begin, the proof when it's finished (a screenshot, a file, a link or a few words), or `stop` to stop its reminders. Ask me `my tasks` for everything on you.",
    input.mine ? `All your tasks, from everyone: <${input.mine}>` : bracketed(input.link),
  ]);
}

/** One task as a line of a list. */
export type ListedTask = Pick<Task, "title" | "deadline" | "assignee_name" | "direction" | "counterparty">;

function rank(task: ListedTask, now: Date): [number, number] {
  const at = task.deadline ? Date.parse(task.deadline) : NaN;
  if (!Number.isFinite(at)) return [2, 0];
  return [at < now.getTime() ? 0 : 1, at];
}

/** Overdue first, then soonest; undated last. Stable otherwise. */
export function byUrgency<T extends ListedTask>(tasks: readonly T[], now: Date): T[] {
  return tasks
    .map((task, index) => ({ task, index, key: rank(task, now) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.index - b.index)
    .map((entry) => entry.task);
}

/**
 * A numbered list of tasks for a DM — "my tasks" from someone the owner works
 * with, or "what's open?" from the owner. `forGiver` adds who each task is
 * for. The first lines itemised, the rest counted; always one message.
 */
export function taskListText(
  tasks: readonly ListedTask[],
  now: Date,
  options: { heading: string; empty: string; link: string | null; forGiver: boolean },
): string {
  if (tasks.length === 0) return fit([options.empty, bracketed(options.link)]);

  const lines = byUrgency(tasks, now).map((task, i) => {
    const unix = unixOf(task.deadline);
    const due =
      unix === null
        ? "no deadline"
        : Date.parse(task.deadline!) < now.getTime()
          ? `**overdue**, was due <t:${unix}:R>`
          : `due <t:${unix}:R>`;
    const whose = options.forGiver
      ? task.direction === "received"
        ? ` · ${task.counterparty ?? "someone"} asked you`
        : task.assignee_name
          ? ` · for ${task.assignee_name}`
          : ""
      : "";
    return `${i + 1}. **${task.title.slice(0, 80)}** — ${due}${whose}`;
  });

  for (let shown = Math.min(lines.length, DM_LIST_MAX); shown >= 0; shown -= 1) {
    const rest = lines.length - shown;
    const text = [options.heading, ...lines.slice(0, shown), rest > 0 ? `…and ${rest} more.` : null, bracketed(options.link)]
      .filter(Boolean)
      .join("\n");
    if (text.length <= DISCORD_MESSAGE_MAX) return text;
  }
  return fit([options.heading, bracketed(options.link)]);
}

/** The owner's help, for an instruction in their DM that is not a reply to a task. */
export function ownerDmHelp(): string {
  return (
    "To give a task, just write it here — no need to tag me: `@minh redo the thumbnail, 36 hours`. " +
    "To change one, reply to my message about it with `done`, `dismiss`, `deadline friday 5pm`, `6 more hours` or `remind me daily` — " +
    "or, when someone reports it done, `approve`, `approve late` or `extend 2 days`. " +
    "Ask `what's open?` for your list."
  );
}

/** Help for anyone else who DMs the owner's bot. */
export function guestDmHelp(ownerName: string | null): string {
  const owner = ownerName ? `**${ownerName}**` : "my owner";
  return (
    `I'm ${owner}'s task bot. Reply to my message about a task with \`start\`, \`done\` or \`stop\`, or ask me \`my tasks\`. ` +
    `Anything you ask me for here goes to ${owner} as a task.`
  );
}

export type DmAction = "start" | "done" | "mute" | "unmute";

/** What the person a task is for is told after answering it by DM. */
export function assigneeAnswerReply(action: DmAction, title: string, ownerName: string | null): string {
  const owner = ownerName ?? "Whoever gave it to you";
  if (action === "start") return `▶️ Noted — **${title}** is in progress. Reply with the proof when it's finished.`;
  if (action === "done") return `🏁 Reported done, with your proof: **${title}**. ${owner} has been told and will review it.`;
  if (action === "mute") return `🔕 No more reminders to you about **${title}**. ${owner} has been told.`;
  return `🔔 Reminders about **${title}** are back on.`;
}

/** The task at a 1-based number in a list, or null. */
export function pickNumbered<T>(tasks: readonly T[], n: number): T | null {
  return Number.isInteger(n) && n >= 1 && n <= tasks.length ? tasks[n - 1] : null;
}

/** What the owner is told when their pick from the candidates lands. */
export function givenToReply(label: string, title: string): string {
  return `✅ **${title}** is now given to ${label} — they get a DM about it.`;
}

// ---------------------------------------------------------------------------
// Copied in, not given the work (Cenri, 2026-10-20)
// ---------------------------------------------------------------------------

/**
 * To someone taken off a card because they were only copied in — so the
 * reminders stopping is not a mystery, and nobody asks them to "reply done"
 * on work that was never theirs.
 */
export function notForThemNotice(title: string, byName: string | null): string {
  return [
    `👋 You were only copied in on **${title}** — it is not on you.`,
    `${byName ?? "Whoever asked for it"} took you off it: nothing to do, and no more reminders about it.`,
  ].join("\n");
}

/** To whoever reviews a card, when its person says it is not theirs. */
export function notMineNotice(name: string, title: string, link: string | null): string {
  return [
    `🙋 **${name}** says **${title}** is not theirs.`,
    `If they were only copied in, take them off it — nothing counts for or against them, and their reminders stop.`,
    link ? `Open it: <${link}>` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
