import { describe, expect, it } from "vitest";

import {
  type BoardFilter,
  type BoardView,
  DEFAULT_VIEW,
  SORT_OPTIONS,
  type Viewer,
  boardFigures,
  canReview,
  parseView,
  priorityOf,
  toReview,
  viewIsDefault,
  bucketOf,
  endOfDay,
  filterTasks,
  focusAfterRemoval,
  groupMine,
  originOf,
  originLine,
  askedByViewer,
  formatWhen,
  fromZonedInput,
  isAskedByViewer,
  isAssignedToViewer,
  isShared,
  knownPeople,
  missingOf,
  personColor,
  personKeyOf,
  personLabelOf,
  personOnCard,
  resolveFocus,
  sortForCard,
  stepFocus,
  nextDeadlineAfter,
  tasksOfPerson,
  toZonedInput,
  urgencyOf,
} from "./board";
import { PROJECT_COLORS } from "./colors";
import type { Task } from "./types/database";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const DAY = 86_400_000;

const ALICE = "222222222222222222";
const BOB = "333333333333333333";
const ERIK = "111111111111111111";

let seq = 0;

/**
 * A complete Task, because `pnpm typecheck` reads this file too and a partial
 * literal would run under vitest and fail the gate.
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

/** Erik, signed in as account user-1. */
const ME: Viewer = { ownerId: "user-1", selfId: ERIK };

const ids = (tasks: Task[]) => tasks.map((t) => t.id);

describe("bucketOf", () => {
  it("bucketOf walks all six outcomes", () => {
    expect(bucketOf(task({ status: "done" }), NOW)).toBe("closed");
    expect(bucketOf(task({ status: "dismissed", deadline: new Date(NOW.getTime() - DAY).toISOString() }), NOW)).toBe(
      "closed",
    );
    expect(bucketOf(task({ deadline: null }), NOW)).toBe("undated");
    expect(bucketOf(task({ deadline: new Date(NOW.getTime() - DAY).toISOString() }), NOW)).toBe("overdue");
    expect(bucketOf(task({ deadline: new Date(NOW.getTime() + 3_600_000).toISOString() }), NOW)).toBe("today");
    expect(bucketOf(task({ deadline: new Date(NOW.getTime() + 3 * DAY).toISOString() }), NOW)).toBe("week");
    expect(bucketOf(task({ deadline: new Date(NOW.getTime() + 30 * DAY).toISOString() }), NOW)).toBe("later");
  });
});

describe("identity", () => {
  it("personKeyOf snowflake is the raw id, trimmed but never folded", () => {
    expect(personKeyOf(task({ assignee_discord_id: ALICE }))).toBe(ALICE);
    expect(personKeyOf(task({ assignee_discord_id: ` ${ALICE} ` }))).toBe(ALICE);
    expect(personKeyOf(task({ assignee_discord_id: ALICE }))).not.toBe(personKeyOf(task({ assignee_discord_id: BOB })));
  });

  it("personKeyOf blank returns the empty string for null, undefined and empty", () => {
    expect(personKeyOf(task({ assignee_discord_id: null }))).toBe("");
    expect(personKeyOf(task({ assignee_discord_id: undefined as unknown as null }))).toBe("");
    expect(personKeyOf(task({ assignee_discord_id: "" }))).toBe("");
    expect(personKeyOf(task({ assignee_discord_id: "   " }))).toBe("");
  });

  it("personLabelOf falls back to the id when the name is null or blank", () => {
    expect(personLabelOf(task({ assignee_discord_id: ALICE, assignee_name: null }))).toBe(ALICE);
    expect(personLabelOf(task({ assignee_discord_id: ALICE, assignee_name: "  " }))).toBe(ALICE);
    expect(personLabelOf(task({ assignee_discord_id: ALICE, assignee_name: "" }))).toBe(ALICE);
    expect(personLabelOf(task({ assignee_discord_id: ALICE, assignee_name: "Khalix" }))).toBe("Khalix");
  });

  it("personColor never accent, and always lands inside PROJECT_COLORS", () => {
    const palette = PROJECT_COLORS.map((hex) => hex.toLowerCase());
    for (let i = 0; i < 500; i += 1) {
      const color = personColor(`key-${i}-${i * 7919}`);
      expect(typeof color).toBe("string");
      expect(color.toLowerCase()).not.toBe("#7c5cff");
      expect(palette).toContain(color.toLowerCase());
    }
    expect(personColor("")).not.toBe(undefined);
  });
});

