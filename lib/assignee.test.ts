import { describe, expect, it } from "vitest";

import { TOGGLE_QUIET_MS, assigneeActionChanges, giverNotice, isAssigneeAction, toggleNoticeDue } from "./assignee";
import { PENDING_STAGE } from "./review";
import { DONE_FROM_STAGE, IN_PROGRESS_STAGE } from "./stages";
import type { Task } from "./types/database";

const NOW = new Date("2026-09-29T10:00:00.000Z");
const OWNER = "111111111111111111";
const MINH = "222222222222222222";

type ActionTask = Parameters<typeof assigneeActionChanges>[0];

function task(overrides: Partial<ActionTask> = {}): ActionTask {
  return {
    status: "open",
    stage: 1,
    stage_at: { "1": "2026-09-28T10:00:00.000Z" },
    deadline: "2026-09-29T09:00:00.000Z",
    alert_every_minutes: 1440,
    last_alert_at: "2026-09-29T09:00:00.000Z",
    direction: "given",
    assignee_discord_id: MINH,
    assignee_alerts_sent: 0,
    assignee_last_alert_at: null,
    assignee_last_error: null,
    assignee_overdue_alerts: 0,
    assignee_muted_at: null,
    assignee_muted_by: null,
    ...overrides,
  };
}

function changesOf(result: ReturnType<typeof assigneeActionChanges>): Partial<Task> {
  if (!result.ok) throw new Error(result.error);
  return result.changes;
}

describe("isAssigneeAction", () => {
  it("accepts the four answers and nothing else", () => {
    expect(isAssigneeAction("start")).toBe(true);
    expect(isAssigneeAction("done")).toBe(true);
    expect(isAssigneeAction("mute")).toBe(true);
    expect(isAssigneeAction("unmute")).toBe(true);
    expect(isAssigneeAction("delete")).toBe(false);
    expect(isAssigneeAction(undefined)).toBe(false);
  });
});

