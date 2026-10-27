/**
 * The monthly summary — what was finished in one month, pure.
 *
 * Cenri, 2026-10-05: one page that says what got done in a month, and keeps
 * saying it for every month after. `app/summary/page.tsx` reads the month's
 * finished work; every rule it applies — where the month starts, who a task
 * counts for, on time or late, the text that is copied out — is here and
 * pinned by `lib/summary.test.ts`.
 *
 * A month is the person's own (`tt_profiles.timezone`): October ends at
 * midnight where they are, not in UTC, so a task finished late on the 31st in
 * Ho Chi Minh City is October's. Nothing here reads the clock, the network or
 * the database; `now` is passed in.
 */

import { type Viewer, isAssignedToViewer, isShared, personKeyOf } from "./board";
import { fromZoned, isValidTimeZone, zonedParts } from "./deadlines";
import { durationText } from "./review";
import type { Task } from "./types/database";

/** A calendar month. `month` is 1-based, like `ZonedParts`. */
export type Month = { year: number; month: number };

/** Nothing was tracked before this; an older `?month=` is a typo, not a request. */
const FIRST_YEAR = 2020;

function zoneOrUtc(timeZone: string | null | undefined): string {
  return timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC";
}

/** The month it is at `now`, where the person is. */
export function monthOf(now: Date, timeZone: string | null | undefined): Month {
  const parts = zonedParts(now, zoneOrUtc(timeZone));
  return { year: parts.year, month: parts.month };
}

/** `delta` months later — earlier when negative. */
export function shiftMonth(month: Month, delta: number): Month {
  const index = month.year * 12 + (month.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (((index % 12) + 12) % 12) + 1 };
}

/** Negative, zero or positive, as `a` is before, the same as or after `b`. */
export function compareMonths(a: Month, b: Month): number {
  return a.year * 12 + a.month - (b.year * 12 + b.month);
}

/** "2026-10" — the `?month=` value. */
export function monthParam(month: Month): string {
  return `${String(month.year).padStart(4, "0")}-${String(month.month).padStart(2, "0")}`;
}

/**
 * The month `?month=` asks for. Anything unreadable — or a month that has not
 * started yet, which could only ever be empty — is this month.
 */
export function parseMonth(value: string | null | undefined, now: Date, timeZone: string | null | undefined): Month {
  const current = monthOf(now, timeZone);
  const match = /^(\d{4})-(\d{2})$/.exec((value ?? "").trim());
  if (!match) return current;
  const asked = { year: Number(match[1]), month: Number(match[2]) };
  if (asked.month < 1 || asked.month > 12 || asked.year < FIRST_YEAR) return current;
  return compareMonths(asked, current) > 0 ? current : asked;
}

/** Where the month starts and the next one does, as instants: `[start, end)`. */
export function monthBounds(month: Month, timeZone: string | null | undefined): { start: string; end: string } {
  const zone = zoneOrUtc(timeZone);
  const midnightOnThe1st = (m: Month) =>
    fromZoned({ year: m.year, month: m.month, day: 1, hour: 0, minute: 0 }, zone).toISOString();
  return { start: midnightOnThe1st(month), end: midnightOnThe1st(shiftMonth(month, 1)) };
}

/** "October 2026". A month has no zone, so it is named in UTC. */
export function monthLabel(month: Month): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(
    new Date(Date.UTC(month.year, month.month - 1, 1)),
  );
}

/** "Oct 31" — the day an instant falls on, where the person is. */
export function dayLabel(iso: string, timeZone: string | null | undefined): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: zoneOrUtc(timeZone), month: "short", day: "numeric" }).format(
    new Date(iso),
  );
}

// ---------------------------------------------------------------------------
// What was finished
// ---------------------------------------------------------------------------

/**
 * How finished work met its deadline. Finishing AT the deadline is on time —
 * the same strict "after" that makes a task overdue (`isOverdue`).
 */
export type Timing = { kind: "on_time" } | { kind: "late"; byMs: number } | { kind: "undated" };

export function timingOf(task: Pick<Task, "deadline" | "completed_at">): Timing {
  const deadline = task.deadline ? Date.parse(task.deadline) : Number.NaN;
  const finished = task.completed_at ? Date.parse(task.completed_at) : Number.NaN;
  if (Number.isNaN(deadline) || Number.isNaN(finished)) return { kind: "undated" };
  return finished <= deadline ? { kind: "on_time" } : { kind: "late", byMs: finished - deadline };
}