describe("whose task is this", () => {
  it("a row owned by another account is shared, and is on the viewer", () => {
    const given = task({ user_id: "user-2", owner_name: "Lucky35", assignee_discord_id: ERIK });
    expect(isShared(given, ME)).toBe(true);
    expect(isAssignedToViewer(given, ME)).toBe(true);
    expect(isAskedByViewer(given, ME)).toBe(false);
  });

  it("received work and work given to yourself are on you; given work is what you asked for", () => {
    expect(isAssignedToViewer(task({ direction: "received" }), ME)).toBe(true);
    expect(isAssignedToViewer(task({ assignee_discord_id: ERIK }), ME)).toBe(true);
    expect(isAskedByViewer(task({ assignee_discord_id: ERIK }), ME)).toBe(false);

    const toAlice = task({ assignee_discord_id: ALICE });
    expect(isAssignedToViewer(toAlice, ME)).toBe(false);
    expect(isAskedByViewer(toAlice, ME)).toBe(true);
    expect(isAskedByViewer(task({ assignee_discord_id: null }), ME)).toBe(true);
  });

  it("an empty self id never matches an unassigned task", () => {
    const noDiscord: Viewer = { ownerId: "user-1", selfId: "" };
    expect(isAssignedToViewer(task({ assignee_discord_id: null }), noDiscord)).toBe(false);
  });
});

describe("missingOf", () => {
  it("flags given work with nobody on it, and open work with no deadline", () => {
    expect(missingOf(task(), ME)).toEqual({ assignee: true, deadline: true });
    expect(
      missingOf(task({ assignee_discord_id: ALICE, deadline: new Date(NOW.getTime() + DAY).toISOString() }), ME),
    ).toEqual({ assignee: false, deadline: false });
  });

  it("never asks for an assignee on received or shared work — that is already on you", () => {
    expect(missingOf(task({ direction: "received" }), ME).assignee).toBe(false);
    expect(missingOf(task({ user_id: "user-2", assignee_discord_id: ERIK }), ME).assignee).toBe(false);
  });

  it("does not nag a closed task for a deadline", () => {
    expect(missingOf(task({ status: "done" }), ME).deadline).toBe(false);
  });
});

describe("filterTasks — To review", () => {
  it("holds the viewer's work its assignee says is finished, longest-waiting first, and nothing else", () => {
    const later = task({ assignee_discord_id: ALICE, status: "done", completed_by: "assignee", review_state: "pending", completed_at: "2026-09-07T10:00:00.000Z" });
    const sooner = task({ assignee_discord_id: ALICE, status: "done", completed_by: "assignee", review_state: "pending", completed_at: "2026-09-06T10:00:00.000Z" });
    const accepted = task({ assignee_discord_id: ALICE, status: "done", completed_by: "assignee", review_state: "accepted" });
    const open = task();
    // Given TO the viewer by another account: not theirs to review.
    const theirs = task({ user_id: "user-2", assignee_discord_id: ERIK, status: "done", completed_by: "assignee", review_state: "pending" });

    const all = [later, sooner, accepted, open, theirs];
    expect(ids(filterTasks(all, { filter: "review", query: "", viewer: ME, now: NOW }))).toEqual([sooner.id, later.id]);
    expect(boardFigures(all, ME, NOW).toReview).toBe(2);
  });
});

