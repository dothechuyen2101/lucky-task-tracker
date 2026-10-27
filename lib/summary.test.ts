import { describe, expect, it } from "vitest";

import type { Viewer } from "./board";
import {
  compareMonths,
  countLine,
  dayLabel,
  monthBounds,
  monthLabel,
  monthOf,
  monthParam,
  parseMonth,
  shiftMonth,
  summarize,
  summaryText,
  timingOf,
} from "./summary";
import type { Task } from "./types/database";

const HCM = "Asia/Ho_Chi_Minh";
const ERIK = "111111111111111111";
const ALICE = "222222222222222222";
const BOB = "333333333333333333";

/** Erik, signed in as account user-1. */
const ME: Viewer = { ownerId: "user-1", selfId: ERIK };

let seq = 0;

/** A complete Task, because `pnpm typecheck` reads this file too. */
function task(overrides: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `task-${String(seq).padStart(3, "0")}`,
    user_id: "user-1",
    owner_name: null,
    message_id: null,
    direction: "given",
    counterparty: null,
    assignee_discord_id: null,
    assignee_name: null,
    stage: 4,
    stage_at: {},
    title: "ship the thing",
    detail: "",
    source_excerpt: null,
    source_url: null,
    color: "#22D3EE",
    status: "done",
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
    completed_by: "owner",
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
    completed_at: "2026-10-10T09:00:00.000Z",
    ...overrides,
  };
}

describe("the month", () => {
  it("starts and ends at midnight where the person is, not in UTC", () => {
    expect(monthBounds({ year: 2026, month: 10 }, HCM)).toEqual({
      start: "2026-09-30T17:00:00.000Z",
      end: "2026-10-31T17:00:00.000Z",
    });
  });

  it("follows a clock change inside the month", () => {
    // New York leaves daylight time on 1 November 2026: the month starts on
    // EDT (UTC-4) and ends on EST (UTC-5).
    expect(monthBounds({ year: 2026, month: 11 }, "America/New_York")).toEqual({
      start: "2026-11-01T04:00:00.000Z",
      end: "2026-12-01T05:00:00.000Z",
    });
  });

  it("rolls December into January, and reads a bad zone as UTC", () => {
    expect(monthBounds({ year: 2026, month: 12 }, "Not/AZone")).toEqual({
      start: "2026-12-01T00:00:00.000Z",
      end: "2027-01-01T00:00:00.000Z",
    });
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth({ year: 2026, month: 3 }, -15)).toEqual({ year: 2024, month: 12 });
  });

  it("is this month by the person's own calendar", () => {
    // 18:00 UTC on 30 September is already 1 October in Ho Chi Minh City.
    const now = new Date("2026-09-30T18:00:00.000Z");
    expect(monthOf(now, HCM)).toEqual({ year: 2026, month: 10 });
    expect(monthOf(now, "UTC")).toEqual({ year: 2026, month: 9 });
  });

  it("reads ?month=, and anything it cannot use is this month", () => {
    const now = new Date("2026-10-05T12:00:00.000Z");
    const current = { year: 2026, month: 10 };
    expect(parseMonth("2026-09", now, HCM)).toEqual({ year: 2026, month: 9 });
    expect(parseMonth(" 2025-12 ", now, HCM)).toEqual({ year: 2025, month: 12 });
    expect(parseMonth(null, now, HCM)).toEqual(current);
    expect(parseMonth("", now, HCM)).toEqual(current);
    expect(parseMonth("2026-9", now, HCM)).toEqual(current);
    expect(parseMonth("2026-13", now, HCM)).toEqual(current);
    expect(parseMonth("2026-00", now, HCM)).toEqual(current);
    expect(parseMonth("1999-01", now, HCM)).toEqual(current);
    // Still to come: it could only be empty.
    expect(parseMonth("2026-11", now, HCM)).toEqual(current);
  });

  it("names and orders months", () => {
    expect(monthLabel({ year: 2026, month: 10 })).toBe("October 2026");
    expect(monthParam({ year: 2026, month: 3 })).toBe("2026-03");
    expect(compareMonths({ year: 2026, month: 1 }, { year: 2025, month: 12 })).toBeGreaterThan(0);
    expect(compareMonths({ year: 2026, month: 1 }, { year: 2026, month: 1 })).toBe(0);
    expect(dayLabel("2026-10-31T18:00:00.000Z", HCM)).toBe("Nov 1");
    expect(dayLabel("2026-10-31T18:00:00.000Z", "UTC")).toBe("Oct 31");
  });
});

describe("timingOf", () => {
  it("is on time up to and including the deadline itself", () => {
    expect(timingOf({ deadline: "2026-10-10T10:00:00.000Z", completed_at: "2026-10-10T09:00:00.000Z" })).toEqual({
      kind: "on_time",
    });
    expect(timingOf({ deadline: "2026-10-10T10:00:00.000Z", completed_at: "2026-10-10T10:00:00.000Z" })).toEqual({
      kind: "on_time",
    });
  });

  it("is late by how long after", () => {
    expect(timingOf({ deadline: "2026-10-10T10:00:00.000Z", completed_at: "2026-10-10T12:30:00.000Z" })).toEqual({
      kind: "late",
      byMs: 2.5 * 3_600_000,
    });
  });

  it("is neither without a deadline", () => {
    expect(timingOf({ deadline: null, completed_at: "2026-10-10T12:30:00.000Z" })).toEqual({ kind: "undated" });
  });
});

