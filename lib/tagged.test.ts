import { describe, expect, it } from "vitest";

import { filterPeople, mergePeople, type PickablePerson } from "./members";
import { ASSIGNEE_FALLBACK_CADENCE_MINUTES, nextAlertFor } from "./reminders";
import { cardFields, cardsForEveryone, ccMentions, namesText, peopleOnCards, readableMentions, siblingsOf, splitCc, withoutCc } from "./tagged";
import type { Task } from "./types/database";

const OWNER = "219473743288729600";
const BOT = "1556177760500711504";
const REA = { id: "1481876168419311729", name: "rea031999" };
const CENRI = { id: "376350654727323659", name: "jiaismybaby" };
const NOW = new Date("2026-10-04T17:56:00.000Z");
const MESSAGE = "2f9649f7-b227-44e2-ab33-c48048189aef";

describe("peopleOnCards", () => {
  it("is everyone tagged, once each, in the order named", () => {
    expect(peopleOnCards([REA, CENRI, { ...REA, name: "again" }])).toEqual([REA, CENRI]);
  });

  it("never gives the owner or the bot a card", () => {
    expect(peopleOnCards([{ id: OWNER, name: "me" }, REA, { id: BOT, name: "bot" }], [OWNER, BOT])).toEqual([REA]);
  });

  it("is one card for nobody when nobody was tagged", () => {
    expect(peopleOnCards([])).toEqual([null]);
    expect(peopleOnCards(null)).toEqual([null]);
    expect(peopleOnCards([{ id: " ", name: "blank" }])).toEqual([null]);
  });

  it("keeps a name only when there is one", () => {
    expect(peopleOnCards([{ id: REA.id, name: "  " }])).toEqual([{ id: REA.id, name: null }]);
  });
});

describe("cardsForEveryone", () => {
  // "Send cutting costs breakdown to group chat": tagged Rea and Cenri,
  // deadline 48 hours, and the card came out with nobody on it.
  const draft: Partial<Task> = {
    title: "Send cutting costs breakdown to group chat",
    detail: "",
    direction: "given",
    status: "open",
    deadline: "2026-10-06T17:55:25.879Z",
    deadline_source: "auto",
    alert_every_minutes: 120,
    message_id: MESSAGE,
    // A single pick the old rule might have made, which every card replaces.
    assignee_discord_id: null,
    assignee_name: null,
  };

  it("gives each person tagged their own card", () => {
    const cards = cardsForEveryone(draft, [REA, CENRI], { messageId: MESSAGE, viaDm: false, now: NOW, ownerDiscordId: OWNER });
    expect(cards.map((c) => [c.assignee_discord_id, c.assignee_name, c.message_part])).toEqual([
      [REA.id, REA.name, 0],
      [CENRI.id, CENRI.name, 1],
    ]);
    // Same request on each.
    for (const card of cards) {
      expect(card.title).toBe(draft.title);
      expect(card.deadline).toBe(draft.deadline);
      expect(card.source_message_id).toBe(MESSAGE);
      expect(card.source_mentions).toEqual([REA, CENRI]);
    }
  });

  it("keeps message_id on the first card only — the index the old worker keys on", () => {
    const cards = cardsForEveryone(draft, [REA, CENRI], { messageId: MESSAGE, viaDm: false, now: NOW, ownerDiscordId: OWNER });
    expect(cards.map((c) => c.message_id)).toEqual([MESSAGE, null]);
  });

  it("counts a channel tag as telling them, and a DM to the bot as not", () => {
    const channel = cardsForEveryone(draft, [REA], { messageId: MESSAGE, viaDm: false, now: NOW, ownerDiscordId: OWNER });
    const dm = cardsForEveryone(draft, [REA], { messageId: MESSAGE, viaDm: true, now: NOW, ownerDiscordId: OWNER });
    expect(channel[0].assignee_told_at).toBe(NOW.toISOString());
    expect(dm[0].assignee_told_at).toBeNull();
  });

  it("schedules each card from the row as it will stand", () => {
    const silent = { ...draft, alert_every_minutes: null };
    const [card] = cardsForEveryone(silent, [REA], { messageId: MESSAGE, viaDm: false, now: NOW, ownerDiscordId: OWNER });
    // "No reminder" for the giver: the assignee's own stream schedules it.
    const expected = nextAlertFor({ ...silent, ...card, last_alert_at: null } as Task, NOW, OWNER);
    expect(card.next_alert_at).toBe(expected?.toISOString() ?? null);
    expect(card.next_alert_at).not.toBeNull();
    expect(ASSIGNEE_FALLBACK_CADENCE_MINUTES).toBeGreaterThan(0);
  });

  it("files one card with nobody on it when nobody was tagged — still on the board, shown as missing", () => {
    const cards = cardsForEveryone(draft, [], { messageId: MESSAGE, viaDm: false, now: NOW, ownerDiscordId: OWNER });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ assignee_discord_id: null, assignee_told_at: null, message_id: MESSAGE, message_part: 0 });
  });

  it("does not hand the owner a card for tagging themselves", () => {
    const cards = cardsForEveryone(draft, [{ id: OWNER, name: "me" }, REA], { messageId: MESSAGE, viaDm: false, now: NOW, ownerDiscordId: OWNER });
    expect(cards.map((c) => c.assignee_discord_id)).toEqual([REA.id]);
  });

  it("starts every person's reminders fresh", () => {
    const fields = cardFields(REA, 1, { messageId: MESSAGE, viaDm: false, people: [REA], toldAt: NOW.toISOString() });
    expect(fields).toMatchObject({ assignee_alerts_sent: 0, assignee_muted_at: null, assignee_overdue_alerts: 0, assignee_candidates: null });
  });
});