describe("work asked through someone else's bot (2026-10-06)", () => {
  // Erik (account user-1) asked through Luka's bot (account user-2).
  const throughLuka = (overrides: Partial<Task> = {}) =>
    task({ user_id: "user-2", owner_name: "Luka", requested_by_discord_id: ERIK, requested_by_name: "Erik", ...overrides });

  it("is under the asker's 'I asked for', read only", () => {
    const toAlice = throughLuka({ assignee_discord_id: ALICE });
    expect(askedByViewer(toAlice, ME)).toBe(true);
    expect(isAskedByViewer(toAlice, ME)).toBe(true);
    expect(ids(filterTasks([toAlice], { filter: "asked", query: "", viewer: ME, now: NOW }))).toEqual([toAlice.id]);
    // Not on Erik: not "Assigned to me".
    expect(filterTasks([toAlice], { filter: "mine", query: "", viewer: ME, now: NOW })).toEqual([]);
  });

  it("a row merely given to the viewer is not one they asked for", () => {
    const given = task({ user_id: "user-2", owner_name: "Luka", assignee_discord_id: ERIK });
    expect(isAskedByViewer(given, ME)).toBe(false);
    expect(askedByViewer(given, ME)).toBe(false);
  });

  it("says where each card came from", () => {
    expect(originLine(throughLuka({ assignee_discord_id: ALICE }), ME)).toBe("You asked · on Luka's board");
    // Asked through Luka's bot, for themselves: it is on them — from Luka's board.
    expect(originLine(throughLuka({ assignee_discord_id: ERIK }), ME)).toBe("From Luka");
    // On the owner's own board.
    expect(originLine(task({ requested_by_name: "Cenri", assignee_discord_id: ALICE }), ME)).toBe("Cenri asked");
    expect(originLine(task({ direction: "received", counterparty: "Cenri" }), ME)).toBe("Cenri asked you");
    expect(originLine(task({ assignee_discord_id: ALICE }), ME)).toBeNull();
  });
});

describe("filterTasks — All / Assigned to me / I asked for / Done & dismissed", () => {
  const toAlice = task({ id: "to-alice", assignee_discord_id: ALICE, assignee_name: "alice" });
  const onMe = task({ id: "on-me", direction: "received", counterparty: "Bob" });
  const fromLucky = task({ id: "from-lucky", user_id: "user-2", owner_name: "Lucky35", assignee_discord_id: ERIK });
  const done = task({ id: "done", status: "done", completed_at: "2026-09-06T09:00:00.000Z" });
  const dismissed = task({ id: "dismissed", status: "dismissed", completed_at: "2026-09-07T09:00:00.000Z" });
  const all = [toAlice, onMe, fromLucky, done, dismissed];
  const run = (filter: "all" | "mine" | "asked" | "closed", query = "") =>
    ids(filterTasks(all, { filter, query, viewer: ME, now: NOW }));

  it("All is every open task, including the ones given to you", () => {
    expect(run("all").sort()).toEqual(["from-lucky", "on-me", "to-alice"]);
  });

  it("Assigned to me and I asked for split the open work between them", () => {
    expect(run("mine").sort()).toEqual(["from-lucky", "on-me"]);
    expect(run("asked")).toEqual(["to-alice"]);
  });

  it("Done & dismissed holds only closed work, most recently closed first", () => {
    expect(run("closed")).toEqual(["dismissed", "done"]);
  });

  it("searches names as well as the words of the task", () => {
    expect(run("all", "ALICE")).toEqual(["to-alice"]);
    expect(run("all", "lucky35")).toEqual(["from-lucky"]);
    expect(run("all", "bob")).toEqual(["on-me"]);
  });
});

describe("focus on the track", () => {
  it("keeps the focused card while it is on the track, and falls back to the first", () => {
    expect(resolveFocus(["a", "b", "c"], "b")).toBe("b");
    expect(resolveFocus(["a", "b", "c"], "gone")).toBe("a");
    expect(resolveFocus(["a", "b", "c"], null)).toBe("a");
    expect(resolveFocus([], "a")).toBeNull();
  });

  it("steps one card at a time and stops at either end", () => {
    expect(stepFocus(["a", "b", "c"], "b", 1)).toBe("c");
    expect(stepFocus(["a", "b", "c"], "c", 1)).toBe("c");
    expect(stepFocus(["a", "b", "c"], "a", -1)).toBe("a");
    expect(stepFocus(["a", "b", "c"], "gone", 1)).toBe("b");
    expect(stepFocus([], "a", 1)).toBeNull();
  });
});

