/**
 * The score history — every point a person gained or lost, as the database
 * keeps it (`tt_score_entries`, `20261009_01`). Pure: the history page, the
 * Team view, a person's page, the monthly summary and the CSV export all add
 * the same entries up the same way, so what is exported is what is shown.
 *
 * Lucky35's PO, 2026-10-09: every −1 and +0.5 is an entry — whose, how much,
 * why, which task (or which five), when and who decided; nothing is ever
 * edited or removed, a mistake is reversed by a correction beside it; totals
 * per person by day, week and month; each person sees their own, Lucky35
 * everyone's, and Lucky35 exports them for raises and bonuses.
 *
 * A day, a week (Monday to Sunday) and a month are the viewer's own
 * (`tt_profiles.timezone`), like every time on the page. An entry falls in
 * the period it was DECIDED in — a correction in the period it was made, not
 * the one it corrects, so a closed month's figures never move.
 *
 * Imported by client components: no network, no database, no clock.
 */

import { fromZoned, isValidTimeZone, zonedParts } from "./deadlines";
import type { CorrectionCause, ScoreEntry } from "./types/database";

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/** An entry's points as a number — Postgres `numeric` arrives as a string. */
export function amountOf(entry: Pick<ScoreEntry, "amount">): number {
  const value = typeof entry.amount === "number" ? entry.amount : Number.parseFloat(entry.amount);
  return Number.isFinite(value) ? value : 0;
}

/** Added up without the float dust (0.1 + 0.2), and never −0. */
function sum(values: readonly number[]): number {
  const total = Math.round(values.reduce((n, v) => n + v, 0) * 10) / 10;
  return total === 0 ? 0 : total;
}

/** "+0.5", "−1", "0" — a real minus sign. */
export function formatPoints(points: number): string {
  if (points === 0) return "0";
  return points < 0 ? `−${Math.abs(points)}` : `+${points}`;
}

// ---------------------------------------------------------------------------
// Periods: a day, a week, a month — where the viewer is
// ---------------------------------------------------------------------------

export const PERIOD_KINDS = ["day", "week", "month"] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

/** A period, named by its kind and any day inside it ("YYYY-MM-DD", in the zone). */
export type Period = { kind: PeriodKind; day: string };

/** `[start, end)`, as instants. */
export type Range = { start: string; end: string };

type Ymd = { year: number; month: number; day: number };

function zoneOrUtc(timeZone: string | null | undefined): string {
  return timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC";
}

const pad = (n: number) => String(n).padStart(2, "0");

function dayKey({ year, month, day }: Ymd): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** "2026-10-09" → its parts, or null when it is not a real calendar day. */
export function parseDay(value: string | null | undefined): Ymd | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  if (year < 2020 || year > 2100) return null;
  return { year, month, day };
}

/** Calendar arithmetic on a day, free of any zone: `days` later (or earlier). */
function addDays(ymd: Ymd, days: number): Ymd {
  const date = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function addMonths(ymd: Ymd, months: number): Ymd {
  const date = new Date(Date.UTC(ymd.year, ymd.month - 1 + months, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: 1 };
}

/** Monday = 0 … Sunday = 6. */
function weekdayOf(ymd: Ymd): number {
  return (new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day)).getUTCDay() + 6) % 7;
}

/** The day it is at `now`, where the viewer is. */
export function todayIn(now: Date, timeZone: string | null | undefined): string {
  const parts = zonedParts(now, zoneOrUtc(timeZone));
  return dayKey({ year: parts.year, month: parts.month, day: parts.day });
}

/** The first and the day after the last day of a period, as days. */
function periodDays(period: Period): { first: Ymd; next: Ymd } {
  const day = parseDay(period.day) ?? { year: 2026, month: 1, day: 1 };
  if (period.kind === "day") return { first: day, next: addDays(day, 1) };
  if (period.kind === "week") {
    const first = addDays(day, -weekdayOf(day));
    return { first, next: addDays(first, 7) };
  }
  const first = { year: day.year, month: day.month, day: 1 };
  return { first, next: addMonths(first, 1) };
}

/** A period as instants: midnight to midnight where the viewer is. */
export function periodRange(period: Period, timeZone: string | null | undefined): Range {
  const zone = zoneOrUtc(timeZone);
  const { first, next } = periodDays(period);
  const midnight = (d: Ymd) => fromZoned({ ...d, hour: 0, minute: 0 }, zone).toISOString();
  return { start: midnight(first), end: midnight(next) };
}

