/**
 * The Team view — who is working on what, and how each person stands. Pure,
 * so it is testable; the board passes `now`.
 *
 * Lucky35, 2026-10-04: Luka could not tell at a glance which dev was on what.
 * Each person the viewer hands work to gets one row: what they are working on
 * (In progress or Testing — the assignee can say "I'm on it" themselves), what
 * is queued behind it, what they reported done and waits for review, and
 * their score, this month and in all.
 *
 * The score is the sum of the person's entries in the permanent history
 * (`tt_score_entries`, lib/score-history.ts, PO 2026-10-09): approve late −1,
 * disapprove −1, +0.5 for every 5 approved on time, and every correction. The
 * viewer reads only the entries RLS lets them — their own, or everyone's for
 * Lucky35 — so a score they may not see is never shown as a clean 0.
 *
 * Imported by client components: no network, no database, no clock.
 */

import { type Viewer, isShared, personKeyOf, sortForCard } from "@/lib/board";
import { isOverdue } from "@/lib/reminders";
import { awaitsReview } from "@/lib/review";
import { type Range, type Tally, formatPoints, tallyFor, tallyText } from "@/lib/score-history";
import { IN_PROGRESS_STAGE } from "@/lib/stages";
import type { ScoreEntry, Task } from "@/lib/types/database";

/**
 * Every this many tasks approved on time earn `ON_TIME_BONUS`, counted
 * cumulatively — not a streak a penalty breaks (Lucky35's PO, 2026-10-05,
 * kept 2026-10-07). The database applies it (`tt_settle_scores`); these name
 * it on screen.
 */
export const ON_TIME_RUN = 5;
export const ON_TIME_BONUS = 0.5;

/** The window the "lately" figure counts over. */
export const RECENT_MISS_DAYS = 30;

/** Where a person stands: their entries added up (lib/score-history.ts). */
export type Standing = Tally;
export type { Range };

/** "0", "+0.5", or "−3" with a real minus sign. */
export const formatScore = formatPoints;

/** What a score is made of, in words: "+0.5 from 1 · −2 from 2". */
export function scoreBreakdown(standing: Standing): string {
  return tallyText(standing);
}

export type TeamMember = {
  key: string;
  /** Open, In progress or Testing — what they are on now, most urgent first. */
  working: Task[];
  /** Open and not started yet, most urgent first. */
  queued: Task[];
  /** They say it is finished; it waits for the viewer's review. Longest-waiting first. */
  review: Task[];
  /** Open tasks past their deadline. */
  overdue: number;
  /** The score over everything (`total.score`). */
  score: number;
  total: Standing;
  /** The same within the month passed to `teamOf` — this month, on the Team view. */
  month: Standing;
  /** The points lost in the last `RECENT_MISS_DAYS` (≤ 0), corrections not netted. */
  lostLately: number;
  /** The last time anything of theirs moved: a stage, or finishing it. */
  lastMove: string | null;
};

function latest(a: string | null, b: string | null | undefined): string | null {
  if (!b) return a;
  if (!a) return b;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** When the task reached the stage it is on, or null for one not started. */
export function stageSince(task: Pick<Task, "stage" | "stage_at">): string | null {
  return task.stage > 0 ? (task.stage_at?.[String(task.stage)] ?? null) : null;
}

/**
 * One row per person the viewer gives work to: everyone on one of their tasks,
 * everyone with a score entry the viewer can read, and everyone they keep
 * notes on — so a person with nothing open still shows, as free. Never the
 * viewer, and never work from another account (that is not the viewer's team).
 *
 * Ordered: people working on something first, then those with work queued or
 * waiting for review, then the free; by name within each.
 */
export function teamOf(
  tasks: readonly Task[],
  people: ReadonlyArray<{ discord_user_id: string }>,
  viewer: Viewer,
  now: Date,
  nameOf: (key: string) => string,
  timeZone?: string,
  scoring: { entries?: readonly ScoreEntry[]; month?: Range } = {},
): TeamMember[] {
  const entries = scoring.entries ?? [];
  const self = viewer.selfId;
  const keys = new Set<string>();
  const theirs = new Map<string, Task[]>();

  for (const task of tasks) {
    if (isShared(task, viewer) || task.direction !== "given") continue;
    const key = personKeyOf(task);
    if (key === "" || key === self) continue;
    keys.add(key);
    theirs.set(key, [...(theirs.get(key) ?? []), task]);
  }
  for (const entry of entries) {
    const key = entry.person_discord_id.trim();
    if (key !== "" && key !== self) keys.add(key);
  }
  for (const person of people) {
    const key = person.discord_user_id.trim();
    if (key !== "" && key !== self) keys.add(key);
  }

  const lately: Range = { start: new Date(now.getTime() - RECENT_MISS_DAYS * 86_400_000).toISOString(), end: now.toISOString() };

  const members = [...keys].map((key): TeamMember => {
    const list = theirs.get(key) ?? [];
    const open = sortForCard(
      list.filter((task) => task.status === "open"),
      now,
      timeZone,
    );
    const total = tallyFor(entries, key);
    // Without a month to count in, the month is everything.
    const month = scoring.month ? tallyFor(entries, key, scoring.month) : total;
    let lastMove: string | null = null;
    for (const task of list) {
      for (const stamp of Object.values(task.stage_at ?? {})) lastMove = latest(lastMove, stamp);
      lastMove = latest(lastMove, task.completed_at);
    }
    return {
      key,
      working: open.filter((task) => task.stage >= IN_PROGRESS_STAGE),
      queued: open.filter((task) => task.stage < IN_PROGRESS_STAGE),
      review: list
        .filter(awaitsReview)
        .sort((a, b) => Date.parse(a.completed_at ?? a.updated_at) - Date.parse(b.completed_at ?? b.updated_at)),
      overdue: open.filter((task) => isOverdue(task.deadline, now)).length,
      score: total.score,
      total,
      month,
      lostLately: tallyFor(entries, key, lately).minus,
      lastMove,
    };
  });

  const band = (member: TeamMember) =>
    member.working.length > 0 ? 0 : member.queued.length > 0 || member.review.length > 0 ? 1 : 2;
  return members.sort((a, b) => band(a) - band(b) || nameOf(a.key).localeCompare(nameOf(b.key)));
}

// ---------------------------------------------------------------------------
// Live — rows arriving from Supabase Realtime
// ---------------------------------------------------------------------------

/**
 * One row pushed by Realtime, into a list the board holds: a row it has not
 * got is added; one it has is updated, unless what arrived is OLDER than what
 * is there (events can land out of order — the newest write wins).
 *
 * Updated, not replaced: an UPDATE event leaves out a long column it did not
 * change (Postgres keeps it out of line, "TOAST", and does not resend it), so
 * a missing field keeps the value already held.
 */
export function mergeLive<T extends { id: string; updated_at?: string | null }>(rows: readonly T[], incoming: T): T[] {
  const index = rows.findIndex((row) => row.id === incoming.id);
  if (index === -1) return [incoming, ...rows];
  const current = rows[index];
  const was = current.updated_at ? Date.parse(current.updated_at) : NaN;
  const now = incoming.updated_at ? Date.parse(incoming.updated_at) : NaN;
  if (Number.isFinite(was) && Number.isFinite(now) && now < was) return rows as T[];
  const next = [...rows];
  next[index] = { ...current, ...incoming };
  return next;
}

/** A row Realtime says is gone. */
export function dropLive<T extends { id: string }>(rows: readonly T[], id: string): T[] {
  return rows.filter((row) => row.id !== id);
}
