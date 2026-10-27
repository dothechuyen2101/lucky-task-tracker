/**
 * Per-person counts and completion history — pure.
 *
 * Everything the person panel needs to derive lives here rather than inside
 * `components/person-panel.tsx`, because `vitest.config.mts` collects
 * `lib/**\/*.test.ts` and nothing else: a derivation written in a component has
 * no machine-checkable acceptance in this repo. Same reason `lib/board.ts`
 * exists.
 *
 * Nothing in this module touches React, a Supabase client, `Date.now()` or the
 * network. `now` is always a parameter so a test can pin it.
 */

import { isOverdue } from "@/lib/reminders";
import { DONE_FROM_STAGE, isDoneStage } from "@/lib/stages";
import type { Person, Task } from "@/lib/types/database";

/**
 * The one column that joins a task to a person: the Discord snowflake plan
 * `task-tracker-2026-001` put on `tt_tasks`, and the same value `tt_people
 * .discord_user_id` stores. Named once so the whole feature hangs off a single
 * place — `lib/board.ts`'s `personKeyOf` reads the same field for the cards.
 *
 * A snowflake is a stable numeric id: there is nothing to case-fold and nothing
 * to collapse, so it is trimmed and otherwise used raw. A display name is never
 * a key — a name change would orphan every historic row and two people sharing
 * one would collapse into a single person.
 *
 * Plan 001 DID also ship a companion display-name column, `assignee_name`
 * (`lib/types/database.ts:111-112`), so source (a) of ruling 6 is available and
 * `displayNameFor` uses it first.
 */
export const PERSON_KEY_COLUMN = "assignee_discord_id" as const;

/** The companion label column 001 shipped beside the key. A label, never a key. */
export const PERSON_NAME_COLUMN = "assignee_name" as const;

/** Shown in place of initials when the only name we have is a raw snowflake. */
export const NEUTRAL_INITIAL = "·";

/** One finished piece of work, as the panel's history lists it. */
export type Completion = {
  taskId: string;
  title: string;
  /** ISO timestamp: the stage-4 stamp when there is one, else `completed_at`. */
  at: string;
};