/** The period before (−1) or after (+1). The day kept is the period's first. */
export function shiftPeriod(period: Period, delta: number): Period {
  const { first } = periodDays(period);
  if (period.kind === "day") return { kind: "day", day: dayKey(addDays(first, delta)) };
  if (period.kind === "week") return { kind: "week", day: dayKey(addDays(first, 7 * delta)) };
  return { kind: "month", day: dayKey(addMonths(first, delta)) };
}

/** The same moment seen as another kind of period: the day is kept. */
export function asKind(period: Period, kind: PeriodKind): Period {
  return { kind, day: period.day };
}

/** Whether the period has already begun — the history has no future to show. */
export function hasBegun(period: Period, now: Date, timeZone: string | null | undefined): boolean {
  return Date.parse(periodRange(period, timeZone).start) <= now.getTime();
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = MONTHS.map((m) => m.slice(0, 3));
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Thu 9 Oct 2026", "6 – 12 Oct 2026", "October 2026". Written out, never `toLocaleString`. */
export function periodLabel(period: Period): string {
  const { first, next } = periodDays(period);
  if (period.kind === "day") return `${WEEKDAYS[weekdayOf(first)]} ${first.day} ${SHORT[first.month - 1]} ${first.year}`;
  if (period.kind === "month") return `${MONTHS[first.month - 1]} ${first.year}`;
  const last = addDays(next, -1);
  if (first.year !== last.year) return `${first.day} ${SHORT[first.month - 1]} ${first.year} – ${last.day} ${SHORT[last.month - 1]} ${last.year}`;
  if (first.month !== last.month) return `${first.day} ${SHORT[first.month - 1]} – ${last.day} ${SHORT[last.month - 1]} ${last.year}`;
  return `${first.day} – ${last.day} ${SHORT[first.month - 1]} ${first.year}`;
}

/** A short name for a file: "2026-10-09", "week-2026-10-06", "2026-10". */
export function periodSlug(period: Period): string {
  const { first } = periodDays(period);
  if (period.kind === "day") return dayKey(first);
  if (period.kind === "week") return `week-${dayKey(first)}`;
  return `${first.year}-${pad(first.month)}`;
}

/** `?period=week&day=2026-10-09`, validated: a month, today, by default. */
export function parsePeriod(
  kind: string | null | undefined,
  day: string | null | undefined,
  now: Date,
  timeZone: string | null | undefined,
): Period {
  const k = (PERIOD_KINDS as readonly string[]).includes(kind ?? "") ? (kind as PeriodKind) : "month";
  const d = parseDay(day) ? (day as string) : todayIn(now, timeZone);
  return { kind: k, day: d };
}

// ---------------------------------------------------------------------------
// Entries, chains, and what each says
// ---------------------------------------------------------------------------

/** Within `[start, end)` by when it was decided. */
export function decidedWithin(entry: Pick<ScoreEntry, "decided_at">, range: Range): boolean {
  const at = Date.parse(entry.decided_at);
  return at >= Date.parse(range.start) && at < Date.parse(range.end);
}

/** Oldest first, in the order they were written when two share a moment. */
export function chronological<T extends Pick<ScoreEntry, "decided_at" | "seq">>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => Date.parse(a.decided_at) - Date.parse(b.decided_at) || a.seq - b.seq);
}

/** Each entry that has been corrected, mapped to the correction that reverses it. */
export function correctionsOf(entries: readonly ScoreEntry[]): Map<string, ScoreEntry> {
  const map = new Map<string, ScoreEntry>();
  for (const entry of entries) if (entry.corrects) map.set(entry.corrects, entry);
  return map;
}

/** What a correction's cause means, in words. */
export function causeLabel(cause: CorrectionCause | null): string {
  switch (cause) {
    case "by_hand":
      return "corrected by hand";
    case "verdict_undone":
      return "the verdict was taken back";
    case "task_dismissed":
      return "the task was dismissed";
    case "task_restored":
      return "the task was restored — it counts again";
    case "bonus_member_lost":
      return "one of the five no longer counts";
    case "excused":
      return "excused, before this history began";
    case "deadline_moved":
      return "the deadline was moved, before this history began";
    default:
      return "corrected";
  }
}

/** Why it moved, in words — the reason column everywhere. */
export function reasonLabel(entry: Pick<ScoreEntry, "reason" | "correction_cause">): string {
  switch (entry.reason) {
    case "approved_late":
      return "Approved late";
    case "disapproved":
      return "Disapproved";
    case "on_time_bonus":
      return "5 tasks approved on time";
    case "missed_deadline":
      return "Missed the deadline (before reviews)";
    case "correction":
      return `Correction — ${causeLabel(entry.correction_cause)}`;
  }
}

