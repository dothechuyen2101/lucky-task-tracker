/**
 * What the person a task was GIVEN to may do about it — pure, so it is testable.
 *
 * Lucky35, 2026-09-29: the assignee got reminder after reminder and could
 * only read them. Now, signed in with the Discord account the task names, they
 * can say it is done, or turn their own reminders off (and on again). Nothing
 * else: the deadline, the title, the giver's reminders and everything else on
 * the row stay the giver's. `app/api/tasks/assignee/route.ts` checks who is
 * asking; this module decides what each answer changes, and what the giver is
 * told about it.
 *
 * Lucky35, 2026-10-04: they can also say they have started (In progress), so
 * the giver's Team view shows who is on what; and "done" now waits for the
 * giver's review (`lib/review.ts`) instead of closing the matter.
 *
 * Lucky35's PO, 2026-10-07: on work given to someone, how far along it is
 * belongs to the person doing it — not to the giver, who reviews. They set it
 * themselves (`stage`: Not started, Started, In progress — and back), and a
 * report sent by mistake can be taken back before anyone reviews it
 * (`withdraw`).
 */

import { type Schedulable, nextAlertFor, remindsGiver } from "@/lib/reminders";
import { PENDING_STAGE, REVIEW_NUDGE_AFTER_MS, awaitsReview, finishedNotice } from "@/lib/review";
import { IN_PROGRESS_STAGE, stampStages } from "@/lib/stages";
import type { Task } from "@/lib/types/database";

export const ASSIGNEE_ACTIONS = ["start", "stage", "done", "withdraw", "mute", "unmute"] as const;

/** The furthest an assignee moves a task themselves: In progress. Testing is reporting it done; Completed is approval. */
export const ASSIGNEE_STAGE_MAX = IN_PROGRESS_STAGE;
export type AssigneeAction = (typeof ASSIGNEE_ACTIONS)[number];

export function isAssigneeAction(value: unknown): value is AssigneeAction {
  return typeof value === "string" && (ASSIGNEE_ACTIONS as readonly string[]).includes(value);
}

type ActionTask = Schedulable & Pick<Task, "stage" | "stage_at"> & Partial<Pick<Task, "review_state">>;

/**
 * The columns an assignee's answer writes, or why it cannot be applied.
 *
 * "Start" moves it to In progress — never back: a task already further along
 * stays where it is. The giver is not DMed about it; their board shows it.
 *
 * "Done" — always with proof, which the caller stores (Lucky35's PO,
 * 2026-10-07) — stops the clock and the reminders and puts the work up for
 * review. It is NOT Completed: it waits at Testing (`PENDING_STAGE`) until the
 * reviewer approves it, disapproves it or extends it (`lib/review.ts`).
 * `next_alert_at` is derived, never typed (CLAUDE.md): a closed task has none.
 * The assignee may undo only their own "stop": if the giver switched the
 * reminders off, that is the giver's call.
 *
 * With the giver's own reminders off, the assignee's stream is what schedules
 * the task at all (`lib/reminders.ts`, rule 4), so stopping or restarting it
 * re-derives `next_alert_at`. With the giver's on, the giver's cadence
 * schedules both and is left exactly where it was.
 */
