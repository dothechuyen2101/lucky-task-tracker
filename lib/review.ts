/**
 * Review of work the assignee says is finished — pure, so it is testable.
 *
 * Lucky35, 2026-10-04: "done" used to mean somebody typed "done", and Luka had
 * no way to say "this isn't finished". The assignee's "done" became a claim
 * that waits for review (`review_state = 'pending'`).
 *
 * Lucky35's PO, 2026-10-07 (task.md): the claim now comes with proof
 * (`lib/proof.ts`), it is not Completed on the rail until someone approves it
 * — it waits at Testing (`PENDING_STAGE`) — and the reviewer has four
 * choices, each of which IS the score (`tt_task_reviews`):
 *
 *   approve, on time    counts towards +0.5 per 5 (cumulative)
 *   approve, late       -1
 *   disapprove          -1, and it REOPENS — back to In progress on a new
 *                       deadline, so the assignee keeps working (PO,
 *                       2026-10-07: there is no "close as failed" any more;
 *                       `disapprove_close` survives only on old verdicts)
 *   extend deadline     no penalty: open again, with a new deadline
 *
 * The tool suggests on time or late from when the work was reported against
 * its deadline; the reviewer may choose the other (decided 2026-10-07). A
 * deadline that passes costs nothing by itself any more — only a verdict does.
 *
 * A verdict keeps what the task was before it (`before`) and what it made of
 * it (`after`), so a click by mistake can be taken back while nothing has
 * happened since (`undoChanges`).
 *
 * The reviewer is whoever created the task: the person who asked for it
 * through the owner's bot, else the owner; the owner may always review
 * (`canReview` in lib/board.ts). Closing work given to someone else yourself
 * is a review too — approving it — so every finish is scored the same way.
 *
 * Imported by client components: nothing here may reach the network, the
 * database or the clock — `now` is passed in.
 */

import { DEFAULT_AUTO_CADENCE_MINUTES } from "@/lib/deadlines";
import { type Schedulable, nextAlertFor } from "@/lib/reminders";
import { IN_PROGRESS_STAGE, MAX_STAGE, stampStages } from "@/lib/stages";
import type { ReviewDecision, Task, TaskReview } from "@/lib/types/database";

/** Where work reopened or extended lands on the rail: being worked on again. */
export const SENT_BACK_STAGE = IN_PROGRESS_STAGE;

/**
 * Where reported work waits: Testing — never Completed, which only an
 * approval reaches (task.md: "No task moves to Completed until the creator
 * approves it").
 */
export const PENDING_STAGE = 3;

/** The longest reason kept on the row and quoted in the DM. */
export const REVIEW_NOTE_MAX = 500;

/**
 * The reviewer hears at once that it is finished (`finishedNotice`); after
 * that, once a day until they decide. Never auto-approved: the verdict is a
 * person's.
 */
export const REVIEW_NUDGE_AFTER_MS = 24 * 3_600_000;
export const REVIEW_NUDGE_EVERY_MS = 24 * 3_600_000;

export const REVIEW_DECISIONS: readonly ReviewDecision[] = [
  "approve_on_time",
  "approve_late",
  "disapprove_close",
  "disapprove_reopen",
  "extend",
];

export function isReviewDecision(value: unknown): value is ReviewDecision {
  return typeof value === "string" && (REVIEW_DECISIONS as readonly string[]).includes(value);
}

/** What a verdict costs: -1 for approving late or disapproving, nothing otherwise. */
export function reviewPenalty(decision: ReviewDecision): number {
  return decision === "approve_late" || decision === "disapprove_close" || decision === "disapprove_reopen" ? 1 : 0;
}

/** Disapproving — which needs a note saying why. */
export function isDisapproval(decision: ReviewDecision): boolean {
  return decision === "disapprove_close" || decision === "disapprove_reopen";
}

/** A verdict that counts towards +0.5 per 5. */
export function countsOnTime(decision: ReviewDecision): boolean {
  return decision === "approve_on_time";
}

