import { describe, expect, it } from "vitest";

import {
  NEUTRAL_INITIAL,
  PERSON_KEY_COLUMN,
  completionHistory,
  displayNameFor,
  initialsFor,
  openCount,
  overdueCount,
  personKeyForTask,
  tasksForPerson,
} from "./people";
import { DONE_FROM_STAGE } from "./stages";
import type { Person, Task } from "./types/database";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const DAY = 86_400_000;

const ALICE = "222222222222222222";
const BOB = "333333333333333333";

const DONE_KEY = String(DONE_FROM_STAGE);

let seq = 0;

/**
 * A complete Task, because `pnpm typecheck` reads this file too and a partial
 * literal would run under vitest and fail the gate. Same shape as the factory
 * in `lib/board.test.ts`.
 */
function task(overrides: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `task-${seq}`,
    user_id: "user-1",
    owner_name: null,
    message_id: null,
    direction: "given",
    counterparty: null,
    assignee_discord_id: null,
    assignee_name: null,
    stage: 0,
    stage_at: {},
    title: "ship the thing",
    detail: "",
    source_excerpt: null,
    source_url: null,
    color: "#22D3EE",
    status: "open",
    deadline: null,
    suggested_deadline: null,
    deadline_source: "manual",
    alert_every_minutes: null,
    next_alert_at: null,
    last_alert_at: null,
    alerts_sent: 0,
    assignee_alerts_sent: 0,
    assignee_last_alert_at: null,
    assignee_last_error: null,
    assignee_overdue_alerts: 0,
    assignee_muted_at: null,
    assignee_muted_by: null,
    completed_by: null,
    assignee_told_at: null,
    assignee_candidates: null,
    assignee_mute_told: null,
    assignee_mute_told_at: null,
    assignee_mute_notice_due: false,
    review_state: null,
    reviewed_at: null,
    review_note: null,
    review_rejections: 0,
    review_nudge_at: null,
    review_nudges: 0,
    requested_by_discord_id: null,
    requested_by_name: null,
    sort_order: 0,
    created_at: "2026-09-01T09:00:00.000Z",
    updated_at: "2026-09-01T09:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: "person-1",
    user_id: "user-1",
    discord_user_id: ALICE,
    display_name: "",
    avatar_url: null,
    notes: "",
    grade: null,
    created_at: "2026-09-01T09:00:00.000Z",
    updated_at: "2026-09-01T09:00:00.000Z",
    ...overrides,
  };
}

const ids = (rows: Task[]) => rows.map((row) => row.id);

describe("personKeyForTask", () => {
  it("reads the key out of PERSON_KEY_COLUMN, so the whole feature has one join", () => {
    expect(PERSON_KEY_COLUMN).toBe("assignee_discord_id");
    expect(personKeyForTask(task({ assignee_discord_id: ALICE }))).toBe(ALICE);
  });

  it("returns null rather than an empty string when the task carries nobody", () => {
    expect(personKeyForTask(task({ assignee_discord_id: null }))).toBeNull();
    expect(personKeyForTask(task({ assignee_discord_id: "   " }))).toBeNull();
  });
});

describe("tasksForPerson", () => {
  it("excludes a 'received' task even when its person key matches", () => {
    const given = task({ direction: "given", assignee_discord_id: ALICE });
    const received = task({ direction: "received", assignee_discord_id: ALICE });

    expect(ids(tasksForPerson([given, received], ALICE))).toEqual([given.id]);
  });

  it("excludes another person's given task", () => {
    const alice = task({ assignee_discord_id: ALICE });
    const bob = task({ assignee_discord_id: BOB });

    expect(ids(tasksForPerson([alice, bob], ALICE))).toEqual([alice.id]);
  });

  it("matches nobody when the key is empty, rather than returning unassigned work", () => {
    const unassigned = task({ assignee_discord_id: null });

    expect(tasksForPerson([unassigned], "")).toEqual([]);
    expect(tasksForPerson([unassigned], "   ")).toEqual([]);
  });
});

describe("openCount", () => {
  it("counts only open given tasks for that person", () => {
    const rows = [
      task({ assignee_discord_id: ALICE, status: "open" }),
      task({ assignee_discord_id: ALICE, status: "done" }),
      task({ assignee_discord_id: ALICE, status: "dismissed" }),
      task({ assignee_discord_id: BOB, status: "open" }),
    ];

    expect(openCount(rows, ALICE)).toBe(1);
  });

  it("does not count an open 'received' task with a matching key", () => {
    const rows = [task({ direction: "received", assignee_discord_id: ALICE, status: "open" })];

    expect(openCount(rows, ALICE)).toBe(0);
  });
});