describe("assigneeActionChanges", () => {
  it("'done' stops the clock, says the assignee did it, and puts it up for review — at Testing, never Completed", () => {
    const changes = changesOf(assigneeActionChanges(task(), "done", NOW));
    expect(changes).toMatchObject({
      status: "done",
      completed_at: NOW.toISOString(),
      completed_by: "assignee",
      stage: PENDING_STAGE,
      review_state: "pending",
      reviewed_at: null,
      review_nudges: 0,
      next_alert_at: null,
    });
    // The giver is told at once; the first daily reminder to review is a day out.
    expect(changes.review_nudge_at).toBe(new Date(NOW.getTime() + 86_400_000).toISOString());
    expect(changes.stage_at?.["1"]).toBe("2026-09-28T10:00:00.000Z");
    expect(changes.stage_at?.[String(PENDING_STAGE)]).toBe(NOW.toISOString());
    // Completed is reached only by an approval (Lucky35's PO, 2026-10-07).
    expect(changes.stage_at?.[String(DONE_FROM_STAGE)]).toBeUndefined();
  });

  it("'done' waits at Testing however far along the rail it was", () => {
    expect(changesOf(assigneeActionChanges(task({ stage: 3 }), "done", NOW)).stage).toBe(PENDING_STAGE);
    expect(changesOf(assigneeActionChanges(task({ stage: 0 }), "done", NOW)).stage).toBe(PENDING_STAGE);
  });

  it("'done' refuses a task that is already closed", () => {
    expect(assigneeActionChanges(task({ status: "dismissed" }), "done", NOW).ok).toBe(false);
  });

  it("'start' moves it to In progress, stamped, and never steps a task back", () => {
    const changes = changesOf(assigneeActionChanges(task({ stage: 1 }), "start", NOW));
    expect(changes.stage).toBe(IN_PROGRESS_STAGE);
    expect(changes.stage_at?.["1"]).toBe("2026-09-28T10:00:00.000Z");
    expect(changes.stage_at?.[String(IN_PROGRESS_STAGE)]).toBe(NOW.toISOString());
    // Nothing about reminders or status moves.
    expect(Object.keys(changes).sort()).toEqual(["stage", "stage_at"]);

    expect(changesOf(assigneeActionChanges(task({ stage: 3 }), "start", NOW))).toEqual({});
    expect(assigneeActionChanges(task({ status: "done" }), "start", NOW).ok).toBe(false);
  });

  it("'mute' switches off the assignee's reminders only, and is idempotent", () => {
    expect(changesOf(assigneeActionChanges(task(), "mute", NOW))).toEqual({
      assignee_muted_at: NOW.toISOString(),
      assignee_muted_by: "assignee",
    });
    const already = task({ assignee_muted_at: "2026-09-28T00:00:00.000Z", assignee_muted_by: "assignee" });
    expect(changesOf(assigneeActionChanges(already, "mute", NOW))).toEqual({});
  });

  it("'unmute' undoes the assignee's own stop, never the giver's", () => {
    const own = task({ assignee_muted_at: "2026-09-28T00:00:00.000Z", assignee_muted_by: "assignee" });
    expect(changesOf(assigneeActionChanges(own, "unmute", NOW))).toEqual({
      assignee_muted_at: null,
      assignee_muted_by: null,
    });

    const giver = task({ assignee_muted_at: "2026-09-28T00:00:00.000Z", assignee_muted_by: "owner" });
    expect(assigneeActionChanges(giver, "unmute", NOW).ok).toBe(false);
  });

  it("with the giver's reminders off, stopping or restarting the assignee's re-derives the schedule", () => {
    // Due tomorrow, giver on "No reminder": only the assignee's stream schedules it.
    const quiet = { deadline: "2026-09-30T10:00:00.000Z", alert_every_minutes: null, last_alert_at: null };

    const muted = changesOf(assigneeActionChanges(task(quiet), "mute", NOW, OWNER));
    expect(muted.next_alert_at).toBeNull();

    const back = changesOf(
      assigneeActionChanges(task({ ...quiet, assignee_muted_at: NOW.toISOString(), assignee_muted_by: "assignee" }), "unmute", NOW, OWNER),
    );
    expect(back.next_alert_at).toBe("2026-09-30T09:00:00.000Z"); // the hour-before reminder
  });
});

describe("giverNotice", () => {
  it("tells the giver at once, naming the task and the person, and asks for a review", () => {
    const done = giverNotice("done", "Redo the thumbnail", "minh", "https://t.example/?task=1", { proof: ["📎 thumb.png"] });
    expect(done).toContain("minh reported **Redo the thumbnail** done");
    expect(done).toContain("> 📎 thumb.png");
    expect(done).toContain("`approve`");
    expect(done).toContain("<https://t.example/?task=1>");
    // Starting shows on the board; it is not worth a DM.
    expect(giverNotice("start", "Redo the thumbnail", "minh", null)).toBeNull();
    expect(giverNotice("mute", "Redo the thumbnail", "minh", "https://t.example/?task=1")).toContain(
      "<https://t.example/?task=1>",
    );
    expect(giverNotice("unmute", "Redo the thumbnail", "minh", null)).toContain("back on");
  });
});

describe("toggleNoticeDue — the giver hears every change, never a burst", () => {
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

  it("tells the first stop at once", () => {
    expect(toggleNoticeDue(true, null, null, NOW)).toBe("now");
  });

  it("owes a resume inside the window instead of dropping it", () => {
    // Lucky35, 2026-10-03: stop then resume left the giver thinking 'off'.
    expect(toggleNoticeDue(false, "muted", ago(60_000), NOW)).toBe("later");
    expect(toggleNoticeDue(false, "muted", ago(TOGGLE_QUIET_MS), NOW)).toBe("now");
  });

  it("says nothing the giver already believes", () => {
    // stop, resume, stop — all inside the window: still 'off', as they were told.
    expect(toggleNoticeDue(true, "muted", ago(60_000), NOW)).toBe("none");
    expect(toggleNoticeDue(false, null, null, NOW)).toBe("none");
    expect(toggleNoticeDue(false, "unmuted", ago(60_000), NOW)).toBe("none");
  });
});