/** How a verdict reads, everywhere it is listed. */
export function decisionLabel(decision: ReviewDecision): string {
  switch (decision) {
    case "approve_on_time":
      return "Approved — on time";
    case "approve_late":
      return "Approved — late";
    case "disapprove_close":
      return "Disapproved — closed";
    case "disapprove_reopen":
      return "Disapproved — reopened";
    case "extend":
      return "Deadline extended";
  }
}

type Reviewable = Pick<Task, "status" | "completed_by" | "review_state">;

type ReviewTask = Schedulable &
  Reviewable &
  Pick<
    Task,
    | "stage"
    | "stage_at"
    | "review_rejections"
    | "assignee_overdue_alerts"
    | "completed_at"
    | "title"
    | "assignee_name"
    | "deadline_source"
  >;

/** The assignee said it is finished and nobody has reviewed it yet. */
export function awaitsReview(task: Pick<Task, "status" | "review_state">): boolean {
  return task.status === "done" && task.review_state === "pending";
}

/**
 * Work its assignee closed — waiting for review, or approved. Reopening it is
 * a verdict (disapprove or extend), never a silent reopen: the person who said
 * it was finished hears that it is not.
 */
export function finishedByAssignee(task: Reviewable): boolean {
  return task.status === "done" && task.completed_by === "assignee";
}

/** Approved, or failed: a verdict ended it, and nothing but a new task reopens it. */
export function settledByReview(task: Pick<Task, "status" | "review_state">): boolean {
  return (task.status === "done" && task.review_state === "accepted") || task.status === "failed";
}

/**
 * Work handed to somebody other than its owner: finishing it is reviewed, and
 * moves that person's score. A task the owner took on themselves, one asked of
 * the owner, or one given to nobody is simply done.
 */
export function reviewedWork(task: Pick<Task, "direction" | "assignee_discord_id">, ownerDiscordId: string | null): boolean {
  const assignee = (task.assignee_discord_id ?? "").trim();
  return task.direction === "given" && assignee !== "" && assignee !== (ownerDiscordId ?? "").trim();
}

/**
 * What a reviewer may choose now. Waiting for review: approve (on time or
 * late), disapprove — which reopens it — or extend. Still open — never
 * reported, or overdue and silent — they may approve it themselves (no proof:
 * the reviewer is the one vouching for it) or disapprove it; extending an open
 * task is the deadline's own +1h / +6h / +1 day, not a verdict. Never
 * `disapprove_close`: disapproved work is reopened, never failed (PO,
 * 2026-10-07).
 */
export function reviewChoices(task: Pick<Task, "status" | "review_state">): ReviewDecision[] {
  if (awaitsReview(task)) return ["approve_on_time", "approve_late", "disapprove_reopen", "extend"];
  if (task.status === "open") return ["approve_on_time", "approve_late", "disapprove_reopen"];
  return [];
}

/**
 * Which approval the facts point to: on time when the work was reported by its
 * deadline (when it was not reported, by `now`), or it has none. Only a
 * suggestion — the reviewer chooses.
 */
export function suggestedApproval(
  task: Pick<Task, "status" | "review_state" | "completed_at"> & { deadline: string | Date | null },
  now: Date,
): "approve_on_time" | "approve_late" {
  if (!task.deadline) return "approve_on_time";
  const deadline = task.deadline instanceof Date ? task.deadline.getTime() : Date.parse(task.deadline);
  const finished = awaitsReview(task) && task.completed_at ? Date.parse(task.completed_at) : now.getTime();
  return finished <= deadline ? "approve_on_time" : "approve_late";
}

/** The reason as it is stored and quoted: one paragraph, trimmed, bounded. */
export function cleanNote(note: string | null | undefined): string {
  const text = (note ?? "").replace(/\s+/g, " ").trim();
  return text.length > REVIEW_NOTE_MAX ? `${text.slice(0, REVIEW_NOTE_MAX - 1)}…` : text;
}

/** A verdict as the database keeps it, less what the route knows (ids, reviewer). */
export type ReviewRecord = Pick<
  TaskReview,
  "decision" | "note" | "deadline" | "new_deadline" | "finished_at" | "assignee_discord_id" | "assignee_name" | "task_title"
> & { before?: Partial<Task>; after?: Partial<Task> };