function trimmed(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/**
 * The one adapter from a task to a person key. `null` — not `""` — when the
 * task carries nobody, so a caller cannot accidentally ask for "the person
 * whose key is the empty string" and be handed every unassigned task.
 */
export function personKeyForTask(task: Task): string | null {
  const key = trimmed(task[PERSON_KEY_COLUMN]);
  return key === "" ? null : key;
}

/**
 * Every task this person owes the owner.
 *
 * The `direction === "given"` filter runs FIRST and unconditionally (Erik, in
 * session, 2026-09-07, ruling b): `received` work is what somebody asked OF the
 * owner, it is somebody else's ledger, and it never reaches a person's counts
 * or history whatever key it carries. The database says the same thing in its
 * own words at
 * `supabase/migrations/20260903_02_received_tasks_and_backfill.sql:38-39`.
 *
 * An empty or whitespace-only key matches nobody and returns nothing.
 */
export function tasksForPerson(tasks: Task[], key: string): Task[] {
  const wanted = trimmed(key);
  if (wanted === "") return [];

  return tasks.filter((task) => {
    if (task.direction !== "given") return false;
    return personKeyForTask(task) === wanted;
  });
}

/** How many things this person still owes. */
export function openCount(tasks: Task[], key: string): number {
  return tasksForPerson(tasks, key).filter((task) => task.status === "open").length;
}

/**
 * How many of those are past their deadline.
 *
 * The comparison itself is `isOverdue` from `lib/reminders.ts:95-98` — the one
 * the row and the buckets already use — imported rather than restated, so the
 * panel can never disagree with the board about what "overdue" means. It
 * already returns `false` for a null deadline, so no extra guard is needed; the
 * `status === "open"` half is this function's own rule, because a task finished
 * late is not still overdue.
 */
export function overdueCount(tasks: Task[], key: string, now: Date): number {
  return tasksForPerson(tasks, key).filter(
    (task) => task.status === "open" && isOverdue(task.deadline, now),
  ).length;
}

/**
 * When a task was finished, or `null` when nothing in the row says.
 *
 * `stage_at` is the preferred source — it is the stamp the rail writes — but it
 * UNDER-REPORTS: the Discord command path sets `stage = 4` and `completed_at`
 * with no `stage_at` write at all (`lib/worker.ts:778-782`), which is precisely
 * the completions this tracker automates. Reading only the map would silently
 * drop them, so `completed_at` is the fallback (`lib/types/database.ts:119`).
 *
 * The stage ordinal comes from `DONE_FROM_STAGE` (`lib/stages.ts:32`), never a
 * hard-coded `"4"`, so the map key and the rail can never drift apart.
 *
 * An unparseable timestamp is treated as absent rather than dated to the epoch:
 * a wrong date at the top of a history reads as a fact.
 */
function completedAtOf(task: Task): string | null {
  const stamps = task.stage_at ?? {};
  const stamped = trimmed(stamps[String(DONE_FROM_STAGE)]);
  if (stamped !== "" && !Number.isNaN(Date.parse(stamped))) return stamped;

  const fallback = trimmed(task.completed_at);
  if (fallback !== "" && !Number.isNaN(Date.parse(fallback))) return fallback;

  return null;
}

/**
 * What this person has actually finished, newest first.
 *
 * "Finished" is `isDoneStage(task.stage)` (`lib/stages.ts:34-36`) OR
 * `status === "done"` — the two can legitimately disagree, and a task the owner
 * closed off the rail still counts. A finished task carrying no usable date is
 * omitted entirely rather than dated to the epoch.
 */
export function completionHistory(tasks: Task[], key: string): Completion[] {
  const done: Completion[] = [];

  for (const task of tasksForPerson(tasks, key)) {
    if (!isDoneStage(task.stage) && task.status !== "done") continue;

    const at = completedAtOf(task);
    if (at === null) continue;

    done.push({ taskId: task.id, title: task.title, at });
  }

  return done.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/**
 * The name to put on the panel, in ruling 6's priority order:
 *
 *   (a) the companion label plan 001 ships on the task itself, when it is
 *       non-empty — rows repaired by 001's offline backfill carry an id and a
 *       NULL name, so this is often absent and that is normal;
 *   (b) `tt_people.display_name`, when the owner's own row has one;
 *   (c) the key itself, rendered `@<key>`.
 *
 * Nothing here fetches Discord (ruling 1): `lib/discord.ts` has no by-id user
 * helper and adding one would need a route holding the bot token.
 */
export function displayNameFor(
  person: Person | null,
  task: Task | null,
  key: string,
): string {
  const fromTask = task === null ? "" : trimmed(task[PERSON_NAME_COLUMN]);
  if (fromTask !== "") return fromTask;

  const fromPerson = person === null ? "" : trimmed(person.display_name);
  if (fromPerson !== "") return fromPerson;

  return `@${trimmed(key)}`;
}

/**
 * The avatar fallback: the first letters of the first two whitespace-separated
 * words of the resolved name, uppercased.
 *
 * When the resolved name IS the raw key — because neither the task nor the
 * owner's row had a label — there is no name to abbreviate, and the first two
 * digits of a snowflake are noise dressed up as identity. That case renders one
 * neutral glyph instead (ruling 6).
 */
export function initialsFor(name: string, key: string): string {
  const resolved = trimmed(name).replace(/^@+/, "").trim();
  const bare = trimmed(key);

  if (resolved === "") return NEUTRAL_INITIAL;
  if (bare !== "" && resolved === bare) return NEUTRAL_INITIAL;
  if (/^\d+$/.test(resolved)) return NEUTRAL_INITIAL;

  const letters = resolved
    .split(/\s+/)
    .filter((word) => word !== "")
    .slice(0, 2)
    .map((word) => word[0])
    .join("");

  return letters === "" ? NEUTRAL_INITIAL : letters.toUpperCase();
}
