/**
 * Board grouping — pure, so it is testable.
 *
 * `vitest.config.mts` collects test files under `lib` only and there is no jsdom
 * in this repo, so anything that lives inside `components/` has no
 * machine-checkable acceptance. Every rule the card track applies — which
 * filter shows what, what counts as missing, whose task a row is, which card
 * holds focus — is written here and pinned by `lib/board.test.ts`.
 *
 * Nothing in this module touches `Date.now()`, `localStorage` or React. `now` is
 * always a parameter precisely so a test can pin it.
 */

import { PROJECT_COLORS } from "./colors";
import { fromZoned, isValidTimeZone, zonedParts } from "./deadlines";
import { isOverdue } from "./reminders";
import type { Priority, Task } from "./types/database";

/**
 * The last millisecond of `now`'s day, in `timeZone` — the person's own zone
 * (`tt_profiles.timezone`), so "due today" means their today. Without a zone,
 * the machine's. The board passes the zone: on the server that is UTC, in the
 * browser it is wherever the person is, and the two must render the same page
 * or React throws the server's away (2026-09-30 audit).
 */
export function endOfDay(now: Date, timeZone?: string): Date {
  if (!timeZone || !isValidTimeZone(timeZone)) {
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return end;
  }
  const today = zonedParts(now, timeZone);
  const next = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  const midnight = fromZoned(
    { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0, minute: 0 },
    timeZone,
  );
  return new Date(midnight.getTime() - 1);
}

/**
 * Which deadline bucket a task falls in. Moved verbatim out of
 * `components/tracker.tsx`; the urgency arithmetic itself stays in
 * `lib/reminders.ts` and is imported, never restated.
 */
export function bucketOf(task: Task, now: Date, timeZone?: string): string {
  if (task.status !== "open") return "closed";
  if (!task.deadline) return "undated";
  if (isOverdue(task.deadline, now)) return "overdue";

  const deadline = new Date(task.deadline);
  if (deadline <= endOfDay(now, timeZone)) return "today";

  const inSevenDays = new Date(now.getTime() + 7 * 86_400_000);
  return deadline <= inSevenDays ? "week" : "later";
}

/**
 * The grouping key: the Discord snowflake of the person the work was handed to.
 *
 * A snowflake is a stable numeric id, so there is nothing to case-fold and
 * nothing to collapse — it is trimmed and otherwise used raw. `""` means the
 * task carries nobody.
 */
export function personKeyOf(task: Task): string {
  return (task.assignee_discord_id ?? "").trim();
}

/**
 * The display label, which is only ever a label — never a key.
 *
 * `||` and not `??` is deliberate: an empty-string or whitespace-only name must
 * fall through to the id rather than render a blank card title. Rows repaired by
 * the offline backfill carry an id and a null name, so a card titled with a raw
 * snowflake is correct behaviour, not a bug.
 */
export function personLabelOf(task: Task): string {
  return task.assignee_name?.trim() || task.assignee_discord_id || "";
}

/**
 * The interface accent. Violet is never data (DESIGN.md), so it is filtered out
 * of the identity palette before a person can ever be given it.
 *
 * `PROJECT_COLORS` stores the hex uppercase while the token is written lowercase
 * in `app/globals.css`, so the comparison is case-insensitive.
 */
const ACCENT_HEX = "#7c5cff";

const PERSON_COLORS: string[] = PROJECT_COLORS.filter(
  (hex) => hex.toLowerCase() !== ACCENT_HEX,
);

/**
 * Deterministic identity colour for a person key — the same hash as
 * `colorForKey` in `lib/colors.ts`, but over the accent-free palette.
 *
 * The modulus is taken against the FILTERED length (15). Filtering the array and
 * then indexing it with `% 16` hands back `undefined` for one key in sixteen —
 * a colourless dot, no error, found in production rather than in review.
 */
export function personColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return PERSON_COLORS[hash % PERSON_COLORS.length];
}

/** Where each bucket sits when a card sorts its lines. */
const BUCKET_RANK: Record<string, number> = {
  overdue: 0,
  today: 1,
  week: 2,
  later: 3,
  undated: 4,
  closed: 5,
};