/**
 * The fields a verdict moves — kept before and after it, so it can be taken
 * back exactly (`undoChanges`). `next_alert_at` is not among them: it is
 * derived, never typed, and re-derived on undo.
 */
export const VERDICT_FIELDS = [
  "status",
  "stage",
  "stage_at",
  "completed_at",
  "completed_by",
  "review_state",
  "reviewed_at",
  "review_note",
  "review_rejections",
  "review_nudge_at",
  "deadline",
  "deadline_source",
  "alert_every_minutes",
  "assignee_overdue_alerts",
] as const satisfies ReadonlyArray<keyof Task>;

/** Every verdict field, a missing one as null — so undo clears what the verdict set. */
function snapshot(task: Partial<Task>): Partial<Task> {
  const out: Record<string, unknown> = {};
  for (const field of VERDICT_FIELDS) out[field] = task[field] ?? null;
  return out as Partial<Task>;
}

export type ReviewInput = {
  decision: ReviewDecision;
  /** Why — for a disapproval above all; quoted to the assignee. */
  note?: string | null;
  /** The new deadline, for reopen and extend: required, and after now. */
  deadline?: string | null;
};

export type ReviewResult =
  | { ok: true; changes: Partial<Task>; record: ReviewRecord }
  | { ok: false; error: string };

/**
 * The columns a verdict writes on the task, and the verdict as it is recorded.
 * `next_alert_at` is derived, never typed (CLAUDE.md).
 */
export function reviewChanges(
  task: ReviewTask & Pick<Task, "assignee_discord_id" | "direction">,
  input: ReviewInput,
  now: Date,
  ownerDiscordId: string | null,
): ReviewResult {
  const result = verdictOf(task, input, now, ownerDiscordId);
  if (!result.ok) return result;
  // What it was, and what it becomes: so a verdict given by mistake can be
  // taken back exactly, while nothing has happened since.
  result.record.before = snapshot(task as Partial<Task>);
  result.record.after = snapshot({ ...(task as Partial<Task>), ...result.changes });
  return result;
}

function verdictOf(
  task: ReviewTask & Pick<Task, "assignee_discord_id" | "direction">,
  input: ReviewInput,
  now: Date,
  ownerDiscordId: string | null,
): ReviewResult {
  const { decision } = input;
  if (!reviewChoices(task).includes(decision)) {
    if (decision === "disapprove_close") return { ok: false, error: "Disapproving reopens it now — there is no closing it as failed." };
    if (task.status === "failed") return { ok: false, error: "It was closed as failed — there is nothing left to review." };
    if (task.status === "done" && task.review_state !== "pending") return { ok: false, error: "It is already approved." };
    if (task.status === "dismissed") return { ok: false, error: "It was dismissed as not a task." };
    return { ok: false, error: "Extend an open task with its deadline, not as a review." };
  }

  const stamp = now.toISOString();
  const reason = cleanNote(input.note);
  // The −1 is recorded with its reason, for good (PO, 2026-10-09): no reason,
  // no disapproval. The history's table refuses one too.
  if (isDisapproval(decision) && !reason) {
    return { ok: false, error: "Say why — a disapproval needs a note. It is kept with the −1 in their score history." };
  }
  const reported = awaitsReview(task);
  const record: ReviewRecord = {
    decision,
    note: reason || null,
    deadline: task.deadline ? new Date(task.deadline).toISOString() : null,
    new_deadline: null,
    finished_at: reported ? task.completed_at : null,
    assignee_discord_id: task.assignee_discord_id,
    assignee_name: task.assignee_name,
    task_title: task.title,
  };

  if (decision === "approve_on_time" || decision === "approve_late") {
    return {
      ok: true,
      record,
      changes: {
        status: "done",
        stage: MAX_STAGE,
        stage_at: stampStages(task.stage_at, MAX_STAGE, stamp),
        // Reported: it finished when they said so. Approved straight from open:
        // it finished now, closed by the reviewer.
        completed_at: reported ? task.completed_at : stamp,
        completed_by: reported ? task.completed_by : "owner",
        review_state: "accepted",
        reviewed_at: stamp,
        review_note: reason || null,
        review_nudge_at: null,
        next_alert_at: null,
      },
    };
  }

  if (decision === "disapprove_close") {
    return {
      ok: true,
      record,
      changes: {
        status: "failed",
        // When it ended — what "Done & dismissed" orders by.
        completed_at: stamp,
        review_state: "rejected",
        reviewed_at: stamp,
        review_note: reason || null,
        review_rejections: task.review_rejections + 1,
        review_nudge_at: null,
        next_alert_at: null,
      },
    };
  }

  // Reopen and extend: open again, on a new deadline the reviewer chose.
  const when = input.deadline ? Date.parse(input.deadline) : NaN;
  if (!Number.isFinite(when)) return { ok: false, error: "Set the new deadline first." };
  if (when <= now.getTime()) return { ok: false, error: "Pick a deadline after now — one already passed would be overdue the moment it opens." };
  const due = new Date(when).toISOString();
  record.new_deadline = due;

  const changes: Partial<Task> = {
    status: "open",
    completed_at: null,
    completed_by: null,
    stage: SENT_BACK_STAGE,
    stage_at: stampStages(task.stage_at, SENT_BACK_STAGE, stamp),
    review_state: decision === "extend" ? "extended" : "rejected",
    reviewed_at: stamp,
    review_note: reason || null,
    review_nudge_at: null,
    deadline: due,
    deadline_source: "manual",
    // A deadline that never reminds anyone is not what "here is more time" means.
    alert_every_minutes: task.alert_every_minutes ?? DEFAULT_AUTO_CADENCE_MINUTES,
    // A new run at it: the overdue cap starts again.
    assignee_overdue_alerts: 0,
    ...(decision === "disapprove_reopen" ? { review_rejections: task.review_rejections + 1 } : {}),
  };
  const next = nextAlertFor({ ...task, ...changes } as ReviewTask, now, ownerDiscordId);
  return { ok: true, record, changes: { ...changes, next_alert_at: next ? next.toISOString() : null } };
}

