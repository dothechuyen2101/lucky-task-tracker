import { describe, expect, it } from "vitest";

import type { Viewer } from "./board";
import { dropLive, formatScore, mergeLive, scoreBreakdown, stageSince, teamOf } from "./team";
import type { ScoreEntry, Task } from "./types/database";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const DAY = 86_400_000;

const LUKA = "111111111111111111";
const MINH = "222222222222222222";
const BAO = "333333333333333333";
const CHI = "444444444444444444";

/** Luka, signed in as account user-1. */
const ME: Viewer = { ownerId: "user-1", selfId: LUKA };

const NAMES: Record<string, string> = { [MINH]: "Minh", [BAO]: "Bao", [CHI]: "Chi" };
const nameOf = (key: string) => NAMES[key] ?? key;

let seq = 0;

/** A complete Task — `pnpm typecheck` reads this file too. */
function task(overrides: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `task-${seq}`,
    user_id: "user-1",
    owner_name: null,
    message_id: null,
    direction: "given",
    counterparty: null,
    assignee_discord_id: MINH,
    assignee_name: null,
    stage: 0,
    stage_at: {},
    title: `task ${seq}`,
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
    created_at: "2026-10-01T09:00:00.000Z",
    updated_at: "2026-10-01T09:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

/** One entry of the permanent score history (`tt_score_entries`). */
function entry(overrides: Partial<ScoreEntry> = {}): ScoreEntry {
  seq += 1;
  return {
    id: `entry-${seq}`,
    seq,
    root_id: `entry-${seq}`,
    corrects: null,
    user_id: "user-1",
    person_discord_id: MINH,
    person_name: "minh",
    amount: "-1.0",
    reason: "approved_late",
    correction_cause: null,
    note: null,
    task_ids: ["task-x"],
    task_titles: ["late thing"],
    review_ids: [],
    miss_id: null,
    decided_at: new Date(NOW.getTime() - DAY).toISOString(),
    decided_by_discord_id: LUKA,
    decided_by_name: "Luka",
    recorded_at: NOW.toISOString(),
    backfilled: false,
    ...overrides,
  };
}

describe("the score is the history added up (PO, 2026-10-09)", () => {
  it("prints with a real minus sign, and zero plainly", () => {
    expect(formatScore(0)).toBe("0");
    expect(formatScore(-3)).toBe("−3");
    expect(formatScore(0.5)).toBe("+0.5");
    expect(formatScore(-0.5)).toBe("−0.5");
  });

  it("this month and in all, a correction included where it was made", () => {
    const october = { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" };
    const entries = [
      entry({ decided_at: "2026-09-29T10:00:00.000Z" }),
      entry({ decided_at: "2026-10-02T10:00:00.000Z", reason: "disapproved", note: "footer" }),
      entry({ decided_at: "2026-10-03T10:00:00.000Z", amount: "0.5", reason: "on_time_bonus" }),
      entry({ decided_at: "2026-10-03T11:00:00.000Z", amount: "1.0", reason: "correction", correction_cause: "by_hand", corrects: "entry-x" }),
      entry({ person_discord_id: BAO }),
    ];
    const [minh] = teamOf([task()], [], ME, NOW, nameOf, "UTC", { entries, month: october });
    expect(minh.total.score).toBe(-0.5);
    expect(minh.month).toMatchObject({ score: 0.5, minus: -1, plus: 1.5 });
    expect(scoreBreakdown(minh.total)).toBe("+1.5 from 2 · −2 from 2");
  });
});

describe("teamOf — who is working on what", () => {
  it("splits each person's open work into working (In progress, Testing) and queued", () => {
    const building = task({ stage: 2, stage_at: { "1": "2026-10-03T09:00:00.000Z", "2": "2026-10-04T09:00:00.000Z" } });
    const testing = task({ stage: 3 });
    const waiting = task({ stage: 0 });
    const started = task({ stage: 1 });

    const [minh] = teamOf([building, testing, waiting, started], [], ME, NOW, nameOf);
    expect(minh.key).toBe(MINH);
    expect(minh.working.map((t) => t.id).sort()).toEqual([building.id, testing.id].sort());
    expect(minh.queued.map((t) => t.id).sort()).toEqual([waiting.id, started.id].sort());
    expect(minh.lastMove).toBe("2026-10-04T09:00:00.000Z");
    expect(stageSince(building)).toBe("2026-10-04T09:00:00.000Z");
    expect(stageSince(waiting)).toBeNull();
  });

  it("puts finished work waiting for review on its own, longest-waiting first", () => {
    const later = task({ status: "done", completed_by: "assignee", review_state: "pending", completed_at: "2026-10-04T10:00:00.000Z" });
    const sooner = task({ status: "done", completed_by: "assignee", review_state: "pending", completed_at: "2026-10-03T10:00:00.000Z" });
    const accepted = task({ status: "done", completed_by: "assignee", review_state: "accepted", completed_at: "2026-10-02T10:00:00.000Z" });

    const [minh] = teamOf([later, sooner, accepted], [], ME, NOW, nameOf);
    expect(minh.review.map((t) => t.id)).toEqual([sooner.id, later.id]);
    expect(minh.working).toEqual([]);
  });

  it("counts overdue work and the score, ever and lately", () => {
    const late = task({ stage: 2, deadline: new Date(NOW.getTime() - 3_600_000).toISOString() });
    const entries = [entry(), entry({ decided_at: new Date(NOW.getTime() - 60 * DAY).toISOString() })];

    const [minh] = teamOf([late], [], ME, NOW, nameOf, undefined, { entries });
    expect(minh.overdue).toBe(1);
    expect(minh.score).toBe(-2);
    expect(minh.total.minusCount).toBe(2);
    expect(minh.lostLately).toBe(-1);
  });

  it("lists everyone the viewer works with — free people too — but never the viewer, nor other accounts' work", () => {
    const team = teamOf(
      [
        task({ assignee_discord_id: MINH, stage: 2 }),
        // Luka gave it to himself, and someone else's account gave Luka work.
        task({ assignee_discord_id: LUKA }),
        task({ user_id: "user-2", assignee_discord_id: LUKA }),
        // Received work is the owner's own.
        task({ direction: "received", assignee_discord_id: null }),
      ],
      [{ discord_user_id: CHI }, { discord_user_id: LUKA }],
      ME,
      NOW,
      nameOf,
      undefined,
      { entries: [entry({ person_discord_id: BAO })] },
    );
    expect(team.map((m) => m.key)).toEqual([MINH, BAO, CHI]);
    expect(team[1].working).toEqual([]);
    expect(team[1].score).toBe(-1);
  });

  it("orders people working first, then those with something waiting, then the free — by name within each", () => {
    const team = teamOf(
      [
        task({ assignee_discord_id: CHI, stage: 0 }),
        task({ assignee_discord_id: BAO, stage: 2 }),
        task({ assignee_discord_id: MINH, stage: 3 }),
      ],
      [{ discord_user_id: "555555555555555555" }],
      ME,
      NOW,
      nameOf,
    );
    expect(team.map((m) => nameOf(m.key))).toEqual(["Bao", "Minh", "Chi", "555555555555555555"]);
  });
});

describe("live rows", () => {
  it("adds a row it has not got, and updates one it has — keeping fields the event left out", () => {
    const held = task({ title: "old", detail: "long notes", updated_at: "2026-10-04T10:00:00.000Z" });
    const added = mergeLive([held], task({ id: "new-one" }));
    expect(added.map((t) => t.id)).toEqual(["new-one", held.id]);

    // An UPDATE event omits an unchanged long column.
    const partial = { id: held.id, title: "new", updated_at: "2026-10-04T11:00:00.000Z" } as Task;
    const [merged] = mergeLive([held], partial);
    expect(merged.title).toBe("new");
    expect(merged.detail).toBe("long notes");
  });

  it("ignores an event older than what is held — the newest write wins", () => {
    const held = task({ title: "newer", updated_at: "2026-10-04T11:00:00.000Z" });
    const stale = task({ id: held.id, title: "older", updated_at: "2026-10-04T10:00:00.000Z" });
    expect(mergeLive([held], stale)[0].title).toBe("newer");
  });

  it("drops a deleted row", () => {
    const a = task();
    const b = task();
    expect(dropLive([a, b], a.id)).toEqual([b]);
  });
});