function rankOf(task: Task, now: Date, timeZone?: string): number {
  const rank = BUCKET_RANK[bucketOf(task, now, timeZone)];
  return rank === undefined ? BUCKET_RANK.closed : rank;
}

function timeOf(iso: string | null): number | null {
  if (!iso) return null;
  const value = new Date(iso).getTime();
  return Number.isNaN(value) ? null : value;
}

/**
 * The order cards run in along the track and in a person's view: open first,
 * then by deadline bucket (overdue → today → week → later → undated), then
 * deadline ascending with nulls last, then newest first. Closed tasks always
 * sort last.
 */
export function sortForCard(tasks: Task[], now: Date, timeZone?: string): Task[] {
  return [...tasks].sort((a, b) => {
    const aClosed = a.status !== "open" ? 1 : 0;
    const bClosed = b.status !== "open" ? 1 : 0;
    if (aClosed !== bClosed) return aClosed - bClosed;

    const rankA = rankOf(a, now, timeZone);
    const rankB = rankOf(b, now, timeZone);
    if (rankA !== rankB) return rankA - rankB;

    const deadlineA = timeOf(a.deadline);
    const deadlineB = timeOf(b.deadline);
    if (deadlineA !== deadlineB) {
      if (deadlineA === null) return 1;
      if (deadlineB === null) return -1;
      return deadlineA - deadlineB;
    }

    return (timeOf(b.created_at) ?? 0) - (timeOf(a.created_at) ?? 0);
  });
}

/**
 * The same substring match the search box has always applied, plus the names
 * on the task — and the name the board shows for its person, which may come
 * only from `tt_people.display_name` (`names`, keyed by snowflake): a search
 * for what the card says must find the card.
 */
export function matchesQuery(task: Task, needle: string, names?: ReadonlyMap<string, string>): boolean {
  if (!needle) return true;
  return [
    task.title,
    task.detail,
    task.source_excerpt,
    task.assignee_name,
    task.owner_name,
    task.counterparty,
    names?.get(personKeyOf(task)),
  ].some((value) => (value ?? "").toLowerCase().includes(needle));
}

// ---------------------------------------------------------------------------
// Whose task is this, from where the viewer sits
// ---------------------------------------------------------------------------

/**
 * Who is looking at the board. Two ids, because a task names its owner by the
 * auth uid (`tt_tasks.user_id`) and its assignee by a Discord snowflake.
 */
export type Viewer = {
  /** `profile.id` — the auth uid, which is what `tt_tasks.user_id` holds. */
  ownerId: string;
  /** `profile.discord_user_id`, trimmed. `""` when the account has no Discord identity yet. */
  selfId: string;
};

/**
 * A row somebody ELSE owns, readable only because it was given to the viewer
 * (`20260928_01_assignee_reads_their_tasks.sql`). Every control that writes is
 * withheld from it: the database would refuse the write anyway.
 */
export function isShared(task: Task, viewer: Viewer): boolean {
  return task.user_id !== viewer.ownerId;
}

function isSelf(key: string, viewer: Viewer): boolean {
  return viewer.selfId !== "" && key === viewer.selfId;
}

/**
 * Work that is on the viewer: given to them by someone else, asked of them, or
 * taken on themselves.
 *
 * Another account's row counts only when its assignee really is the viewer.
 * That is the only kind the database serves, but this does not lean on it.
 */
export function isAssignedToViewer(task: Task, viewer: Viewer): boolean {
  if (!isShared(task, viewer) && task.direction === "received") return true;
  return isSelf(personKeyOf(task), viewer);
}

/** Work the viewer handed to somebody else, or has not handed to anyone yet. */
export function isAskedByViewer(task: Task, viewer: Viewer): boolean {
  // Asked through somebody else's bot: on their board, readable because the
  // viewer asked for it (Lucky35, 2026-10-06).
  if (isShared(task, viewer)) return askedByViewer(task, viewer);
  if (task.direction !== "given") return false;
  return !isSelf(personKeyOf(task), viewer);
}