/** The viewer, as the history needs them: their Discord id, and whether they are Lucky35. */
export type HistoryViewer = { discordId: string; admin: boolean };

/**
 * Whether the viewer may add a correction to this entry: it is the latest
 * word in its chain (an entry is corrected once — correct the correction to
 * put it back), and they are Lucky35 or decided it. The database checks the
 * same (`tt_correct_score`); this only decides what is offered.
 */
export function canCorrect(entry: ScoreEntry, corrections: ReadonlyMap<string, ScoreEntry>, viewer: HistoryViewer): boolean {
  if (corrections.has(entry.id)) return false;
  if (viewer.admin) return true;
  return viewer.discordId !== "" && entry.decided_by_discord_id === viewer.discordId;
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

/** What a set of entries adds up to. */
export type Tally = {
  /** Plus and minus together. */
  score: number;
  /** The sum of the negative entries (≤ 0), and how many. */
  minus: number;
  minusCount: number;
  /** The sum of the positive entries (≥ 0), and how many. */
  plus: number;
  plusCount: number;
};

export const EMPTY_TALLY: Tally = { score: 0, minus: 0, minusCount: 0, plus: 0, plusCount: 0 };

export function tallyOf(entries: readonly Pick<ScoreEntry, "amount">[]): Tally {
  const amounts = entries.map(amountOf);
  const minus = amounts.filter((a) => a < 0);
  const plus = amounts.filter((a) => a > 0);
  return { score: sum(amounts), minus: sum(minus), minusCount: minus.length, plus: sum(plus), plusCount: plus.length };
}

/** Which side of a tally: what its Minus or its Plus figure is made of. */
export type Sign = "minus" | "plus";

/**
 * The entries one side of a tally counted (Lucky35, 2026-10-18: "click on the
 * minuses and see what were the missed tasks") — exactly those, so the list
 * a figure opens always matches the figure.
 */
export function entriesOfSign<T extends Pick<ScoreEntry, "amount">>(entries: readonly T[], sign: Sign): T[] {
  return entries.filter((entry) => (sign === "minus" ? amountOf(entry) < 0 : amountOf(entry) > 0));
}

/** "10 Oct", in the viewer's zone. */
function shortDay(iso: string, timeZone: string | null | undefined): string {
  const when = new Date(iso);
  const format = (zone: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "numeric", month: "short" }).format(when);
  try {
    return format(timeZone || "UTC");
  } catch {
    return format("UTC");
  }
}