describe("boardFigures", () => {
  it("counts open work only, and counts what is missing", () => {
    const figures = boardFigures(
      [
        task({ deadline: new Date(NOW.getTime() - DAY).toISOString(), assignee_discord_id: ALICE }),
        task({ deadline: new Date(NOW.getTime() + 3_600_000).toISOString() }),
        task({ direction: "received" }),
        task({ status: "done" }),
      ],
      ME,
      NOW,
    );
    expect(figures).toEqual({ open: 3, overdue: 1, today: 1, undated: 1, unassigned: 1, assignedToMe: 1, toReview: 0 });
  });
});

describe("knownPeople", () => {
  it("offers everybody the viewer has handed work to, by id, named when any row names them", () => {
    const people = knownPeople(
      [
        task({ assignee_discord_id: ALICE, assignee_name: null }),
        task({ assignee_discord_id: ALICE, assignee_name: "alice" }),
        task({ assignee_discord_id: BOB, assignee_name: "bob" }),
        task({ assignee_discord_id: ERIK, assignee_name: "erik" }),
        task({ user_id: "user-2", assignee_discord_id: ERIK }),
      ],
      [{ discord_user_id: "444444444444444444", display_name: "" }],
      ME,
    );
    expect(people).toEqual([
      { id: "444444444444444444", name: "@444444444444444444" },
      { id: ALICE, name: "alice" },
      { id: BOB, name: "bob" },
    ]);
  });
});

describe("sortForCard", () => {
  it("sortForCard puts overdue before today before week before later before undated", () => {
    const overdue = task({ id: "overdue", deadline: new Date(NOW.getTime() - DAY).toISOString() });
    const today = task({ id: "today", deadline: new Date(NOW.getTime() + 3_600_000).toISOString() });
    const week = task({ id: "week", deadline: new Date(NOW.getTime() + 3 * DAY).toISOString() });
    const later = task({ id: "later", deadline: new Date(NOW.getTime() + 30 * DAY).toISOString() });
    const undated = task({ id: "undated", deadline: null });
    const closed = task({ id: "closed", status: "done", deadline: new Date(NOW.getTime() - DAY).toISOString() });

    const sorted = sortForCard([undated, closed, later, overdue, week, today], NOW);
    expect(ids(sorted)).toEqual(["overdue", "today", "week", "later", "undated", "closed"]);
  });

  it("breaks a bucket tie on deadline ascending, then created_at descending", () => {
    const early = task({ id: "early", deadline: new Date(NOW.getTime() + 2 * DAY).toISOString() });
    const late = task({ id: "late", deadline: new Date(NOW.getTime() + 5 * DAY).toISOString() });
    const oldUndated = task({ id: "old", deadline: null, created_at: "2026-08-01T09:00:00.000Z" });
    const newUndated = task({ id: "new", deadline: null, created_at: "2026-09-05T09:00:00.000Z" });

    expect(ids(sortForCard([late, early], NOW))).toEqual(["early", "late"]);
    expect(ids(sortForCard([oldUndated, newUndated], NOW))).toEqual(["new", "old"]);
  });

  it("does not mutate the array it was handed", () => {
    const input = [
      task({ id: "undated", deadline: null }),
      task({ id: "overdue", deadline: new Date(NOW.getTime() - DAY).toISOString() }),
    ];
    const sorted = sortForCard(input, NOW);
    expect(ids(input)).toEqual(["undated", "overdue"]);
    expect(ids(sorted)).toEqual(["overdue", "undated"]);
  });
});

describe("urgencyOf", () => {
  it("is none without a deadline, overdue once passed, today before midnight, later after", () => {
    expect(urgencyOf(task(), NOW)).toBe("none");
    expect(urgencyOf(task({ deadline: new Date(NOW.getTime() - 60_000).toISOString() }), NOW)).toBe("overdue");
    expect(urgencyOf(task({ deadline: new Date(NOW.getTime() + 3_600_000).toISOString() }), NOW)).toBe("today");
    expect(urgencyOf(task({ deadline: new Date(NOW.getTime() + 3 * DAY).toISOString() }), NOW)).toBe("later");
  });

  it("does not call a finished task overdue", () => {
    const late = task({ status: "done", deadline: new Date(NOW.getTime() - DAY).toISOString() });
    expect(urgencyOf(late, NOW)).not.toBe("overdue");
  });
});