/**
 * Another account's row the viewer can read because THEY asked for it — of
 * that account's owner, or through its bot (`20261006_02`). Read only: the
 * owner's bot reminds, and the owner reviews.
 */
export function askedByViewer(task: Task, viewer: Viewer): boolean {
  return isShared(task, viewer) && viewer.selfId !== "" && task.requested_by_discord_id === viewer.selfId;
}

/**
 * Where a card came from, in a few words — or null when it is plainly the
 * viewer's own: "From Luka", "You asked · on Luka's board", "Cenri asked you",
 * "Cenri asked".
 */
export function originLine(task: Task, viewer: Viewer): string | null {
  const owner = task.owner_name ?? "someone else";
  if (isShared(task, viewer)) {
    return askedByViewer(task, viewer) && !isSelf(personKeyOf(task), viewer) ? `You asked · on ${owner}'s board` : `From ${owner}`;
  }
  if (task.direction === "received") return `${task.counterparty ?? "Someone"} asked you`;
  if (task.requested_by_name) return `${task.requested_by_name} asked`;
  return null;
}

/**
 * What a card must say it is missing, so it can be fixed on the board.
 *
 * A tagged message with no recognisable person or deadline still becomes a
 * task — it is never dropped — and this is how the gap is shown instead. An
 * assignee is only missing on work the viewer handed out: a received task is
 * already on the viewer, and a shared one is on the viewer by definition.
 */
export function missingOf(task: Task, viewer: Viewer): { assignee: boolean; deadline: boolean } {
  return {
    assignee: !isShared(task, viewer) && task.direction === "given" && personKeyOf(task) === "",
    deadline: task.status === "open" && !task.deadline,
  };
}

// ---------------------------------------------------------------------------
// The track
// ---------------------------------------------------------------------------

export type BoardFilter = "all" | "mine" | "asked" | "review" | "closed";

/**
 * How many closed tasks the board loads — the most recently closed. Open work
 * is always loaded in full; history past this stays in the database, and the
 * "Done & dismissed" filter says so rather than looking complete.
 */
export const CLOSED_TASKS_LOADED = 300;

export const BOARD_FILTERS: Array<{ key: BoardFilter; label: string; title: string }> = [
  { key: "all", label: "All", title: "Every open task" },
  { key: "mine", label: "Assigned to me", title: "Work that is on you — given to you, or taken on yourself" },
  { key: "asked", label: "I asked for", title: "Work you handed to somebody else" },
  { key: "review", label: "To review", title: "Work reported done, with its proof — approve it, disapprove it, or give more time" },
  { key: "closed", label: "Done & dismissed", title: "Finished work, work that failed review, and anything dismissed as not a task" },
];

function closedAt(task: Task): number {
  return timeOf(task.completed_at) ?? timeOf(task.updated_at) ?? 0;
}

/**
 * The cards on the track, in order.
 *
 * Open work runs most urgent first — the same order a person's card always
 * used. Closed work runs most recently closed first, because that is what the
 * person looking at it just did.
 */
export function filterTasks(
  tasks: Task[],
  {
    filter,
    query,
    viewer,
    now,
    timeZone,
    names,
    view = DEFAULT_VIEW,
  }: {
    filter: BoardFilter;
    query: string;
    viewer: Viewer;
    now: Date;
    timeZone?: string;
    names?: ReadonlyMap<string, string>;
    /** Priority and deadline filters and a sort, on top of the tab (`BoardView`). */
    view?: BoardView;
  },
): Task[] {
  const needle = query.trim().toLowerCase();

  const kept = tasks.filter((task) => {
    if (!matchesView(task, view, timeZone)) return false;
    // Waiting for the viewer's review: reported, not yet decided — its own
    // lens, oldest first, so nothing waits forever.
    if (filter === "review") return toReview(task, viewer) && matchesQuery(task, needle, names);
    const open = task.status === "open";
    if (filter === "closed" ? open : !open) return false;
    if (filter === "mine" && !isAssignedToViewer(task, viewer)) return false;
    if (filter === "asked" && !isAskedByViewer(task, viewer)) return false;
    return matchesQuery(task, needle, names);
  });

  const ordered =
    filter === "closed"
      ? [...kept].sort((a, b) => closedAt(b) - closedAt(a))
      : filter === "review"
        ? [...kept].sort((a, b) => closedAt(a) - closedAt(b))
        : sortForCard(kept, now, timeZone);
  return sortByView(ordered, view);
}