/**
 * The deadline the reopen and extend forms start from: the time the assignee
 * had left when they reported it, given back from now — so a slow review never
 * costs them — or a day from now when none was left.
 */
export function restoredDeadline(task: Finished, now: Date): string {
  const left = timeLeftAtFinish(task);
  return new Date(now.getTime() + (left ?? 24 * 3_600_000)).toISOString();
}

type Finished = { deadline: string | Date | null; completed_at: string | null };

/** How long the assignee had left when they said it was finished; null when none, or none was left. */
export function timeLeftAtFinish(task: Finished): number | null {
  const deadline = task.deadline instanceof Date ? task.deadline.toISOString() : task.deadline;
  if (!deadline || !task.completed_at) return null;
  const left = Date.parse(deadline) - Date.parse(task.completed_at);
  return Number.isFinite(left) && left > 0 ? left : null;
}

// ---------------------------------------------------------------------------
// Taking a verdict back (PO, 2026-10-07: "clicked Completed by mistake")
// ---------------------------------------------------------------------------

/** Two values of a snapshot field the same, however a time was written. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a ?? null) === null || (b ?? null) === null) return (a ?? null) === (b ?? null);
  if (typeof a === "string" && typeof b === "string") {
    const left = Date.parse(a);
    const right = Date.parse(b);
    if (Number.isFinite(left) && Number.isFinite(right) && /\d{4}-\d{2}-\d{2}T/.test(a)) return left === right;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Why this verdict cannot be taken back now — or null when it can. */
/** Any task row, or a test's draft of one: only the snapshot fields are read. */
type AnyTask = Partial<Record<keyof Task, unknown>>;

export function undoBlocker(task: AnyTask, review: Pick<TaskReview, "excused_reason" | "before" | "after">): string | null {
  if (review.excused_reason === "undone") return "It was already taken back.";
  if (!review.before || !review.after) return "This verdict was given before verdicts could be taken back.";
  const moved = (["status", "review_state", "stage", "deadline"] as const).some(
    (field) => field in review.after! && !sameValue(task[field], review.after![field]),
  );
  return moved ? "Something has happened to the task since — it cannot be taken back now." : null;
}

