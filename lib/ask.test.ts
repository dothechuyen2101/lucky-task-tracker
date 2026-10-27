import { describe, expect, it } from "vitest";

import {
  ASK_MAX_MATCHES,
  type AskTask,
  askLines,
  cleanQuestion,
  dayIn,
  matchesOf,
  peopleLegend,
  pickedCount,
  standing,
  tally,
  todayIn,
} from "./ask";

const task = (id: string, overrides: Partial<AskTask> = {}): AskTask => ({
  id,
  title: `Task ${id}`,
  detail: "",
  assignee_name: "Leo Trịnh",
  assignee_discord_id: "868336690224304160",
  status: "open",
  stage: 2,
  review_state: null,
  deadline: null,
  created_at: "2026-10-05T20:00:00.000Z",
  completed_at: null,
  requested_by_name: null,
  ...overrides,
});

describe("ask — did I already give someone a task about X (Lucky35, 2026-10-12)", () => {
  it("takes a question in plain words, and nothing that is not one", () => {
    expect(cleanQuestion("  did I give anyone\n the GPU server?  ")).toBe("did I give anyone the GPU server?");
    expect(cleanQuestion("hi")).toBeNull();
    expect(cleanQuestion(42)).toBeNull();
    expect(cleanQuestion("x".repeat(500))).toHaveLength(300);
  });

  it("writes every task as one numbered line, in the owner's zone", () => {
    const lines = askLines(
      [
        task("a", { title: "Test GPU server", deadline: "2026-10-07T05:00:00.000Z", detail: "rent one\nfor a week" }),
        task("b", { title: "Upload tracker", status: "done", stage: 4, completed_at: "2026-10-06T02:00:00.000Z", requested_by_name: "Cenri" }),
        task("c", { title: "Thumbnail", assignee_name: null, assignee_discord_id: null, status: "done", review_state: "pending", stage: 3 }),
      ],
      "Asia/Bangkok",
    ).split("\n");
    expect(lines[0]).toBe("[1] Test GPU server — for Leo Trịnh — open, in progress — given 2026-10-06 — due 2026-10-07 — detail: rent one for a week");
    expect(lines[1]).toBe("[2] Upload tracker — for Leo Trịnh — done — given 2026-10-06 — finished 2026-10-06 — asked by Cenri");
    expect(lines[2]).toBe("[3] Thumbnail — for nobody yet — reported done, waiting for review — given 2026-10-06");
  });

  it("shows only tasks that are on the list — a number Claude made up is dropped", () => {
    const tasks = [task("a"), task("b"), task("c")];
    const matches = matchesOf(
      [
        { index: 2, why: "same server" },
        { index: 9, why: "invented" },
        { index: 2, why: "again" },
        { index: 0, why: "not a number on the list" },
        { index: 1.7, why: "trimmed to 1" },
      ],
      tasks,
    );
    expect(matches.map((m) => [m.task.id, m.why])).toEqual([
      ["b", "same server"],
      ["a", "trimmed to 1"],
    ]);
  });

  it("drops a reason that only repeats the title", () => {
    const [match] = matchesOf([{ index: 1, why: "  task A  " }], [task("a", { title: "Task A" })]);
    expect(match.why).toBe("");
  });

  it("keeps a handful of matches, not the whole board", () => {
    const tasks = Array.from({ length: 40 }, (_, i) => task(`t${i}`));
    expect(matchesOf(tasks.map((_, i) => ({ index: i + 1 })), tasks)).toHaveLength(ASK_MAX_MATCHES);
  });

  it("names the other names people go by, so a question by nickname finds them (2026-10-13)", () => {
    const tasks = [
      task("a", { assignee_discord_id: "376350654727323659", assignee_name: "jiaismybaby" }),
      task("b", { assignee_discord_id: "376350654727323659", assignee_name: "sandyismybaby" }),
      task("c", { assignee_discord_id: "868336690224304160", assignee_name: "thuan2172001" }),
      task("d", { assignee_discord_id: "1", assignee_name: "solo" }),
    ];
    const legend = peopleLegend(
      tasks,
      new Map([
        ["376350654727323659", ["Cenri", "JIAISMYBABY"]],
        ["868336690224304160", ["Leo Trịnh"]],
      ]),
    );
    expect(legend.split("\n")).toEqual(["- jiaismybaby: also sandyismybaby, Cenri", "- thuan2172001: also Leo Trịnh"]);
    expect(peopleLegend(tasks.slice(3), new Map())).toBe("");
  });

  it("counts every pick on the list, beyond the ones shown", () => {
    const tasks = Array.from({ length: 40 }, (_, i) => task(`t${i}`));
    const picked = [...tasks.map((_, i) => ({ index: i + 1 })), { index: 99 }, { index: 1 }];
    expect(pickedCount(picked, tasks)).toBe(40);
    expect(pickedCount(picked, tasks) - matchesOf(picked, tasks).length).toBe(40 - ASK_MAX_MATCHES);
  });

  it("figures come from the tasks, not from the sentence", () => {
    const matches = matchesOf(
      [{ index: 1 }, { index: 2 }, { index: 3 }, { index: 4 }],
      [task("a"), task("b", { status: "done" }), task("c", { status: "done", review_state: "pending" }), task("d", { status: "dismissed" })],
    );
    expect(tally(matches)).toEqual({ open: 1, waiting: 1, done: 1, other: 1 });
  });

  it("says where a task stands", () => {
    expect(standing({ status: "open", stage: 0, review_state: null })).toBe("open, not started");
    expect(standing({ status: "done", stage: 3, review_state: "pending" })).toBe("reported done, waiting for review");
    expect(standing({ status: "dismissed", stage: 0, review_state: null })).toBe("dismissed");
  });

  it("today carries its weekday, in the owner's zone", () => {
    expect(todayIn(new Date("2026-10-12T20:00:00.000Z"), "Asia/Bangkok")).toBe("2026-10-13 (Tuesday)");
    expect(todayIn(new Date("2026-10-12T20:00:00.000Z"), "UTC")).toBe("2026-10-12 (Monday)");
  });

  it("dates fall back to UTC when the zone is not one", () => {
    expect(dayIn("2026-10-05T20:00:00.000Z", "Not/AZone")).toBe("2026-10-05");
    expect(dayIn(null, "UTC")).toBeNull();
  });
});