/**
 * Work the viewer may review: handed to somebody, and the viewer created it —
 * they asked for it through the owner's bot — or owns the board it is on
 * (Lucky35's PO, 2026-10-07: "the reviewer is the task creator"; the owner may
 * always review too). Never their own work: nobody approves themselves.
 */
export function canReview(task: Task, viewer: Viewer): boolean {
  if (task.direction !== "given" || personKeyOf(task) === "") return false;
  if (isSelf(personKeyOf(task), viewer)) return false;
  return !isShared(task, viewer) || askedByViewer(task, viewer);
}

/**
 * Reported done and waiting for the viewer's verdict (Lucky35, 2026-10-04,
 * 2026-10-07): on their own board, or asked for by them on someone else's.
 */
export function toReview(task: Task, viewer: Viewer): boolean {
  return task.status === "done" && task.review_state === "pending" && canReview(task, viewer);
}

// ---------------------------------------------------------------------------
// Priority, sorting and filtering — one view over every tab
//
// Lucky35's PO, 2026-10-07: sort by priority, deadline or date created, either
// way round; filter by priority and by a range of deadline dates; combined with
// each other, with the search box and with whichever tab is open; kept when the
// tab changes or the page reloads (the board stores it in the browser).
// ---------------------------------------------------------------------------

export const PRIORITIES: ReadonlyArray<{ key: Priority; label: string }> = [
  { key: "high", label: "High" },
  { key: "medium", label: "Medium" },
  { key: "low", label: "Low" },
];

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

/** A task's priority — medium when none was ever set (`20261007_01`). */
export function priorityOf(task: Pick<Task, "priority">): Priority {
  return task.priority === "high" || task.priority === "low" ? task.priority : "medium";
}

export function isPriority(value: unknown): value is Priority {
  return value === "high" || value === "medium" || value === "low";
}

export type SortKey = "default" | "priority" | "deadline" | "created";
export type SortDir = "asc" | "desc";

export type BoardView = {
  sort: SortKey;
  dir: SortDir;
  /** The priorities shown; empty is every one. */
  priorities: Priority[];
  /** Deadline from / to, as calendar days in the person's zone ("2026-10-07"); null is open-ended. */
  from: string | null;
  to: string | null;
};

export const DEFAULT_VIEW: BoardView = { sort: "default", dir: "asc", priorities: [], from: null, to: null };

/** How each sort reads, both ways round — what the board's menu offers. */
export const SORT_OPTIONS: ReadonlyArray<{ sort: SortKey; dir: SortDir; label: string }> = [
  { sort: "default", dir: "asc", label: "Most urgent first" },
  { sort: "priority", dir: "desc", label: "Priority: high → low" },
  { sort: "priority", dir: "asc", label: "Priority: low → high" },
  { sort: "deadline", dir: "asc", label: "Deadline: soonest first" },
  { sort: "deadline", dir: "desc", label: "Deadline: latest first" },
  { sort: "created", dir: "desc", label: "Created: newest first" },
  { sort: "created", dir: "asc", label: "Created: oldest first" },
];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A stored view, checked: anything it cannot use falls back to the default. */
export function parseView(raw: unknown): BoardView {
  if (!raw || typeof raw !== "object") return DEFAULT_VIEW;
  const value = raw as Record<string, unknown>;
  const sort: SortKey = ["default", "priority", "deadline", "created"].includes(value.sort as string) ? (value.sort as SortKey) : "default";
  const dir: SortDir = value.dir === "desc" ? "desc" : "asc";
  const priorities = Array.isArray(value.priorities)
    ? PRIORITIES.map((p) => p.key).filter((key) => (value.priorities as unknown[]).includes(key))
    : [];
  const day = (v: unknown) => (typeof v === "string" && DAY.test(v) ? v : null);
  let from = day(value.from);
  let to = day(value.to);
  if (from && to && from > to) [from, to] = [to, from];
  return { sort, dir: sort === "default" ? "asc" : dir, priorities, from, to };
}