describe("summarize", () => {
  const october = monthBounds({ year: 2026, month: 10 }, HCM);

  it("keeps only work finished inside the month, in the person's zone", () => {
    const first = task({ completed_at: "2026-09-30T17:00:00.000Z" }); // 1 Oct, 00:00 local
    const last = task({ completed_at: "2026-10-31T16:59:00.000Z" }); // 31 Oct, 23:59 local
    const tasks = [
      first,
      last,
      task({ completed_at: "2026-09-30T16:59:00.000Z" }), // 30 Sep local
      task({ completed_at: "2026-10-31T17:00:00.000Z" }), // 1 Nov local
      task({ status: "dismissed" }),
      task({ status: "open", completed_at: null }),
      task({ completed_at: null }),
    ];
    const summary = summarize(tasks, ME, october);
    expect(summary.finished).toBe(2);
    expect(summary.groups.flatMap((g) => g.tasks.map((t) => t.id))).toEqual([first.id, last.id]);
  });

  it("puts the viewer's own work first, then people busiest first, then work given to nobody", () => {
    const fromLuka = task({ user_id: "user-2", owner_name: "Luka", assignee_discord_id: ERIK, completed_at: "2026-10-03T09:00:00.000Z" });
    const askedOfMe = task({ direction: "received", counterparty: "Bao", completed_at: "2026-10-02T09:00:00.000Z" });
    const tookOn = task({ assignee_discord_id: ERIK, completed_at: "2026-10-01T09:00:00.000Z" });
    const alice = task({ assignee_discord_id: ALICE, completed_at: "2026-10-04T09:00:00.000Z" });
    const bob1 = task({ assignee_discord_id: BOB, completed_at: "2026-10-05T09:00:00.000Z" });
    const bob2 = task({ assignee_discord_id: BOB, completed_at: "2026-10-06T09:00:00.000Z" });
    const nobody = task({ completed_at: "2026-10-01T08:00:00.000Z" });

    const summary = summarize([bob2, nobody, alice, fromLuka, bob1, askedOfMe, tookOn], ME, october);
    expect(summary.groups.map((g) => [g.who, g.key, g.tasks.map((t) => t.id)])).toEqual([
      ["you", "", [tookOn.id, askedOfMe.id, fromLuka.id]],
      ["person", BOB, [bob1.id, bob2.id]],
      ["person", ALICE, [alice.id]],
      ["nobody", "", [nobody.id]],
    ]);
  });

  it("counts on time, late, undated and waiting for review", () => {
    const summary = summarize(
      [
        task({ deadline: "2026-10-10T10:00:00.000Z", completed_at: "2026-10-10T09:00:00.000Z" }),
        task({ deadline: "2026-10-10T10:00:00.000Z", completed_at: "2026-10-11T09:00:00.000Z", review_state: "pending" }),
        task({ deadline: null }),
      ],
      ME,
      october,
    );
    expect(summary).toMatchObject({ finished: 3, onTime: 1, late: 1, undated: 1, awaitingReview: 1 });
    expect(countLine(summary)).toBe("3 tasks — 1 on time, 1 late, 1 without a deadline");
  });

  it("without an identity, work asked of the viewer is still theirs, and nobody's is nobody's", () => {
    const anonymous: Viewer = { ownerId: "user-1", selfId: "" };
    const summary = summarize([task({ direction: "received" }), task({})], anonymous, october);
    expect(summary.groups.map((g) => g.who)).toEqual(["you", "nobody"]);
  });
});

describe("summaryText", () => {
  const october = { year: 2026, month: 10 };
  const bounds = monthBounds(october, HCM);

  it("lists each group's work by day, saying how late", () => {
    const summary = summarize(
      [
        task({ title: "Redo the thumbnail", assignee_discord_id: ERIK, completed_at: "2026-10-02T03:00:00.000Z" }),
        task({
          title: "Cut the trailer",
          assignee_discord_id: ALICE,
          deadline: "2026-10-20T10:00:00.000Z",
          completed_at: "2026-10-22T10:00:00.000Z",
        }),
      ],
      ME,
      bounds,
    );
    const text = summaryText(summary, october, {
      timeZone: HCM,
      nameOf: (group) => (group.who === "you" ? "Erik" : "Alice"),
    });
    expect(text).toBe(
      [
        "Finished in October 2026: 2 tasks — 1 late, 1 without a deadline",
        "",
        "Erik (1)",
        "• Oct 2 — Redo the thumbnail",
        "",
        "Alice (1)",
        "• Oct 22 — Cut the trailer (late by 2 days)",
      ].join("\n"),
    );
  });

  it("carries each person's score for the month when there is one", () => {
    const summary = summarize(
      [task({ title: "Cut the trailer", assignee_discord_id: ALICE, completed_at: "2026-10-22T10:00:00.000Z" })],
      ME,
      bounds,
    );
    const text = summaryText(summary, october, { timeZone: HCM, nameOf: () => "Alice", scoreOf: () => "−1" });
    expect(text.split("\n")[2]).toBe("Alice (1) · score −1");
  });

  it("says so when nothing was finished", () => {
    expect(summaryText(summarize([], ME, bounds), october, { timeZone: HCM, nameOf: () => "" })).toBe(
      "Nothing finished in October 2026.",
    );
  });
});
