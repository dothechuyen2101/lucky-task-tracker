import { describe, expect, it } from "vitest";

import {
  DM_LIST_MAX,
  assignedNotice,
  assigneeAnswerReply,
  byUrgency,
  candidatesFor,
  exactKnown,
  filedReply,
  guestDmHelp,
  isNo,
  isYes,
  knownOptions,
  memberOptions,
  notForThemNotice,
  notMineNotice,
  pickCandidate,
  pickNumbered,
  requestConfirmQuestion,
  plainHandles,
  taskListText,
  type ListedTask,
} from "./dm";

const MINH = { id: "222222222222222222", name: "minh" };
const MINHANH = { id: "333333333333333333", name: "minhanh" };
const LAN = { id: "444444444444444444", name: "Lan Nguyễn" };
const NOW = new Date("2026-10-02T10:00:00.000Z");

describe("plainHandles — names typed in a DM, where @ offers nobody", () => {
  it("reads @names as words, in order, each once", () => {
    expect(plainHandles("@minh redo the thumbnail, cc @Lan and @minh")).toEqual(["minh", "Lan"]);
  });

  it("is not fooled by markup, emails or @everyone", () => {
    expect(plainHandles("<@123456789012345678> mail me at a@b.com @everyone @here")).toEqual([]);
  });

  it("keeps accented names and trims trailing punctuation", () => {
    expect(plainHandles("(@Lân.) review this")).toEqual(["Lân"]);
  });
});

describe("exactKnown — the only match that assigns without asking", () => {
  const known = knownOptions([MINH, MINHANH, LAN, { id: MINH.id, name: "Minh Tran" }]);

  it("assigns a name that IS one known person's, case and accents aside", () => {
    expect(exactKnown(known, "@Minh")).toEqual({ id: MINH.id, name: "minh" });
    expect(exactKnown(known, "lan nguyen")).toEqual({ id: LAN.id, name: "Lan Nguyễn" });
    expect(exactKnown(known, "minh tran")?.id).toBe(MINH.id);
  });

  it("never assigns a name that only starts the same, or matches nobody", () => {
    // Lucky35, 2026-10-03: a near match sent the task to the wrong person.
    expect(exactKnown(known, "lan")).toBeNull();
    expect(exactKnown(known, "minha")).toBeNull();
    expect(exactKnown(known, "bao")).toBeNull();
  });

  it("never assigns when two known people share the name", () => {
    const twins = knownOptions([MINH, { id: "555555555555555555", name: "Minh" }]);
    expect(exactKnown(twins, "minh")).toBeNull();
  });
});

describe("candidatesFor — who a name might mean, for the owner to pick", () => {
  const known = knownOptions([MINH, MINHANH, LAN]);
  const members = memberOptions([
    { where: "Sim Server", member: { nick: "Bob (design)", user: { id: "1", username: "bob_t", global_name: "Bob Tran" } } },
    { where: "Other", member: { user: { id: "2", username: "bobby" } } },
    { where: "Sim Server", member: { user: { id: "3", username: "helper", bot: true } } },
    { where: "Other", member: { nick: null, user: { id: MINH.id, username: "minh" } } },
  ]);

  it("lists everyone whose name is it or starts with it, known people first, each once", () => {
    expect(candidatesFor("minh", known, members)).toEqual([
      { id: MINH.id, name: "minh", label: "minh", where: "worked with before" },
      { id: MINHANH.id, name: "minhanh", label: "minhanh", where: "worked with before" },
    ]);
    expect(candidatesFor("@bob", known, members)).toEqual([
      { id: "1", name: "bob_t", label: "Bob (design) (@bob_t)", where: "Sim Server" },
      { id: "2", name: "bobby", label: "@bobby", where: "Other" },
    ]);
  });

  it("matches a first name inside a longer one, and leaves bots out", () => {
    expect(candidatesFor("tran", known, members).map((c) => c.id)).toEqual(["1"]);
    expect(candidatesFor("helper", known, members)).toEqual([]);
  });

  it("is picked by number or by an exact label, never by a guess", () => {
    const choices = candidatesFor("@bob", known, members);
    expect(pickCandidate("2", choices)?.id).toBe("2");
    expect(pickCandidate("#1.", choices)?.id).toBe("1");
    expect(pickCandidate("@bobby", choices)?.id).toBe("2");
    expect(pickCandidate("3", choices)).toBeNull();
    expect(pickCandidate("the first one", choices)).toBeNull();
  });
});

describe("a request from someone else waits for its sender's yes", () => {
  it("reads a short yes, in English or Vietnamese", () => {
    for (const yes of ["yes", "Yes!", "ok", "send it", "có", "Đồng ý", "ừ"]) expect(isYes(yes), yes).toBe(true);
  });

  it("does not read a sentence that merely starts with ok as a yes", () => {
    for (const not of ["ok thanks", "ok I'll do it tomorrow", "no", "maybe later"]) expect(isYes(not), not).toBe(false);
  });

  it("reads a short no", () => {
    for (const no of ["no", "Không", "thôi", "cancel"]) expect(isNo(no), no).toBe(true);
    expect(isNo("no problem, I'll do it")).toBe(false);
  });

  it("asks before sending, quoting what it would send", () => {
    const text = requestConfirmQuestion("Luka", "can you review my draft by friday");
    expect(text).toContain("Send this to **Luka** as a task?");
    expect(text).toContain("> can you review my draft by friday");
    expect(text).toContain("Reply `yes`");
  });
});