/** Whether the view narrows or reorders anything. */
export function viewIsDefault(view: BoardView): boolean {
  return view.sort === "default" && view.priorities.length === 0 && !view.from && !view.to;
}

/** The first and last instant of a calendar day in the person's zone. */
function dayBounds(day: string, timeZone?: string): { start: number; end: number } {
  const [year, month, date] = day.split("-").map(Number);
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC";
  const start = fromZoned({ year, month, day: date, hour: 0, minute: 0 }, zone).getTime();
  const next = new Date(Date.UTC(year, month - 1, date + 1));
  const end =
    fromZoned({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0, minute: 0 }, zone).getTime() - 1;
  return { start, end };
}

/** Whether a task passes the view's filters. A deadline range leaves out tasks with no deadline. */
export function matchesView(task: Task, view: BoardView, timeZone?: string): boolean {
  if (view.priorities.length > 0 && !view.priorities.includes(priorityOf(task))) return false;
  if (!view.from && !view.to) return true;
  const due = timeOf(task.deadline);
  if (due === null) return false;
  if (view.from && due < dayBounds(view.from, timeZone).start) return false;
  if (view.to && due > dayBounds(view.to, timeZone).end) return false;
  return true;
}

/**
 * The view's order on top of the tab's own — a stable sort, so ties keep the
 * tab's order (most urgent, or most recently closed). Tasks with no deadline
 * go last when sorting by deadline, whichever way round.
 */
export function sortByView(tasks: Task[], view: BoardView): Task[] {
  if (view.sort === "default") return tasks;
  const sign = view.dir === "desc" ? -1 : 1;
  return [...tasks].sort((a, b) => {
    if (view.sort === "priority") return sign * (PRIORITY_RANK[priorityOf(b)] - PRIORITY_RANK[priorityOf(a)]);
    if (view.sort === "deadline") {
      const x = timeOf(a.deadline);
      const y = timeOf(b.deadline);
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return sign * (x - y);
    }
    return sign * ((timeOf(a.created_at) ?? 0) - (timeOf(b.created_at) ?? 0));
  });
}

/**
 * Which card holds focus: the one asked for when it is still on the track,
 * otherwise the first. The detail area always shows this card, so a filter or
 * a search that removes the focused task moves focus rather than leaving the
 * detail describing a card that is no longer there.
 */
export function resolveFocus(ids: string[], wanted: string | null): string | null {
  if (wanted !== null && ids.includes(wanted)) return wanted;
  return ids[0] ?? null;
}

/**
 * Where focus goes when the card in focus is about to leave the track — done,
 * dismissed, deleted: the card after it, or the one before it at the end of
 * the track. Never back to the first card, which lost the person's place and
 * put a different task's "Mark done" under a double-click (2026-09-30 audit).
 */
export function focusAfterRemoval(ids: string[], removed: string): string | null {
  const at = ids.indexOf(removed);
  if (at === -1) return null;
  return ids[at + 1] ?? ids[at - 1] ?? null;
}

/** One step left (-1) or right (+1) along the track, stopping at either end. */
export function stepFocus(ids: string[], current: string | null, delta: number): string | null {
  if (ids.length === 0) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  const next = Math.min(ids.length - 1, Math.max(0, (at === -1 ? 0 : at) + delta));
  return ids[next];
}