/**
 * The verdict taken back: the task as it was before it — reported and
 * waiting, or open — with its schedule re-derived. The verdict itself is kept
 * and marked 'undone' by the caller, so it counts nothing and stays listed.
 */
export function undoChanges(
  task: Schedulable & AnyTask,
  review: Pick<TaskReview, "excused_reason" | "before" | "after">,
  now: Date,
  ownerDiscordId: string | null,
): { ok: true; changes: Partial<Task> } | { ok: false; error: string } {
  const blocked = undoBlocker(task, review);
  if (blocked) return { ok: false, error: blocked };
  const before = review.before as Partial<Task>;
  const changes: Partial<Task> = { ...before };
  // Waiting for review again: the reviewer is reminded a day from now, not at once.
  if (before.status === "done" && before.review_state === "pending") {
    changes.review_nudge_at = new Date(now.getTime() + REVIEW_NUDGE_AFTER_MS).toISOString();
  }
  const next = nextAlertFor({ ...task, ...changes } as Schedulable, now, ownerDiscordId);
  return { ok: true, changes: { ...changes, next_alert_at: next ? next.toISOString() : null } };
}

/**
 * The newest verdict on a task that can still be taken back, or null — what
 * the board offers "Undo" for.
 */
export function undoableVerdict(task: AnyTask & Pick<Task, "id">, reviews: readonly TaskReview[]): TaskReview | null {
  const latest = reviews
    .filter((review) => review.task_id === task.id && review.excused_reason !== "undone")
    .sort((a, b) => Date.parse(b.decided_at) - Date.parse(a.decided_at))[0];
  return latest && undoBlocker(task, latest) === null ? latest : null;
}