describe("what the bot says in a DM", () => {
  it("confirms a task filed by DM: who, when, and how to change it", () => {
    const text = filedReply({ title: "Redo the thumbnail", deadline: "2026-10-03T10:00:00.000Z", assigneeName: "minh", unknownName: null, link: "https://t.example/?task=1" });
    expect(text).toContain("✅ Filed: **Redo the thumbnail**");
    expect(text).toContain("For **minh**");
    expect(text).toContain("<t:1791021600:F>");
    expect(text).toContain("Reply to this message");
    expect(text).toContain("<https://t.example/?task=1>");
  });

  it("asks who a name meant, numbered, and offers no change until then", () => {
    const text = filedReply({
      title: "T",
      deadline: null,
      assigneeName: null,
      unknownName: "bob",
      candidates: [
        { id: "1", name: "bob_t", label: "Bob Tran (@bob_t)", where: "Sim Server" },
        { id: "2", name: "bobby", label: "@bobby", where: "Other" },
      ],
      link: null,
    });
    expect(text).toContain(`Who is "bob"? It isn't given to anyone until you say`);
    expect(text).toContain("1. Bob Tran (@bob_t) · Sim Server");
    expect(text).toContain("2. @bobby · Other");
    expect(text).not.toContain("deadline friday 5pm");
  });

  it("says plainly when a name matched nobody", () => {
    expect(filedReply({ title: "T", deadline: null, assigneeName: null, unknownName: "bao", link: null })).toContain(
      `I don't know who "bao" is`,
    );
  });

  it("tells an assignee what they were given, and never links into someone else's DM", () => {
    const text = assignedNotice({
      ownerName: "Luka",
      title: "Redo the thumbnail",
      deadline: null,
      detail: "",
      sourceUrl: "https://discord.com/channels/@me/1/2",
      link: "https://t.example/?task=1",
      mine: "https://t.example/?mine",
    });
    expect(text).toContain("**Luka** gave you a task:");
    expect(text).toContain("No deadline yet.");
    expect(text).not.toContain("@me");
    expect(text).toContain("All your tasks, from everyone: <https://t.example/?mine>");
  });

  it("answers an assignee's start / done / stop / resume", () => {
    expect(assigneeAnswerReply("start", "T", "Luka")).toContain("in progress");
    expect(assigneeAnswerReply("done", "T", "Luka")).toBe("🏁 Reported done, with your proof: **T**. Luka has been told and will review it.");
    expect(assigneeAnswerReply("mute", "T", "Luka")).toContain("No more reminders");
    expect(assigneeAnswerReply("unmute", "T", null)).toContain("back on");
    expect(guestDmHelp("Luka")).toContain("goes to **Luka** as a task");
  });
});

describe("taskListText — 'my tasks' in a DM", () => {
  const task = (title: string, deadline: string | null, extra: Partial<ListedTask> = {}): ListedTask => ({
    title,
    deadline,
    assignee_name: null,
    direction: "given",
    counterparty: null,
    ...extra,
  });

  it("puts overdue first, then soonest, undated last, numbered", () => {
    const tasks = [task("Later", "2026-10-09T10:00:00.000Z"), task("Undated", null), task("Late", "2026-10-01T10:00:00.000Z")];
    expect(byUrgency(tasks, NOW).map((t) => t.title)).toEqual(["Late", "Later", "Undated"]);
    const text = taskListText(tasks, NOW, { heading: "On you:", empty: "-", link: "https://t.example/?mine", forGiver: false });
    expect(text.split("\n")[1]).toMatch(/^1\. \*\*Late\*\* — \*\*overdue\*\*/);
    expect(text).toContain("3. **Undated** — no deadline");
    expect(text).toContain("<https://t.example/?mine>");
  });

  it("says who each is for when the giver asks", () => {
    const text = taskListText([task("A", null, { assignee_name: "minh" }), task("B", null, { direction: "received", counterparty: "Bao" })], NOW, {
      heading: "Open:",
      empty: "-",
      link: null,
      forGiver: true,
    });
    expect(text).toContain("**A** — no deadline · for minh");
    expect(text).toContain("**B** — no deadline · Bao asked you");
  });

  it("counts what it cannot list, and fits one message", () => {
    const many = Array.from({ length: 40 }, (_, i) => task(`Task ${i} ${"x".repeat(70)}`, null));
    const text = taskListText(many, NOW, { heading: "On you:", empty: "-", link: null, forGiver: false });
    expect(text).toContain(`…and ${40 - DM_LIST_MAX} more.`);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(taskListText([], NOW, { heading: "x", empty: "Nothing on you.", link: null, forGiver: false })).toBe("Nothing on you.");
  });

  it("picks by number, 1-based, or nothing", () => {
    expect(pickNumbered(["a", "b"], 2)).toBe("b");
    expect(pickNumbered(["a", "b"], 0)).toBeNull();
    expect(pickNumbered(["a", "b"], 3)).toBeNull();
  });
});

describe("copied in, not given the work (Cenri, 2026-10-20)", () => {
  it("tells someone taken off a card that it was never on them, and that reminders stop", () => {
    const text = notForThemNotice("Share CTAs in one Excel", "Cenri");
    expect(text).toContain("only copied in on **Share CTAs in one Excel**");
    expect(text).toContain("Cenri took you off it");
    expect(text).toContain("no more reminders");
  });

  it("tells the reviewer who says it is not theirs, and where to take them off", () => {
    const text = notMineNotice("umer_farooq15", "Share CTAs in one Excel", "https://tracker.example/?task=t1");
    expect(text).toContain("**umer_farooq15** says **Share CTAs in one Excel** is not theirs");
    expect(text).toContain("<https://tracker.example/?task=t1>");
    expect(notMineNotice("umer", "T", null)).not.toContain("Open it");
  });
});