/** The strip of counts at the top of the board. Open work only. */
export function boardFigures(tasks: Task[], viewer: Viewer, now: Date, timeZone?: string) {
  const open = tasks.filter((task) => task.status === "open");
  return {
    open: open.length,
    overdue: open.filter((task) => isOverdue(task.deadline, now)).length,
    today: open.filter((task) => bucketOf(task, now, timeZone) === "today").length,
    undated: open.filter((task) => missingOf(task, viewer).deadline).length,
    unassigned: open.filter((task) => missingOf(task, viewer).assignee).length,
    assignedToMe: open.filter((task) => isAssignedToViewer(task, viewer)).length,
    toReview: tasks.filter((task) => toReview(task, viewer)).length,
  };
}

// ---------------------------------------------------------------------------
// Picking a person by hand
// ---------------------------------------------------------------------------

export type KnownPerson = { id: string; name: string };

/**
 * Everybody the viewer has handed work to before, for fixing a task that
 * arrived without an assignee.
 *
 * Built from the viewer's own tasks and their own `tt_people` rows — never from
 * a shared task, whose assignee is the viewer, and never from Discord, which
 * this module cannot reach. Keyed by snowflake; a name is only a label, and the
 * first non-empty one seen wins. The viewer is left out: the picker offers
 * "Me" on its own.
 */