describe("personOnCard", () => {
  it("is the assignee on given work, and the viewer on work asked of them", () => {
    expect(personOnCard(task({ assignee_discord_id: ALICE }), ME)).toBe(ALICE);
    expect(personOnCard(task({ direction: "received" }), ME)).toBe(ERIK);
    expect(personOnCard(task({ user_id: "user-2", assignee_discord_id: ERIK }), ME)).toBe(ERIK);
    expect(personOnCard(task(), ME)).toBe("");
  });
});

describe("tasksOfPerson", () => {
  const toAlice = task({ id: "to-alice", assignee_discord_id: ALICE });
  const aliceElsewhere = task({ id: "alice-other-account", user_id: "user-2", assignee_discord_id: ALICE });
  const received = task({ id: "received", direction: "received" });
  const fromLucky = task({ id: "from-lucky", user_id: "user-2", assignee_discord_id: ERIK });
  const all = [toAlice, aliceElsewhere, received, fromLucky];

  it("gives another person only the work the viewer handed them", () => {
    expect(ids(tasksOfPerson(all, ALICE, ME))).toEqual(["to-alice"]);
  });

  it("gives the viewer everything that is on them", () => {
    expect(ids(tasksOfPerson(all, ERIK, ME)).sort()).toEqual(["from-lucky", "received"]);
  });

  it("gives nobody nothing", () => {
    expect(tasksOfPerson(all, "  ", ME)).toEqual([]);
  });
});

describe("nextDeadlineAfter — the board ticks when a card goes overdue", () => {
  it("is the soonest open deadline still ahead", () => {
    const soon = new Date(NOW.getTime() + 90_000).toISOString();
    const later = new Date(NOW.getTime() + DAY).toISOString();
    expect(nextDeadlineAfter([task({ deadline: later }), task({ deadline: soon })], NOW)).toBe(
      new Date(soon).getTime(),
    );
  });

  it("ignores deadlines already passed, closed tasks and tasks with none", () => {
    const passed = new Date(NOW.getTime() - 60_000).toISOString();
    const ahead = new Date(NOW.getTime() + 60_000).toISOString();
    expect(
      nextDeadlineAfter(
        [task({ deadline: passed }), task({ status: "done", deadline: ahead }), task({ deadline: null })],
        NOW,
      ),
    ).toBeNull();
  });

  it("never returns now itself — the tick has to be strictly ahead", () => {
    expect(nextDeadlineAfter([task({ deadline: NOW.toISOString() })], NOW)).toBeNull();
  });
});

describe("the person's own day, whatever machine renders it", () => {
  it("ends 'today' at midnight in the person's zone, not the machine's", () => {
    // 12:00Z is 19:00 in Ho Chi Minh City: its today ends at 16:59:59.999Z.
    expect(endOfDay(NOW, "Asia/Ho_Chi_Minh").toISOString()).toBe("2026-09-07T16:59:59.999Z");
    expect(endOfDay(NOW, "UTC").toISOString()).toBe("2026-09-07T23:59:59.999Z");
  });

  it("buckets a deadline by that day, so server and browser agree", () => {
    const tonightUtc = task({ deadline: "2026-09-07T20:00:00.000Z" });
    expect(bucketOf(tonightUtc, NOW, "UTC")).toBe("today");
    // 03:00 tomorrow in Ho Chi Minh City: not today there.
    expect(bucketOf(tonightUtc, NOW, "Asia/Ho_Chi_Minh")).toBe("week");
  });

  it("formats a time the same way anywhere, in the person's zone", () => {
    expect(formatWhen("2026-10-03T10:00:00.000Z", "Asia/Ho_Chi_Minh")).toBe("Oct 3, 2026, 5:00 PM");
    expect(formatWhen("2026-10-03T10:00:00.000Z", "Not/AZone")).toBe("Oct 3, 2026, 10:00 AM");
    expect(formatWhen(null, "UTC")).toBe("");
  });

  it("round-trips the deadline field through the person's zone", () => {
    expect(toZonedInput("2026-10-03T10:00:00.000Z", "Asia/Ho_Chi_Minh")).toBe("2026-10-03T17:00");
    expect(fromZonedInput("2026-10-03T17:00", "Asia/Ho_Chi_Minh")).toBe("2026-10-03T10:00:00.000Z");
    expect(fromZonedInput("", "UTC")).toBeNull();
    expect(fromZonedInput("0002-10-03T17:00", "UTC")).toBeNull();
  });
});