/** How far past the deadline: "3 h late", "2 days late". */
function lateBy(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1) return "under an hour late";
  if (hours < 24) return `${Math.round(hours)} h late`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} late`;
}

/**
 * What a −1 for lateness was judged on: the deadline, and when the work was
 * reported done — "due 10 Oct · reported done 12 Oct · 2 days late". A miss
 * from before reviews has no report: "due 6 Oct · missed". Null when the
 * records behind it cannot be read.
 */
export function lateLine(deadline: string | null | undefined, finished: string | null | undefined, timeZone: string | null | undefined): string | null {
  if (!deadline || Number.isNaN(Date.parse(deadline))) return null;
  const due = `due ${shortDay(deadline, timeZone)}`;
  if (!finished || Number.isNaN(Date.parse(finished))) return `${due} · missed`;
  const late = Date.parse(finished) - Date.parse(deadline);
  return `${due} · reported done ${shortDay(finished, timeZone)}${late > 0 ? ` · ${lateBy(late)}` : ""}`;
}

/** A person's tally — over everything, or within a range. */
export function tallyFor(entries: readonly ScoreEntry[], person: string, range?: Range): Tally {
  return tallyOf(entries.filter((e) => e.person_discord_id === person && (!range || decidedWithin(e, range))));
}

/** A person's score at the end of a range — or now: the sum of everything before it. */
export function scoreBy(entries: readonly ScoreEntry[], person: string, until?: string): number {
  const limit = until ? Date.parse(until) : Number.POSITIVE_INFINITY;
  return sum(entries.filter((e) => e.person_discord_id === person && Date.parse(e.decided_at) < limit).map(amountOf));
}

/** "+1 from 2 · −3 from 3" — what a tally is made of, for a tooltip. */
export function tallyText(tally: Tally): string {
  return `${formatPoints(tally.plus)} from ${tally.plusCount} · ${formatPoints(tally.minus)} from ${tally.minusCount}`;
}

/** One person's line for a period, with the entries behind it. */
export type PersonTotals = Tally & {
  person: string;
  name: string;
  /** Their score at the end of the period: everything up to then. */
  scoreToDate: number;
  /** The period's entries, oldest first. */
  entries: ScoreEntry[];
};

/** The latest name an entry gives a person, or their id. */
export function nameFromEntries(entries: readonly ScoreEntry[], person: string): string {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.person_discord_id === person && entry.person_name) return entry.person_name;
  }
  return person;
}

/**
 * Every person in `people` — or everyone with an entry — for one period:
 * their minus and plus points in it, the entries underneath, and their score
 * to date. A person with no entries in the period still has a line (zeros),
 * so a quiet week reads as a quiet week. By name.
 */
export function totalsFor(
  entries: readonly ScoreEntry[],
  range: Range,
  { people, nameOf }: { people?: readonly string[]; nameOf?: (person: string) => string | null } = {},
): PersonTotals[] {
  const who = people ?? [...new Set(entries.map((e) => e.person_discord_id))];
  return who
    .map((person): PersonTotals => {
      const inPeriod = chronological(entries.filter((e) => e.person_discord_id === person && decidedWithin(e, range)));
      return {
        ...tallyOf(inPeriod),
        person,
        name: nameOf?.(person) || nameFromEntries(entries, person),
        scoreToDate: scoreBy(entries, person, range.end),
        entries: inPeriod,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// CSV — for raise and bonus reviews
// ---------------------------------------------------------------------------

/**
 * One CSV field. Quoted when it must be; and text that a spreadsheet would
 * run as a formula (=, +, −, @ first) is defused with a leading apostrophe —
 * a note is free text typed by people. Numbers pass as numbers.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(cells: ReadonlyArray<string | number | null | undefined>): string {
  return cells.map(csvCell).join(",");
}

/** "2026-10-09 14:05" in the zone — sortable, and what the screen's date is. */
export function csvTime(iso: string, timeZone: string | null | undefined): string {
  const p = zonedParts(new Date(iso), zoneOrUtc(timeZone));
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

export const HISTORY_CSV_COLUMNS = [
  "Date",
  "Person",
  "Discord ID",
  "Points",
  "Reason",
  "Note",
  "Tasks",
  "Task links",
  "Decided by",
  "Corrects entry",
  "Corrected by entry",
  "Entry ID",
] as const;

/**
 * The entries, one line each, oldest first — RFC 4180, CRLF. `taskUrl` makes
 * each task a link (the board's `?task=`). Times are in `timeZone`, named in
 * the header so nobody reads them as UTC.
 */
export function historyCsv(
  entries: readonly ScoreEntry[],
  {
    timeZone,
    taskUrl,
    corrections,
  }: { timeZone: string; taskUrl: (taskId: string) => string; corrections?: ReadonlyMap<string, ScoreEntry> },
): string {
  const header = HISTORY_CSV_COLUMNS.map((column) => (column === "Date" ? `Date (${timeZone})` : column));
  const lines = chronological(entries).map((entry) =>
    csvLine([
      csvTime(entry.decided_at, timeZone),
      entry.person_name ?? "",
      entry.person_discord_id,
      amountOf(entry),
      reasonLabel(entry),
      entry.note ?? "",
      entry.task_titles.join(" | "),
      entry.task_ids.map(taskUrl).join(" "),
      entry.decided_by_name ?? (entry.decided_by_discord_id ? entry.decided_by_discord_id : "the tracker"),
      entry.corrects ?? "",
      corrections?.get(entry.id)?.id ?? "",
      entry.id,
    ]),
  );
  return [csvLine(header), ...lines].join("\r\n") + "\r\n";
}

export const TOTALS_CSV_COLUMNS = [
  "Person",
  "Discord ID",
  "Period",
  "From",
  "To",
  "Minus entries",
  "Minus points",
  "Plus entries",
  "Plus points",
  "Net",
  "Score to date",
] as const;

/** One line per person for the period — the same figures as the screen's table. */
export function totalsCsv(totals: readonly PersonTotals[], period: Period, timeZone: string): string {
  const { first, next } = periodDays(period);
  const last = addDays(next, -1);
  const lines = totals.map((t) =>
    csvLine([t.name, t.person, periodLabel(period), dayKey(first), dayKey(last), t.minusCount, t.minus, t.plusCount, t.plus, t.score, t.scoreToDate]),
  );
  return [csvLine(TOTALS_CSV_COLUMNS.map((c) => (c === "From" || c === "To" ? `${c} (${timeZone})` : c))), ...lines].join("\r\n") + "\r\n";
}

/** "score-history-minh-2026-10.csv" — safe on every file system. */
export function csvFileName(kind: "history" | "totals", who: string, period: Period): string {
  const name = who
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `score-${kind}-${name || "everyone"}-${periodSlug(period)}.csv`;
}
