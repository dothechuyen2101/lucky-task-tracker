/**
 * "Did I already give someone a task about X?" — pure, so it is testable.
 *
 * Lucky35, 2026-10-12: "add to the task tracker an option for me to ask an AI
 * like 'did I give someone a task about doing X' — I will be giving many tasks
 * to many people, I will forget." The board's owner asks in plain words; the
 * route (`/api/tasks/ask`) sends Claude every task they have given, open and
 * closed, one numbered line each (`askLines`), on the owner's own Anthropic
 * key. Claude answers with the NUMBERS of the tasks about the same thing, and
 * why; everything shown about a task comes from the database, never from the
 * model (`matchesOf`), so it cannot invent one.
 *
 * Imported by a client component: no network, no database, no clock.
 */

import { stageLabel } from "./stages";
import type { Task } from "./types/database";

/** The longest question accepted. */
export const ASK_MAX_QUESTION = 300;

/** The most tasks sent in one question — the newest, when there are more. */
export const ASK_MAX_TASKS = 3000;

/** The most matches shown for one question; the rest are counted (`pickedCount`). */
export const ASK_MAX_MATCHES = 30;

/** What a task line is made of. */
export type AskTask = Pick<
  Task,
  | "id"
  | "title"
  | "detail"
  | "assignee_name"
  | "assignee_discord_id"
  | "status"
  | "stage"
  | "review_state"
  | "deadline"
  | "created_at"
  | "completed_at"
  | "requested_by_name"
>;

export type AskMatch = { task: AskTask; why: string };

/** The question as asked, or null when there is none worth sending. */
export function cleanQuestion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const question = raw.replace(/\s+/g, " ").trim();
  if (question.length < 3) return null;
  return question.slice(0, ASK_MAX_QUESTION);
}

/** A day in the person's zone, as YYYY-MM-DD. */
export function dayIn(iso: string | null | undefined, zone: string): string | null {
  if (!iso) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  const format = (timeZone: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(when);
  try {
    return format(zone || "UTC");
  } catch {
    return format("UTC");
  }
}

/** Today in the person's zone with its weekday — "2026-10-13 (Tuesday)" — so "last week" has an anchor. */
export function todayIn(now: Date, zone: string): string {
  const day = dayIn(now.toISOString(), zone) ?? now.toISOString().slice(0, 10);
  const weekday = (timeZone: string) => new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(now);
  let name: string;
  try {
    name = weekday(zone || "UTC");
  } catch {
    name = weekday("UTC");
  }
  return `${day} (${name})`;
}

/** Where a task stands, in words a reviewer uses. */
export function standing(task: Pick<AskTask, "status" | "stage" | "review_state">): string {
  if (task.status === "done" && task.review_state === "pending") return "reported done, waiting for review";
  if (task.status === "done") return "done";
  if (task.status === "dismissed") return "dismissed";
  if (task.status === "failed") return "failed";
  return `open, ${stageLabel(task.stage).toLowerCase()}`;
}

function oneLine(text: string | null | undefined, max: number): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Every task as one numbered line — `[n]` is how Claude names it back. The
 * list the route sends is newest first; the numbers start at 1.
 */
export function askLines(tasks: readonly AskTask[], zone: string): string {
  return tasks
    .map((task, index) => {
      const parts = [
        `[${index + 1}] ${oneLine(task.title, 200)}`,
        `for ${oneLine(task.assignee_name, 60) || (task.assignee_discord_id ? `@${task.assignee_discord_id}` : "nobody yet")}`,
        standing(task),
        `given ${dayIn(task.created_at, zone) ?? "?"}`,
        task.deadline ? `due ${dayIn(task.deadline, zone)}` : null,
        task.completed_at ? `finished ${dayIn(task.completed_at, zone)}` : null,
        task.requested_by_name ? `asked by ${oneLine(task.requested_by_name, 60)}` : null,
        task.detail ? `detail: ${oneLine(task.detail, 240)}` : null,
      ];
      return parts.filter(Boolean).join(" — ");
    })
    .join("\n");
}

/**
 * The other names each person a task went to is known by — so "what did I
 * give Leo?" finds the tasks given to @thuan2172001 (2026-10-13: it did not).
 * `aliases` maps a Discord id to names from the tracker's own records: their
 * Discord display name, their ClickUp name, how the owner noted them. One
 * line per person with more than one name; empty when nobody has.
 */
export function peopleLegend(tasks: readonly AskTask[], aliases: ReadonlyMap<string, Iterable<string>>): string {
  const byPerson = new Map<string, string[]>();
  for (const task of tasks) {
    const id = (task.assignee_discord_id ?? "").trim();
    if (!id) continue;
    const names = byPerson.get(id) ?? [];
    const name = oneLine(task.assignee_name, 60);
    if (name) names.push(name);
    byPerson.set(id, names);
  }
  const lines: string[] = [];
  for (const [id, fromTasks] of byPerson) {
    const all = [...fromTasks, ...[...(aliases.get(id) ?? [])].map((name) => oneLine(name, 60))].filter(Boolean);
    const seen = new Set<string>();
    const names = all.filter((name) => !seen.has(name.toLowerCase()) && Boolean(seen.add(name.toLowerCase())));
    if (names.length > 1) lines.push(`- ${names[0]}: also ${names.slice(1).join(", ")}`);
  }
  return lines.join("\n");
}

/** How many of Claude's picks are tasks on the list — more than are shown when the cap cut them. */
export function pickedCount(picked: ReadonlyArray<{ index: number }>, tasks: readonly AskTask[]): number {
  const seen = new Set<number>();
  for (const pick of picked) {
    const index = Math.trunc(pick.index);
    if (Number.isFinite(index) && index >= 1 && index <= tasks.length) seen.add(index);
  }
  return seen.size;
}

/** The figures under an answer, counted from the tasks themselves — not from the model's sentence. */
export function tally(matches: readonly AskMatch[]): { open: number; waiting: number; done: number; other: number } {
  const counts = { open: 0, waiting: 0, done: 0, other: 0 };
  for (const { task } of matches) {
    if (task.status === "open") counts.open += 1;
    else if (task.status === "done" && task.review_state === "pending") counts.waiting += 1;
    else if (task.status === "done") counts.done += 1;
    else counts.other += 1;
  }
  return counts;
}

/**
 * Claude's picks, as tasks: only numbers that are on the list, each once, in
 * Claude's order — a number it made up is dropped, never shown.
 */
export function matchesOf(picked: ReadonlyArray<{ index: number; why?: string | null }>, tasks: readonly AskTask[]): AskMatch[] {
  const seen = new Set<number>();
  const matches: AskMatch[] = [];
  for (const pick of picked) {
    const index = Math.trunc(pick.index);
    if (!Number.isFinite(index) || index < 1 || index > tasks.length || seen.has(index)) continue;
    seen.add(index);
    const task = tasks[index - 1];
    const why = oneLine(pick.why, 240);
    // A "why" that only repeats the title says nothing.
    matches.push({ task, why: why.toLowerCase() === oneLine(task.title, 240).toLowerCase() ? "" : why });
    if (matches.length >= ASK_MAX_MATCHES) break;
  }
  return matches;
}