describe("focusAfterRemoval — closing the card in focus keeps your place", () => {
  it("moves to the next card, or the one before at the end, never the first", () => {
    expect(focusAfterRemoval(["a", "b", "c"], "b")).toBe("c");
    expect(focusAfterRemoval(["a", "b", "c"], "c")).toBe("b");
    expect(focusAfterRemoval(["a"], "a")).toBeNull();
    expect(focusAfterRemoval(["a", "b"], "z")).toBeNull();
  });
});

describe("search finds what the card shows", () => {
  it("matches the name from tt_people even when the task carries none", () => {
    const viewer: Viewer = { ownerId: "user-1", selfId: ERIK };
    const t = task({ assignee_discord_id: ALICE, assignee_name: null, title: "cut the teaser" });
    const names = new Map([[ALICE, "Alice Nguyen"]]);
    expect(filterTasks([t], { filter: "all", query: "nguyen", viewer, now: NOW, names })).toHaveLength(1);
    expect(filterTasks([t], { filter: "all", query: "nguyen", viewer, now: NOW })).toHaveLength(0);
  });
});

describe("My tasks — everything on the viewer, in one place", () => {
  const viewer: Viewer = { ownerId: "user-1", selfId: ERIK };
  const day = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString();

  it("gathers work given to the viewer from any account, and their own, by urgency", () => {
    const fromLuka = task({ user_id: "luka", owner_name: "Luka", assignee_discord_id: ERIK, deadline: day(-1) });
    const asked = task({ direction: "received", counterparty: "Bao", deadline: day(3) });
    const kept = task({ assignee_discord_id: ERIK });
    const handedOut = task({ assignee_discord_id: ALICE, deadline: day(1) });
    const groups = groupMine([handedOut, kept, asked, fromLuka], viewer, NOW, "UTC");
    expect(groups.map((g) => g.key)).toEqual(["overdue", "week", "undated"]);
    expect(groups[0].tasks).toEqual([fromLuka]);
    expect(groups.flatMap((g) => g.tasks)).not.toContain(handedOut);
  });

  it("keeps recently finished work, newest first, and lets older work go", () => {
    const recent = task({ assignee_discord_id: ERIK, status: "done", completed_at: day(-1) });
    const older = task({ assignee_discord_id: ERIK, status: "done", completed_at: day(-30) });
    const dismissed = task({ assignee_discord_id: ERIK, status: "dismissed", completed_at: day(-1) });
    const groups = groupMine([older, recent, dismissed], viewer, NOW, "UTC");
    expect(groups).toEqual([{ key: "done", label: "Finished in the last 14 days", tasks: [recent] }]);
  });

  it("says where each one came from", () => {
    expect(originOf(task({ user_id: "luka", owner_name: "Luka" }), viewer)).toBe("from Luka");
    expect(originOf(task({ direction: "received", counterparty: "Bao" }), viewer)).toBe("Bao asked you");
    expect(originOf(task({ assignee_discord_id: ERIK }), viewer)).toBe("you took it on");
  });
});