export function knownPeople(
  tasks: Task[],
  people: Array<{ discord_user_id: string; display_name: string }>,
  viewer: Viewer,
): KnownPerson[] {
  const names = new Map<string, string>();

  const offer = (id: string, name: string | null | undefined) => {
    const key = id.trim();
    if (key === "" || isSelf(key, viewer)) return;
    const label = (name ?? "").trim();
    if (!names.has(key) || (names.get(key) === "" && label !== "")) names.set(key, label);
  };

  for (const task of tasks) {
    if (isShared(task, viewer)) continue;
    offer(personKeyOf(task), task.assignee_name);
  }
  for (const person of people) offer(person.discord_user_id, person.display_name);

  return Array.from(names.entries())
    .map(([id, name]) => ({ id, name: name || `@${id}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// What a card says
// ---------------------------------------------------------------------------

/**
 * How soon a task is due, as the three colours this product spends its budget
 * on: overdue is rose, due today is amber, everything else is neutral. One
 * definition, read by every countdown on the page, so a card and the detail
 * beside it can never disagree about where "today" ends.
 */
export type Urgency = "none" | "overdue" | "today" | "later";

export function urgencyOf(task: Task, now: Date, timeZone?: string): Urgency {
  if (!task.deadline) return "none";
  if (task.status === "open" && isOverdue(task.deadline, now)) return "overdue";
  return bucketOf(task, now, timeZone) === "today" ? "today" : "later";
}

// ---------------------------------------------------------------------------
// Times on the page, in the person's own zone
//
// Every time the board prints is formatted in `tt_profiles.timezone` with a
// fixed locale, never with the machine's: the server renders in UTC and the
// browser wherever the person is, and a page the two render differently is
// thrown away by React on arrival — and a `title` keeps the server's version
// for good (2026-09-30 audit).
// ---------------------------------------------------------------------------

function zoneOrUtc(timeZone: string | null | undefined): string {
  return timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC";
}

/** "Oct 3, 2026, 5:00 PM" in the person's zone. */
export function formatWhen(iso: string | null | undefined, timeZone: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zoneOrUtc(timeZone),
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** An instant as the `datetime-local` value a person in `timeZone` would type: "2026-10-03T17:00". */
export function toZonedInput(iso: string | null | undefined, timeZone: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const p = zonedParts(date, zoneOrUtc(timeZone));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(p.year).padStart(4, "0")}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** A `datetime-local` value, read as wall time in `timeZone`, back to an instant — or null. */
export function fromZonedInput(value: string, timeZone: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value ?? "");
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const at = fromZoned({ year, month, day, hour, minute }, zoneOrUtc(timeZone));
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * The next moment the board's own clock has to tick: the soonest deadline of an
 * open task still ahead of `now`, as epoch ms — or null when none is.
 *
 * Lucky35, 2026-09-29: a card's countdown turned "Overdue" on the second while
 * the counts and the order beside it waited for the 30-second clock, so for up
 * to half a minute the card and the number next to it disagreed — and people
 * believed the number. The board now also ticks at exactly this instant, and
 * the countdown takes its overdue state from the board, so there is one clock
 * deciding "overdue" on the page, not two.
 */
export function nextDeadlineAfter(tasks: Task[], now: Date): number | null {
  let soonest: number | null = null;
  for (const task of tasks) {
    if (task.status !== "open" || !task.deadline) continue;
    const at = new Date(task.deadline).getTime();
    if (Number.isNaN(at) || at <= now.getTime()) continue;
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}

/**
 * The person whose name a card carries: who the work was given to. On work
 * that is on the viewer — received, or given to them from another account —
 * that is the viewer themselves. `""` when nobody is on it yet.
 */
export function personOnCard(task: Task, viewer: Viewer): string {
  if (!isShared(task, viewer) && task.direction === "received") return viewer.selfId;
  return personKeyOf(task);
}

// ---------------------------------------------------------------------------
// My tasks — one place for everything on the viewer
//
// Lucky35, 2026-10-02: the people who work with Luka had to hunt through DMs
// and channels to find what was on them. "My tasks" gathers it: everything
// given to the viewer by anyone using the tracker — in a channel or by DM, from
// any account — and everything on them in their own account, by urgency.
// ---------------------------------------------------------------------------

/** How long finished work stays under "Finished" on My tasks. */
export const MINE_DONE_DAYS = 14;

export type MineGroupKey = "overdue" | "today" | "week" | "later" | "undated" | "done";

export type MineGroup = { key: MineGroupKey; label: string; tasks: Task[] };

const MINE_LABELS: Record<MineGroupKey, string> = {
  overdue: "Overdue",
  today: "Due today",
  week: "This week",
  later: "Later",
  undated: "No deadline",
  done: `Finished in the last ${MINE_DONE_DAYS} days`,
};

const MINE_ORDER: MineGroupKey[] = ["overdue", "today", "week", "later", "undated", "done"];

/** The viewer's work, grouped by how soon — empty groups left out. */
export function groupMine(tasks: Task[], viewer: Viewer, now: Date, timeZone?: string): MineGroup[] {
  const groups = new Map<MineGroupKey, Task[]>(MINE_ORDER.map((key) => [key, []]));
  const since = now.getTime() - MINE_DONE_DAYS * 86_400_000;

  for (const task of sortForCard(tasks.filter((t) => isAssignedToViewer(t, viewer)), now, timeZone)) {
    if (task.status === "open") groups.get(bucketOf(task, now, timeZone) as MineGroupKey)?.push(task);
    else if (task.status === "done" && closedAt(task) >= since) groups.get("done")!.push(task);
  }
  groups.set("done", groups.get("done")!.sort((a, b) => closedAt(b) - closedAt(a)));

  return MINE_ORDER.filter((key) => groups.get(key)!.length > 0).map((key) => ({
    key,
    label: MINE_LABELS[key],
    tasks: groups.get(key)!,
  }));
}

/** Who a task on the viewer came from, in words: "from Luka", "Bao asked you", "you took it on". */
export function originOf(task: Task, viewer: Viewer): string {
  if (isShared(task, viewer)) return `from ${task.owner_name ?? "someone else"}`;
  if (task.direction === "given" && task.requested_by_name) return `${task.requested_by_name} asked, through your bot`;
  if (task.direction === "received") return `${task.counterparty ?? "Someone"} asked you`;
  return "you took it on";
}

/**
 * Everything a person was given, for their view and their "all tasks" grid.
 *
 * For the viewer it is everything on them, including work from other accounts
 * and work asked of them. For anybody else it is only work the viewer handed
 * them — never another account's row, and never received work, which is
 * somebody else's ledger.
 */
export function tasksOfPerson(tasks: Task[], key: string, viewer: Viewer): Task[] {
  const wanted = key.trim();
  if (wanted === "") return [];
  if (isSelf(wanted, viewer)) return tasks.filter((task) => isAssignedToViewer(task, viewer));
  return tasks.filter(
    (task) => !isShared(task, viewer) && task.direction === "given" && personKeyOf(task) === wanted,
  );
}
