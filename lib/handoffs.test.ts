import { describe, expect, it } from "vitest";

import type { Viewer } from "./board";
import { MOVED_OFF_DAYS, dropHandedOff, handoffDecision, handoffNotice, movedOffMe } from "./handoffs";
import type { Task, TaskHandoff } from "./types/database";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const DAY = 86_400_000;

const LUKA = "111111111111111111";
const MINH = "222222222222222222";
const BAO = "333333333333333333";

/** Minh, signed in as account user-2; Luka's account is user-1. */
const MINH_VIEWING: Viewer = { ownerId: "user-2", selfId: MINH };

let seq = 0;

function handoff(overrides: Partial<TaskHandoff> = {}): TaskHandoff {
  seq += 1;
  return {
    id: `handoff-${seq}`,
    user_id: "user-1",
    task_id: "task-1",
    task_title: "Redo the thumbnail",
    owner_name: "Luka",
    from_discord_id: MINH,
    from_name: "minh",
    to_discord_id: BAO,
    to_name: "bao",
    moved_at: new Date(NOW.getTime() - 3_600_000).toISOString(),
    from_was_told: true,
    task_open: true,
    told_at: null,
    ...overrides,
  };
}

/** Only what these rules read; the rest of the row is irrelevant to them. */
function task(overrides: Partial<Task> = {}): Task {
  return { id: "task-1", user_id: "user-1", assignee_discord_id: BAO, status: "open", ...overrides } as Task;
}

describe("handoffDecision — who is told it is no longer theirs", () => {
  const now = { assignee_discord_id: BAO, status: "open" as const };

  it("tells the person it was taken from, once they knew it was theirs", () => {
    expect(handoffDecision(handoff(), LUKA, now)).toBe("dm");
  });

  it("stays quiet when there is nothing they need to hear", () => {
    expect(handoffDecision(handoff({ from_was_told: false }), LUKA, now)).toBe("quiet");
    expect(handoffDecision(handoff({ task_open: false }), LUKA, now)).toBe("quiet");
    // The giver moved work off themselves.
    expect(handoffDecision(handoff({ from_discord_id: LUKA }), LUKA, now)).toBe("quiet");
    // Closed or deleted since.
    expect(handoffDecision(handoff(), LUKA, { ...now, status: "done" })).toBe("quiet");
    expect(handoffDecision(handoff(), LUKA, null)).toBe("quiet");
    // Back on them by now: `tellAssignees` says so.
    expect(handoffDecision(handoff(), LUKA, { ...now, assignee_discord_id: MINH })).toBe("quiet");
  });

  it("says who has it now, or that nobody does", () => {
    expect(handoffNotice("T", "Luka", "bao")).toBe(
      "↪️ **Luka** moved **T** to bao — it is no longer on you, and you will get no more reminders about it.",
    );
    expect(handoffNotice("T", null, null)).toContain("took **T** off you");
  });
});

describe("movedOffMe — My tasks says what left, and why", () => {
  it("lists what was taken off the viewer lately, newest first, once per task", () => {
    const older = handoff({ task_id: "a", moved_at: new Date(NOW.getTime() - 2 * DAY).toISOString() });
    const newer = handoff({ task_id: "b", moved_at: new Date(NOW.getTime() - DAY).toISOString() });
    const sameTaskEarlier = handoff({ task_id: "b", moved_at: new Date(NOW.getTime() - 3 * DAY).toISOString() });
    expect(movedOffMe([older, newer, sameTaskEarlier], [], MINH_VIEWING, NOW).map((h) => h.id)).toEqual([newer.id, older.id]);
  });

  it("leaves out what is old, what was someone else's, and what is back on the viewer", () => {
    const stale = handoff({ task_id: "a", moved_at: new Date(NOW.getTime() - (MOVED_OFF_DAYS + 1) * DAY).toISOString() });
    const notMine = handoff({ task_id: "b", from_discord_id: BAO, to_discord_id: MINH });
    const backAgain = handoff({ task_id: "c" });
    const tasks = [task({ id: "c", assignee_discord_id: MINH })];
    expect(movedOffMe([stale, notMine, backAgain], tasks, MINH_VIEWING, NOW)).toEqual([]);
    expect(movedOffMe([handoff()], [], { ownerId: "user-2", selfId: "" }, NOW)).toEqual([]);
  });
});

describe("dropHandedOff — the open board loses the task at once", () => {
  it("drops another account's task taken off the viewer", () => {
    expect(dropHandedOff([task(), task({ id: "other" })], handoff(), MINH_VIEWING).map((t) => t.id)).toEqual(["other"]);
  });

  it("keeps it when the viewer asked for it — they can still read it", () => {
    const asked = [task({ requested_by_discord_id: MINH })];
    expect(dropHandedOff(asked, handoff(), MINH_VIEWING)).toBe(asked);
  });

  it("keeps it when it was handed to the viewer, or was the viewer's own row, or someone else's handoff", () => {
    const tasks = [task()];
    expect(dropHandedOff(tasks, handoff({ from_discord_id: BAO, to_discord_id: MINH }), MINH_VIEWING)).toBe(tasks);
    expect(dropHandedOff([task({ user_id: "user-2" })], handoff(), MINH_VIEWING)).toHaveLength(1);
    expect(dropHandedOff(tasks, handoff({ to_discord_id: MINH }), MINH_VIEWING)).toBe(tasks);
  });
});