export function assigneeActionChanges(
  task: ActionTask,
  action: AssigneeAction,
  now: Date,
  ownerDiscordId: string | null = null,
  { stage: target }: { stage?: number } = {},
): { ok: true; changes: Partial<Task> } | { ok: false; error: string } {
  const stamp = now.toISOString();
  const rescheduled = (changes: Partial<Task>): Partial<Task> => {
    if (remindsGiver(task.alert_every_minutes)) return changes;
    const next = nextAlertFor({ ...task, ...changes } as ActionTask, now, ownerDiscordId);
    return { ...changes, next_alert_at: next ? next.toISOString() : null };
  };

  if (action === "start") {
    if (task.status !== "open") return { ok: false, error: "This task is already closed." };
    if (task.stage >= IN_PROGRESS_STAGE) return { ok: true, changes: {} };
    return {
      ok: true,
      changes: { stage: IN_PROGRESS_STAGE, stage_at: stampStages(task.stage_at, IN_PROGRESS_STAGE, stamp) },
    };
  }

  if (action === "stage") {
    if (task.status !== "open") return { ok: false, error: "It is not open — reported, approved or closed work does not move on the rail." };
    if (target === undefined || !Number.isInteger(target) || target < 0 || target > ASSIGNEE_STAGE_MAX) {
      return { ok: false, error: "Say Not started, Started or In progress — reporting it done is the button below." };
    }
    if (task.stage === target) return { ok: true, changes: {} };
    return { ok: true, changes: { stage: target, stage_at: stampStages(task.stage_at, target, stamp) } };
  }

  if (action === "withdraw") {
    // Only before anyone reviewed it: a verdict is the reviewer's to take back.
    if (!awaitsReview({ status: task.status as Task["status"], review_state: task.review_state ?? null })) {
      return { ok: false, error: "Only a report nobody has reviewed yet can be taken back." };
    }
    const open: Partial<Task> = {
      status: "open",
      completed_at: null,
      completed_by: null,
      stage: IN_PROGRESS_STAGE,
      stage_at: stampStages(task.stage_at, IN_PROGRESS_STAGE, stamp),
      review_state: null,
      reviewed_at: null,
      review_nudge_at: null,
    };
    const next = nextAlertFor({ ...task, ...open } as ActionTask, now, ownerDiscordId);
    return { ok: true, changes: { ...open, next_alert_at: next ? next.toISOString() : null } };
  }

  if (action === "done") {
    if (task.status !== "open") return { ok: false, error: "This task is already closed." };
    const stage = PENDING_STAGE;
    const next = nextAlertFor({ ...task, status: "done" }, now, ownerDiscordId);
    return {
      ok: true,
      changes: {
        status: "done",
        completed_at: stamp,
        completed_by: "assignee",
        stage,
        stage_at: stampStages(task.stage_at, stage, stamp),
        review_state: "pending",
        reviewed_at: null,
        // Told at once (`finishedNotice`); reminded daily after that until they decide.
        review_nudge_at: new Date(now.getTime() + REVIEW_NUDGE_AFTER_MS).toISOString(),
        review_nudges: 0,
        next_alert_at: next ? next.toISOString() : null,
      },
    };
  }

  if (action === "mute") {
    if (task.assignee_muted_at) return { ok: true, changes: {} };
    return { ok: true, changes: rescheduled({ assignee_muted_at: stamp, assignee_muted_by: "assignee" }) };
  }

  if (!task.assignee_muted_at) return { ok: true, changes: {} };
  if (task.assignee_muted_by !== "assignee") {
    return { ok: false, error: "Whoever gave you this task turned the reminders off. Ask them to turn them back on." };
  }
  return { ok: true, changes: rescheduled({ assignee_muted_at: null, assignee_muted_by: null }) };
}

/**
 * The DM the giver gets the moment the assignee answers — so a task closed or
 * silenced from the other side never goes unnoticed. Null when there is
 * nothing to say: "start" shows on the board, and is not worth a DM.
 */
export function giverNotice(
  action: AssigneeAction,
  title: string,
  assigneeName: string,
  link: string | null,
  review: { proof?: string[]; canReply?: boolean } = {},
): string | null {
  const board = link ? `\n<${link}>` : "";
  if (action === "start" || action === "stage") return null;
  if (action === "withdraw") return `↩️ ${assigneeName} took back their report on **${title}** — it is open again, nothing to review.${board}`;
  if (action === "done") return finishedNotice(title, assigneeName, link, review);
  if (action === "mute") return `🔕 ${assigneeName} turned off their reminders for **${title}**. Yours keep going.${board}`;
  return `🔔 ${assigneeName} turned their reminders for **${title}** back on.${board}`;
}

// ---------------------------------------------------------------------------
// Telling the giver about stop / resume — never twice in a breath, never not at all
// ---------------------------------------------------------------------------

/**
 * A stop and a resume inside this window are one change to the giver, not two
 * DMs (2026-09-30: toggling spammed the giver).
 */
export const TOGGLE_QUIET_MS = 10 * 60_000;

export type ToggleNotice = "now" | "later" | "none";

/**
 * Whether the giver must hear about the assignee's reminders now, once the
 * quiet window passes, or not at all.
 *
 * Lucky35, 2026-10-03: the old rule dropped any switch inside the window, so a
 * stop followed by a resume left the giver believing reminders were still off.
 * Now what the giver last heard (`told`) is the reference: a state they already
 * believe is never re-sent (stop, resume, stop within the window: nothing new),
 * and a state that differs is sent at once — or, inside the window, owed and
 * sent when it passes (`assignee_mute_notice_due`). Nothing is told before
 * anything was switched: reminders on is what a giver assumes.
 */
export function toggleNoticeDue(
  muted: boolean,
  told: "muted" | "unmuted" | null,
  toldAt: string | null,
  now: Date,
): ToggleNotice {
  const state = muted ? "muted" : "unmuted";
  if (told === state || (told === null && !muted)) return "none";
  const last = toldAt ? Date.parse(toldAt) : NaN;
  return Number.isFinite(last) && now.getTime() - last < TOGGLE_QUIET_MS ? "later" : "now";
}