describe("namesText", () => {
  it("joins names the way a sentence does", () => {
    expect(namesText([])).toBe("");
    expect(namesText(["Rea"])).toBe("Rea");
    expect(namesText(["Rea", "Cenri"])).toBe("Rea and Cenri");
    expect(namesText(["Rea", "Cenri", "Minh"])).toBe("Rea, Cenri and Minh");
  });
});

describe("siblingsOf", () => {
  const card = (id: string, source: string | null) => ({ id, source_message_id: source });
  it("is the other cards the same message filed", () => {
    const tasks = [card("a", MESSAGE), card("b", MESSAGE), card("c", "other"), card("d", null)];
    expect(siblingsOf(tasks[0], tasks).map((t) => t.id)).toEqual(["b"]);
    expect(siblingsOf(tasks[3], tasks)).toEqual([]);
  });
});

describe("readableMentions", () => {
  const names: Record<string, string> = { [REA.id]: "Rea", [CENRI.id]: "Cenri", [BOT]: "TaskBot" };
  it("names everyone the message tagged", () => {
    expect(readableMentions(`<@${BOT}> <@${REA.id}> <@!${CENRI.id}> send me the breakdown`, (id) => names[id])).toBe(
      "@TaskBot @Rea @Cenri send me the breakdown",
    );
  });

  it("never shows a raw snowflake", () => {
    const text = readableMentions("<@1481676168419311729> see <#123> and <@&456>", () => null);
    expect(text).toBe("@someone see #channel and @role");
    expect(text).not.toMatch(/\d{6,}/);
  });
});

describe("members", () => {
  const person = (id: string, name: string, label: string, where: string | null = null): PickablePerson => ({ id, name, label, where });
  const rea = person(REA.id, "rea031999", "Rea (@rea031999)", "LookUp");
  const cenri = person(CENRI.id, "jiaismybaby", "Cenri (@jiaismybaby)", "LookUp");
  const tom = person("3", "tomsmith4754", "@tomsmith4754", "LookUp");

  it("offers the people worked with first, everyone once", () => {
    const known = [{ ...cenri, where: "worked with before" }];
    expect(mergePeople(known, [rea, cenri, tom]).map((p) => [p.id, p.where])).toEqual([
      [CENRI.id, "worked with before"],
      [REA.id, "LookUp"],
      ["3", "LookUp"],
    ]);
  });

  it("finds by display name or username, names that start with it first", () => {
    expect(filterPeople([tom, rea, cenri], "re").map((p) => p.id)).toEqual([REA.id]);
    expect(filterPeople([tom, rea, cenri], "@jia").map((p) => p.id)).toEqual([CENRI.id]);
    expect(filterPeople([tom, rea, cenri], "CENRI").map((p) => p.id)).toEqual([CENRI.id]);
    // "smith" is inside a username, not at the start of a word: still found.
    expect(filterPeople([tom, rea, cenri], "smith").map((p) => p.id)).toEqual(["3"]);
    expect(filterPeople([tom, rea, cenri], "zz")).toEqual([]);
  });

  it("is everyone, alphabetical, when nothing is typed", () => {
    expect(filterPeople([tom, rea, cenri], "").map((p) => p.label)).toEqual([
      "@tomsmith4754",
      "Cenri (@jiaismybaby)",
      "Rea (@rea031999)",
    ]);
  });

  it("reads past accents", () => {
    const an = person("4", "an", "Đặng Ân (@an)");
    expect(filterPeople([an], "dang an").map((p) => p.id)).toEqual(["4"]);
  });
});