describe("priority, sort and filter over every tab (Lucky35's PO, 2026-10-07)", () => {
  const ZONE = "Asia/Ho_Chi_Minh";
  const high = task({ priority: "high", title: "high", deadline: "2026-09-10T10:00:00.000Z", created_at: "2026-09-01T09:00:00.000Z" });
  const medium = task({ title: "medium", deadline: "2026-09-08T10:00:00.000Z", created_at: "2026-09-03T09:00:00.000Z" });
  const low = task({ priority: "low", title: "low", deadline: null, created_at: "2026-09-02T09:00:00.000Z" });
  const all = [high, medium, low];
  const run = (view: Partial<BoardView>, filter: BoardFilter = "all", query = "") =>
    ids(filterTasks(all, { filter, query, viewer: ME, now: NOW, timeZone: ZONE, view: { ...DEFAULT_VIEW, ...view } }));

  it("reads a task with no priority as medium", () => {
    expect(priorityOf(task({ priority: undefined }))).toBe("medium");
    expect(priorityOf(task({ priority: "high" }))).toBe("high");
  });

  it("keeps the tab's own order by default", () => {
    expect(run({})).toEqual(ids(filterTasks(all, { filter: "all", query: "", viewer: ME, now: NOW, timeZone: ZONE })));
  });

  it("sorts by priority, deadline or date created, either way round — undated last by deadline", () => {
    expect(run({ sort: "priority", dir: "desc" })).toEqual([high.id, medium.id, low.id]);
    expect(run({ sort: "priority", dir: "asc" })).toEqual([low.id, medium.id, high.id]);
    expect(run({ sort: "deadline", dir: "asc" })).toEqual([medium.id, high.id, low.id]);
    expect(run({ sort: "deadline", dir: "desc" })).toEqual([high.id, medium.id, low.id]);
    expect(run({ sort: "created", dir: "desc" })).toEqual([medium.id, low.id, high.id]);
    expect(run({ sort: "created", dir: "asc" })).toEqual([high.id, low.id, medium.id]);
  });

  it("filters by priority, and by a deadline range in the person's own days", () => {
    expect(run({ priorities: ["high", "low"] })).toEqual(expect.arrayContaining([high.id, low.id]));
    expect(run({ priorities: ["high", "low"] })).toHaveLength(2);
    // 8 September in Ho Chi Minh City runs 7th 17:00 → 8th 16:59:59.999 UTC.
    expect(run({ from: "2026-09-08", to: "2026-09-08" })).toEqual([medium.id]);
    expect(run({ from: "2026-09-09" })).toEqual([high.id]);
    // A range leaves out tasks with no deadline.
    expect(run({ to: "2026-12-31" })).not.toContain(low.id);
  });

  it("combines with each other, with the search and with the tab", () => {
    expect(run({ priorities: ["high", "medium"], sort: "deadline", dir: "desc" }, "all", "high")).toEqual([high.id]);
    expect(run({ priorities: ["high"] }, "closed")).toEqual([]);
  });

  it("reads a stored view back safely", () => {
    expect(parseView(null)).toEqual(DEFAULT_VIEW);
    expect(parseView({ sort: "nope", dir: "sideways", priorities: ["high", "urgent"], from: "2026-10-09", to: "2026-10-01" })).toEqual({
      sort: "default",
      dir: "asc",
      priorities: ["high"],
      from: "2026-10-01",
      to: "2026-10-09",
    });
    expect(viewIsDefault(DEFAULT_VIEW)).toBe(true);
    expect(viewIsDefault({ ...DEFAULT_VIEW, priorities: ["low"] })).toBe(false);
    expect(SORT_OPTIONS.every((o) => parseView({ sort: o.sort, dir: o.dir }).sort === o.sort)).toBe(true);
  });
});

describe("who reviews (Lucky35's PO, 2026-10-07: the task's creator, and the owner)", () => {
  const CENRI = "555555555555555555";
  const reported = (overrides: Partial<Task> = {}) =>
    task({ assignee_discord_id: ALICE, status: "done", review_state: "pending", ...overrides });

  it("is the owner, on their own board", () => {
    expect(canReview(reported(), ME)).toBe(true);
    expect(toReview(reported(), ME)).toBe(true);
  });

  it("is the person who asked for it through the owner's bot", () => {
    const cenri: Viewer = { ownerId: "user-cenri", selfId: CENRI };
    expect(toReview(reported({ requested_by_discord_id: CENRI }), cenri)).toBe(true);
    expect(toReview(reported(), cenri)).toBe(false);
  });

  it("is never the person whose work it is", () => {
    const alice: Viewer = { ownerId: "user-alice", selfId: ALICE };
    expect(canReview(reported({ requested_by_discord_id: ALICE }), alice)).toBe(false);
    expect(canReview(task({ assignee_discord_id: ERIK }), ME)).toBe(false);
    expect(canReview(task({ assignee_discord_id: null }), ME)).toBe(false);
  });
});
