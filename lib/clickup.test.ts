import { describe, expect, it } from "vitest";

import {
  type ClickUpTaskRaw,
  clickUpMembersOf,
  clickUpStatusCounts,
  lastClickUpChange,
  linksByEmail,
  memberEmailsOf,
  newDevelopers,
  parseDevView,
  peopleWithOpenWork,
  sameTask,
  splitTasks,
  statusMeaning,
  storedTask,
  tasksByPerson,
  tasksInStatuses,
} from "./clickup";

// Statuses as LOOKUP MEDIA's lists define them (2026-10-12).
const S = {
  todo: { status: "to do", color: "#ffc53d", type: "open", orderindex: 0 },
  blocked: { status: "blocked", color: "#646464", type: "unstarted", orderindex: 1 },
  research: { status: "research phase", color: "#1090e0", type: "unstarted", orderindex: 2 },
  dev: { status: "dev in progress", color: "#30a46c", type: "custom", orderindex: 4 },
  review: { status: "code review", color: "#3e63dd", type: "custom", orderindex: 5 },
  merged: { status: "code merged", color: "#30a609", type: "done", orderindex: 9 },
  live: { status: "live", color: "#3db88b", type: "done", orderindex: 10 },
  complete: { status: "complete", color: "#008844", type: "closed", orderindex: 11 },
};

const LEO = 62515434;
const UMER = 101516312;
const SYNCED = "2026-10-12T09:00:00.000Z";

const raw = (id: string, status: ClickUpTaskRaw["status"], updated: number, assignees: number[] = [LEO], extra: Partial<ClickUpTaskRaw> = {}): ClickUpTaskRaw => ({
  id,
  name: `Task ${id}`,
  url: `https://app.clickup.com/t/${id}`,
  status,
  date_created: "1000",
  date_updated: String(updated),
  due_date: null,
  list: { id: "l1", name: "Under Dev" },
  assignees: assignees.map((a) => ({ id: a, username: a === LEO ? "Leo Trịnh" : a === UMER ? "Umer Farooq" : `user${a}` })),
  ...extra,
});

const task = (...args: Parameters<typeof raw>) => storedTask(raw(...args), "owner", SYNCED);

describe("storedTask — one row per ClickUp task, done ones too (2026-10-12)", () => {
  it("keeps ClickUp's own status, colour and kind, and who is on it", () => {
    expect(storedTask(raw("a", { ...S.review, status: "Code Review" }, 4000, [LEO, UMER]), "owner", SYNCED)).toEqual({
      owner_id: "owner",
      id: "a",
      name: "Task a",
      url: "https://app.clickup.com/t/a",
      status: "code review",
      color: "#3e63dd",
      type: "custom",
      orderindex: 5,
      list: "Under Dev",
      assignee_ids: [String(LEO), String(UMER)],
      assignee_names: ["Leo Trịnh", "Umer Farooq"],
      created_at: new Date(1000).toISOString(),
      updated_at: new Date(4000).toISOString(),
      done_at: null,
      due_at: null,
      synced_at: SYNCED,
    });
  });

  it("a finished task says when it was finished", () => {
    expect(storedTask(raw("b", S.live, 5000, [LEO], { date_done: "4500" }), "owner", SYNCED).done_at).toBe(new Date(4500).toISOString());
    expect(storedTask(raw("c", S.complete, 6000, [LEO], { date_closed: "5900" }), "owner", SYNCED).done_at).toBe(new Date(5900).toISOString());
  });

  it("sameTask: nothing written when nothing changed — whatever form the database gave the time in", () => {
    const now = task("a", S.dev, 4000);
    const fromDb = { ...now, updated_at: new Date(4000).toISOString().replace("Z", "+00:00") };
    expect(sameTask(fromDb, now)).toBe(true);
    expect(sameTask(now, task("a", S.review, 5000))).toBe(false);
    expect(sameTask(null, now)).toBe(false);
  });
});

describe("a person's tasks — open first, done underneath", () => {
  const tasks = [
    task("todo", S.todo, 9),
    task("blocked", S.blocked, 8),
    task("dev", S.dev, 1),
    task("review", S.review, 2),
    task("live-old", S.live, 3, [LEO], { date_done: "3" }),
    task("live-new", S.live, 7, [LEO], { date_done: "7" }),
    task("umer", S.dev, 5, [UMER]),
  ];

  it("splits a person's work: being worked on first, done newest first", () => {
    const { open, done } = splitTasks(tasksByPerson(tasks).get(String(LEO)));
    expect(open.map((t) => t.status)).toEqual(["code review", "dev in progress", "blocked", "to do"]);
    expect(done.map((t) => t.id)).toEqual(["live-new", "live-old"]);
  });

  it("a task with two people on it is on both", () => {
    const shared = task("shared", S.dev, 1, [LEO, UMER]);
    const byPerson = tasksByPerson([shared]);
    expect(byPerson.get(String(LEO))).toEqual([shared]);
    expect(byPerson.get(String(UMER))).toEqual([shared]);
  });

  it("the newest change among their tasks", () => {
    expect(lastClickUpChange(tasks)).toBe(new Date(9).toISOString());
    expect(lastClickUpChange([])).toBeNull();
  });
});