/**
 * Whose finished work a group is: the viewer's own (given to them by anyone,
 * asked of them, or taken on themselves), one person's the viewer gave it to,
 * or work that was never given to anyone.
 */
export type SummaryGroup = { who: "you" | "person" | "nobody"; key: string; tasks: Task[] };

export type MonthSummary = {
  finished: number;
  onTime: number;
  late: number;
  undated: number;
  /** Marked finished by its assignee, and the giver has not said yet. Counted as finished. */
  awaitingReview: number;
  groups: SummaryGroup[];
};

function finishedAt(task: Task): number {
  return task.completed_at ? Date.parse(task.completed_at) : Number.NaN;
}

const WHO_RANK: Record<SummaryGroup["who"], number> = { you: 0, person: 1, nobody: 2 };

/**
 * The month's finished work: done (not dismissed) with `completed_at` inside
 * `bounds`, grouped by who did it — the viewer first, then the people they
 * gave work to, busiest first, then work given to nobody — each group in the
 * order it was finished.
 *
 * The page already asks the database for exactly this; it is filtered again
 * here so the rule is the module's, not the query's.
 */
export function summarize(tasks: Task[], viewer: Viewer, bounds: { start: string; end: string }): MonthSummary {
  const start = Date.parse(bounds.start);
  const end = Date.parse(bounds.end);
  const finished = tasks
    .filter((task) => {
      const at = finishedAt(task);
      return task.status === "done" && at >= start && at < end;
    })
    .sort((a, b) => finishedAt(a) - finishedAt(b) || a.id.localeCompare(b.id));

  const groups = new Map<string, SummaryGroup>();
  const summary: MonthSummary = { finished: finished.length, onTime: 0, late: 0, undated: 0, awaitingReview: 0, groups: [] };

  for (const task of finished) {
    const yours = isShared(task, viewer) || isAssignedToViewer(task, viewer);
    const key = yours ? "" : personKeyOf(task);
    const who: SummaryGroup["who"] = yours ? "you" : key === "" ? "nobody" : "person";
    const id = `${who}:${key}`;
    if (!groups.has(id)) groups.set(id, { who, key, tasks: [] });
    groups.get(id)!.tasks.push(task);

    const timing = timingOf(task);
    if (timing.kind === "on_time") summary.onTime += 1;
    else if (timing.kind === "late") summary.late += 1;
    else summary.undated += 1;
    if (task.review_state === "pending") summary.awaitingReview += 1;
  }

  // A stable sort: people with as much done stay in the order they first finished.
  summary.groups = Array.from(groups.values()).sort(
    (a, b) => WHO_RANK[a.who] - WHO_RANK[b.who] || b.tasks.length - a.tasks.length,
  );
  return summary;
}

/** "12 tasks — 10 on time, 2 late". */
export function countLine(summary: MonthSummary): string {
  const head = `${summary.finished} task${summary.finished === 1 ? "" : "s"}`;
  const parts = [
    summary.onTime > 0 ? `${summary.onTime} on time` : null,
    summary.late > 0 ? `${summary.late} late` : null,
    summary.undated > 0 ? `${summary.undated} without a deadline` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `${head} — ${parts.join(", ")}` : head;
}

/**
 * The month as plain text, to paste into Discord or a report: a headline, then
 * each group's work in the order it was finished, with how late where it was.
 */
export function summaryText(
  summary: MonthSummary,
  month: Month,
  {
    timeZone,
    nameOf,
    scoreOf,
  }: {
    timeZone: string | null | undefined;
    nameOf: (group: SummaryGroup) => string;
    /** The group's score for the month, as written ("+0.5"), or null for none. */
    scoreOf?: (group: SummaryGroup) => string | null;
  },
): string {
  const label = monthLabel(month);
  if (summary.finished === 0) return `Nothing finished in ${label}.`;

  const lines = [`Finished in ${label}: ${countLine(summary)}`];
  for (const group of summary.groups) {
    const score = scoreOf?.(group) ?? null;
    lines.push("", `${nameOf(group)} (${group.tasks.length})${score !== null ? ` · score ${score}` : ""}`);
    for (const task of group.tasks) {
      const timing = timingOf(task);
      const late = timing.kind === "late" ? ` (late by ${durationText(timing.byMs)})` : "";
      lines.push(`• ${dayLabel(task.completed_at ?? "", timeZone)} — ${task.title}${late}`);
    }
  }
  return lines.join("\n");
}