describe("cc — tagged to be told, not to do it (Cenri, 2026-10-20)", () => {
  const JF = { id: "408534290981322753", name: "jfabsss" };
  const UMER = { id: "1426460366895972365", name: "umer_farooq15" };

  it("Cenri's message still gives both a card — no cc word, no guessing", () => {
    const content = `<@${JF.id}> after you placed the ctas in 1 excel please share it here with <@${UMER.id}> so he can import it in the tool\n\n<@${BOT}> 24 hours deadline`;
    expect(splitCc([JF, UMER], content)).toEqual({ doers: [JF, UMER], cc: [] });
  });

  it("the same message with \"cc\" gives umer no card", () => {
    const content = `<@${JF.id}> place the ctas in 1 excel and share it here so it can be imported, cc <@${UMER.id}>\n<@${BOT}> 24 hours deadline`;
    expect(splitCc([JF, UMER], content)).toEqual({ doers: [JF], cc: [UMER] });
  });

  it("reads cc:, /cc, FYI, and lists joined by commas, & and \"and\"", () => {
    const people = [JF, UMER, REA];
    for (const tail of [`cc: <@${UMER.id}>, <@${REA.id}>`, `/cc <@${UMER.id}> & <@${REA.id}>`, `FYI <@${UMER.id}> and <@${REA.id}>`, `(cc <@!${UMER.id}> <@${REA.id}>)`]) {
      expect(splitCc(people, `<@${JF.id}> do the thing ${tail}`).cc).toEqual([UMER, REA]);
    }
  });

  it("keeps a person a doer when the message also gives them work", () => {
    const content = `<@${UMER.id}> import the sheet tomorrow. cc <@${UMER.id}> <@${REA.id}>`;
    expect(splitCc([UMER, REA], content)).toEqual({ doers: [UMER], cc: [REA] });
  });

  it("never reads cc inside a word, nor across a new line", () => {
    expect(splitCc([UMER], `<@${UMER.id}> check the account`).cc).toEqual([]);
    expect(splitCc([UMER], `send it to accounts <@${UMER.id}>`).cc).toEqual([]);
    expect(splitCc([JF, UMER], `cc <@${JF.id}>\n<@${UMER.id}> do it`)).toEqual({ doers: [UMER], cc: [JF] });
  });

  it("reads handles typed as words, for a DM", () => {
    expect(ccMentions("@minh redo the thumbnail, cc @Bao and @chi.").handles).toEqual(["bao", "chi"]);
    expect(withoutCc("@minh redo the thumbnail, cc @Bao and @chi.")).not.toContain("@Bao");
  });

  it("only cc'd: one card for nobody, naming them — never a message dropped", () => {
    const rows = cardsForEveryone({ title: "Heads up" }, [UMER], {
      messageId: MESSAGE,
      viaDm: false,
      now: NOW,
      ownerDiscordId: OWNER,
      content: `<@${BOT}> heads up on the release, fyi <@${UMER.id}>`,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ assignee_discord_id: null, cc: [UMER] });
  });

  it("every card of a message names who was cc'd", () => {
    const rows = cardsForEveryone({ title: "Share the CTAs" }, [JF, REA, UMER], {
      messageId: MESSAGE,
      viaDm: false,
      now: NOW,
      ownerDiscordId: OWNER,
      content: `<@${JF.id}> <@${REA.id}> share the CTAs. cc <@${UMER.id}>`,
    });
    expect(rows.map((row) => row.assignee_discord_id)).toEqual([JF.id, REA.id]);
    expect(rows.every((row) => JSON.stringify(row.cc) === JSON.stringify([UMER]))).toBe(true);
  });
});