describe("peopleWithOpenWork / newDevelopers — the list finds its developers", () => {
  const members = [
    { id: String(LEO), name: "Leo Trịnh", initials: "LT", color: null },
    { id: String(UMER), name: "Umer Farooq", initials: "UF", color: null },
    { id: "300806349", name: "Luka Pecirep", initials: "LP", color: null },
  ];

  it("everyone with unfinished work — not those whose work is all done", () => {
    const people = peopleWithOpenWork(
      [task("a", S.blocked, 1, [LEO]), task("b", S.dev, 2, [UMER, LEO]), task("c", S.live, 3, [300806349]), task("d", S.review, 4, [294812354])],
      members,
    );
    expect(people.map((p) => [p.id, p.name])).toEqual([
      [String(LEO), "Leo Trịnh"],
      [String(UMER), "Umer Farooq"],
      ["294812354", "user294812354"],
    ]);
  });

  it("adds only who has no row yet — a hidden row still counts", () => {
    const people = peopleWithOpenWork([task("a", S.dev, 1, [LEO, UMER])], members);
    expect(newDevelopers(people, [String(LEO), null]).map((p) => p.name)).toEqual(["Umer Farooq"]);
    expect(newDevelopers(people, [String(LEO), String(UMER)])).toEqual([]);
  });
});

describe("linksByEmail — who signs in as whom, only when certain", () => {
  const members = [
    { id: "62515434", email: "leo@example.com" },
    { id: "240228556", email: "tom@example.com" },
    { id: "1", email: "shared@example.com" },
    { id: "2", email: "shared@example.com" },
  ];

  it("links an exact email held once on each side", () => {
    const links = linksByEmail(members, [
      { discord_id: "868336690224304160", email: " Leo@Example.com ", name: "thuan2172001" },
      { discord_id: "9", email: "someone-else@example.com", name: null },
    ]);
    expect(links).toEqual([{ clickupId: "62515434", discordId: "868336690224304160", name: "thuan2172001" }]);
  });

  it("never links on a shared email, on either side", () => {
    expect(linksByEmail(members, [{ discord_id: "7", email: "shared@example.com", name: null }])).toEqual([]);
    expect(
      linksByEmail(members, [
        { discord_id: "7", email: "tom@example.com", name: null },
        { discord_id: "8", email: "tom@example.com", name: null },
      ]),
    ).toEqual([]);
  });

  it("reads members' emails for the worker only", () => {
    expect(memberEmailsOf({ id: 1, members: [{ user: { id: 5, email: " A@B.com " } }, { user: { id: 6, email: null } }] })).toEqual([{ id: "5", email: "a@b.com" }]);
  });
});

describe("status meanings and the status filter (PO, 2026-10-12)", () => {
  const tasks = [task("a", S.blocked, 1), task("b", S.blocked, 2, [UMER]), task("c", S.review, 3, [UMER]), task("d", S.live, 4), task("c", S.review, 3, [UMER])];

  it("explains the team's statuses, done ones too, and any other by its kind", () => {
    expect(statusMeaning("BLOCKED", "unstarted")).toMatch(/waiting on something or someone/);
    expect(statusMeaning("code review", "custom")).toMatch(/waiting for someone to check it/);
    expect(statusMeaning("live", "done")).toMatch(/shipped/);
    expect(statusMeaning("qa on staging", "custom")).toBe("Being worked on.");
    expect(statusMeaning("someday", "open")).toBe("Not started yet.");
  });

  it("counts every status once per task, in the order work moves through them, done last", () => {
    expect(clickUpStatusCounts(tasks).map((s) => `${s.status} · ${s.count}`)).toEqual(["code review · 1", "blocked · 2", "live · 1"]);
  });

  it("picking statuses keeps only those tasks; nothing picked is everything", () => {
    expect(tasksInStatuses(tasks, ["CODE REVIEW", "live"]).map((t) => t.id)).toEqual(["c", "d", "c"]);
    expect(tasksInStatuses(tasks, [])).toHaveLength(5);
  });

  it("reads back what the browser kept, and anything unreadable as the default", () => {
    expect(parseDevView({ statuses: ["Blocked", "blocked", 3, ""], legend: false })).toEqual({ statuses: ["blocked"], legend: false });
    expect(parseDevView("nonsense")).toEqual({ statuses: [], legend: true });
  });
});

describe("clickUpMembersOf", () => {
  it("lists people by name, without their email", () => {
    const members = clickUpMembersOf({
      id: 1,
      members: [
        { user: { id: 62515434, username: "Leo Trịnh", email: "x@example.com", initials: "LT", color: "#000" } },
        { user: { id: 107459908, username: "Naukhaiz Anjum", email: "y@example.com", initials: "NA", color: null } },
        { user: null },
      ],
    });
    expect(members).toEqual([
      { id: "62515434", name: "Leo Trịnh", initials: "LT", color: "#000" },
      { id: "107459908", name: "Naukhaiz Anjum", initials: "NA", color: null },
    ]);
    expect(JSON.stringify(members)).not.toContain("@");
  });
});