/** The DM the assignee gets when a verdict about their work is taken back. */
export function undoneNotice(
  decision: ReviewDecision,
  title: string,
  reviewerName: string | null,
  restored: Partial<Task>,
  link: string | null,
): string {
  const who = reviewerName ?? "Whoever reviews it";
  const now =
    restored.status === "done" && restored.review_state === "pending"
      ? "it is waiting for review again"
      : restored.status === "open"
        ? "it is open again, as it was"
        : "it is back as it was";
  return [
    `↩️ **${who}** took back their verdict on **${title}** (${decisionLabel(decision).toLowerCase()}) — ${now}. Nothing from it counts.`,
    link ? `All your tasks: <${link}>` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** "2 days 3 hours", "45 minutes" — how long, roughly, for a sentence. */
export function durationText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 || hours >= 6 ? plural(hours, "hour") : `${plural(hours, "hour")} ${plural(minutes % 60, "minute")}`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? plural(days, "day") : `${plural(days, "day")} ${plural(hours % 24, "hour")}`;
}

/**
 * How a closed task says it ended. `who` is the assignee's name, for the
 * reviewer's side; `shared` is true on the assignee's own view of it.
 */
export function closedLabel(task: Reviewable & { dismiss_reason?: Task["dismiss_reason"] }, shared: boolean, who: string): string {
  // Closed because its person was only copied in (2026-10-20): nothing counts.
  if (task.status === "dismissed") return task.dismiss_reason === "only_cc" ? "Not for them — only copied in" : "Dismissed";
  if (task.status === "failed") return shared ? "Failed — closed on review" : "Failed";
  const name = who || "them";
  if (task.review_state === "pending") return shared ? "Finished · awaiting review" : `Finished by ${name} · to review`;
  if (task.review_state === "accepted") return shared ? "Approved" : `Approved · done by ${name}`;
  if (task.completed_by !== "assignee") return "Done";
  return shared ? "Done by you" : `Done by ${name}`;
}

// ---------------------------------------------------------------------------
// What each side is told
// ---------------------------------------------------------------------------

/** A deadline as Discord shows it: in the reader's own zone, with a live count. */
function discordWhen(iso: string): string {
  const unix = Math.floor(Date.parse(iso) / 1000);
  return `<t:${unix}:F> (<t:${unix}:R>)`;
}

/**
 * The DM the reviewer gets when the assignee reports it done, with what they
 * sent as proof and a link straight to the task. Kept as a
 * `tt_alerts.message_id`, so the OWNER's reply ("approve", "extend 2 days")
 * is a command about this task; anyone else reviews on the board.
 */
export function finishedNotice(
  title: string,
  assigneeName: string,
  link: string | null,
  { proof = [], canReply = true }: { proof?: string[]; canReply?: boolean } = {},
): string {
  return [
    `🏁 ${assigneeName} reported **${title}** done — it is waiting for your review.`,
    proof.length > 0 ? `Proof:\n${proof.map((line) => `> ${line}`).join("\n")}` : null,
    link ? `Review it — approve, disapprove or extend: <${link}>` : null,
    canReply ? "Or reply to this message with `approve`, `disapprove: what is missing` (it reopens), or `extend 2 days`." : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The reviewer's daily reminder that reported work waits for them. Kept as a
 * `tt_alerts.message_id`, like the first notice.
 */
export function reviewNudgeText(
  title: string,
  assigneeName: string,
  finishedAt: string | null,
  now: Date,
  link: string | null,
  canReply = true,
): string {
  const waited = finishedAt ? Math.max(0, now.getTime() - Date.parse(finishedAt)) : null;
  return [
    `⏳ **${assigneeName}** reported **${title}** done${waited !== null ? ` ${durationText(waited)} ago` : ""} — it is waiting for your review.`,
    "While it waits, its deadline does not count against them.",
    link ? `Review it: <${link}>` : null,
    canReply ? "Or reply to this message with `approve`, `disapprove: what is missing`, or `extend 2 days`." : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** When the reviewer is next reminded about a review, after a reminder sent (or attempted) at `now`. */
export function nextReviewNudge(now: Date): string {
  return new Date(now.getTime() + REVIEW_NUDGE_EVERY_MS).toISOString();
}

/** The DM the assignee gets with the verdict on their work. */
export function verdictNotice(
  decision: ReviewDecision,
  title: string,
  reviewerName: string | null,
  note: string | null,
  newDeadline: string | null,
  link: string | null,
): string {
  const who = reviewerName ?? "Whoever gave it to you";
  const head: Record<ReviewDecision, string> = {
    approve_on_time: `✅ **${who}** approved **${title}** — on time. It is closed.`,
    approve_late: `✅ **${who}** approved **${title}** — but late, so it counts −1. It is closed.`,
    disapprove_close: `❌ **${who}** did not approve **${title}**: it is closed as failed, and counts −1.`,
    disapprove_reopen: `↩️ **${who}** did not approve **${title}** yet — it counts −1, and it is open again so you can finish it.`,
    extend: `⏩ **${who}** gave you more time on **${title}** — it is open again, and nothing is counted against you.`,
  };
  return [
    head[decision],
    note ? `Note: ${note}` : null,
    newDeadline ? `New deadline: ${discordWhen(newDeadline)}` : null,
    decision === "disapprove_reopen" || decision === "extend"
      ? "When it is finished, reply to this message with the proof — a screenshot, a link, a file or a few words."
      : null,
    link ? `All your tasks: <${link}>` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** What the reviewer is told in Discord after a verdict sent from there — and whether the assignee heard. */
export function verdictReply(decision: ReviewDecision, title: string, assigneeName: string, told: boolean, newDeadline: string | null): string {
  const moved = newDeadline ? ` New deadline ${discordWhen(newDeadline)}.` : "";
  const heard = told ? ` ${assigneeName} has been told.` : ` I could not DM ${assigneeName} — tell them yourself.`;
  const what: Record<ReviewDecision, string> = {
    approve_on_time: `✅ Approved **${title}** — on time.`,
    approve_late: `✅ Approved **${title}** — late, −1 for ${assigneeName}.`,
    disapprove_close: `❌ Closed **${title}** as failed — −1 for ${assigneeName}.`,
    disapprove_reopen: `↩️ Reopened **${title}** — −1 for ${assigneeName}.`,
    extend: `⏩ Extended **${title}** — no penalty.`,
  };
  return `${what[decision]}${moved}${heard}`;
}