describe("overdueCount", () => {
  it("excludes a task with no deadline", () => {
    const rows = [task({ assignee_discord_id: ALICE, deadline: null })];

    expect(overdueCount(rows, ALICE, NOW)).toBe(0);
  });

  it("excludes a done task whose deadline is in the past", () => {
    const rows = [
      task({
        assignee_discord_id: ALICE,
        status: "done",
        deadline: new Date(NOW.getTime() - DAY).toISOString(),
      }),
    ];

    expect(overdueCount(rows, ALICE, NOW)).toBe(0);
  });

  it("counts an open task whose deadline has passed and not one still to come", () => {
    const rows = [
      task({
        assignee_discord_id: ALICE,
        deadline: new Date(NOW.getTime() - DAY).toISOString(),
      }),
      task({
        assignee_discord_id: ALICE,
        deadline: new Date(NOW.getTime() + DAY).toISOString(),
      }),
    ];

    expect(overdueCount(rows, ALICE, NOW)).toBe(1);
  });

  it("does not count an overdue 'received' task with a matching key", () => {
    const rows = [
      task({
        direction: "received",
        assignee_discord_id: ALICE,
        deadline: new Date(NOW.getTime() - DAY).toISOString(),
      }),
    ];

    expect(overdueCount(rows, ALICE, NOW)).toBe(0);
  });
});

describe("completionHistory", () => {
  it("dates a task from the stage_at stamp when the rail wrote one", () => {
    const stamped = task({
      assignee_discord_id: ALICE,
      stage: DONE_FROM_STAGE,
      stage_at: { [DONE_KEY]: "2026-09-05T08:00:00.000Z" },
      completed_at: "2026-09-06T08:00:00.000Z",
    });

    expect(completionHistory([stamped], ALICE)).toEqual([
      { taskId: stamped.id, title: stamped.title, at: "2026-09-05T08:00:00.000Z" },
    ]);
  });

  it("still lists an '@bot done' task — stage 4, completed_at set, stage_at empty — dated from completed_at", () => {
    const botDone = task({
      assignee_discord_id: ALICE,
      stage: DONE_FROM_STAGE,
      stage_at: {},
      completed_at: "2026-09-06T08:00:00.000Z",
      status: "done",
    });

    expect(completionHistory([botDone], ALICE)).toEqual([
      { taskId: botDone.id, title: botDone.title, at: "2026-09-06T08:00:00.000Z" },
    ]);
  });

  it("omits a completed task carrying neither a stamp nor completed_at, rather than dating it to the epoch", () => {
    const dateless = task({
      assignee_discord_id: ALICE,
      stage: DONE_FROM_STAGE,
      stage_at: {},
      completed_at: null,
      status: "done",
    });

    const history = completionHistory([dateless], ALICE);

    expect(history).toEqual([]);
    expect(history.map((entry) => entry.at)).not.toContain("1970-01-01T00:00:00.000Z");
  });

  it("omits work that is not finished", () => {
    const open = task({ assignee_discord_id: ALICE, stage: 2, status: "open" });

    expect(completionHistory([open], ALICE)).toEqual([]);
  });

  it("excludes a finished 'received' task with a matching key", () => {
    const received = task({
      direction: "received",
      assignee_discord_id: ALICE,
      stage: DONE_FROM_STAGE,
      status: "done",
      completed_at: "2026-09-06T08:00:00.000Z",
    });

    expect(completionHistory([received], ALICE)).toEqual([]);
  });

  it("sorts newest first", () => {
    const older = task({
      assignee_discord_id: ALICE,
      status: "done",
      completed_at: "2026-09-01T08:00:00.000Z",
    });
    const newer = task({
      assignee_discord_id: ALICE,
      stage: DONE_FROM_STAGE,
      stage_at: { [DONE_KEY]: "2026-09-06T08:00:00.000Z" },
    });

    expect(completionHistory([older, newer], ALICE).map((entry) => entry.taskId)).toEqual([
      newer.id,
      older.id,
    ]);
  });
});

describe("displayNameFor", () => {
  it("prefers the label on the task over the stored row and the key", () => {
    const named = task({ assignee_discord_id: ALICE, assignee_name: "Alice Baker" });

    expect(displayNameFor(person({ display_name: "Ali" }), named, ALICE)).toBe("Alice Baker");
  });

  it("falls back to the stored display_name when the backfilled row has a null name", () => {
    const backfilled = task({ assignee_discord_id: ALICE, assignee_name: null });

    expect(displayNameFor(person({ display_name: "Ali" }), backfilled, ALICE)).toBe("Ali");
  });

  it("falls back to @<key> when nothing carries a name", () => {
    expect(displayNameFor(null, null, ALICE)).toBe(`@${ALICE}`);
    expect(displayNameFor(person({ display_name: "  " }), task(), ALICE)).toBe(`@${ALICE}`);
  });
});

describe("initialsFor", () => {
  it("returns a neutral glyph rather than digits when the only name available is a snowflake", () => {
    const resolved = displayNameFor(null, null, ALICE);
    const initials = initialsFor(resolved, ALICE);

    expect(initials).toBe(NEUTRAL_INITIAL);
    expect(initials).not.toMatch(/\d/);
  });

  it("takes the first letter of the first two words, uppercased", () => {
    expect(initialsFor("Alice Baker Carter", ALICE)).toBe("AB");
    expect(initialsFor("  alice   baker ", ALICE)).toBe("AB");
    expect(initialsFor("alice", ALICE)).toBe("A");
  });

  it("returns the neutral glyph for an empty name", () => {
    expect(initialsFor("", ALICE)).toBe(NEUTRAL_INITIAL);
    expect(initialsFor("   ", ALICE)).toBe(NEUTRAL_INITIAL);
  });
});
