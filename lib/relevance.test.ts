import { describe, expect, it } from "vitest";

import type { DiscordMessage } from "@/lib/discord";

import {
  assigneesOf,
  chooseAssignee,
  fallbackDirection,
  isApp,
  mentionIdsFromContent,
  readableMessage,
  relevanceOf,
  repliesTo,
  requesterOf,
  roleIdsFromContent,
  stripMentions,
  tagsBot,
} from "./relevance";

const ERIK = "111111111111111111";
const BOT = "999999999999999999";
const ALICE = { id: "222222222222222222", username: "alice" };
const BOB = { id: "333333333333333333", username: "bob" };
const BOT_USER = { id: BOT, username: "tracker" };

/**
 * A complete DiscordMessage, because `pnpm typecheck` reads this file too and a
 * partial literal would compile under vitest and fail the gate.
 *
 * Unless the test supplies its own text, every mention is written into the
 * content as `<@id>` markup — which is what Discord sends for a name somebody
 * actually typed.
 */
function message(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  const markup = (overrides.mentions ?? []).map((m) => `<@${m.id}>`).join(" ");
  return {
    id: "444444444444444444",
    channel_id: "555555555555555555",
    content: markup ? `${markup} ship the thing` : "ship the thing",
    timestamp: "2026-09-07T12:00:00.000Z",
    author: { id: ERIK, username: "erik", global_name: "Erik" },
    type: 0,
    ...overrides,
  };
}

describe("relevanceOf — only a message that tags the bot is kept", () => {
  it("drops the user's own message when it does not tag the bot, however task-like", () => {
    const m = message({ mentions: [ALICE], content: `<@${ALICE.id}> please ship the invoice by Friday` });
    expect(relevanceOf(m, ERIK, BOT)).toEqual({ keep: false });
  });

  it("keeps the user's own message that tags the bot as sent", () => {
    expect(relevanceOf(message({ mentions: [BOT_USER, ALICE] }), ERIK, BOT)).toEqual({
      keep: true,
      direction: "sent",
    });
  });

  it("keeps a tagged message that names nobody else — it becomes a task missing its assignee", () => {
    expect(relevanceOf(message({ mentions: [BOT_USER] }), ERIK, BOT)).toEqual({
      keep: true,
      direction: "sent",
    });
  });

  it("accepts the legacy <@!id> form of the tag", () => {
    const m = message({ mentions: [BOT_USER], content: `<@!${BOT}> fix the login` });
    expect(relevanceOf(m, ERIK, BOT)).toEqual({ keep: true, direction: "sent" });
  });

  it("reads a tagged REPLY that names nobody else as a command about the task it answers", () => {
    const m = message({ mentions: [BOT_USER], message_reference: { message_id: "777" } });
    expect(relevanceOf(m, ERIK, BOT)).toEqual({ keep: true, direction: "command" });
  });

  it("reads a tagged reply that names someone as a new task, not a command", () => {
    const m = message({ mentions: [BOT_USER, ALICE], message_reference: { message_id: "777" } });
    expect(relevanceOf(m, ERIK, BOT)).toEqual({ keep: true, direction: "sent" });
  });

  it("does not count a reply-ping as a tag: the bot in `mentions` without markup is not tagged", () => {
    const m = message({
      mentions: [BOT_USER],
      content: "thanks, on it",
      message_reference: { message_id: "777" },
    });
    expect(relevanceOf(m, ERIK, BOT)).toEqual({ keep: false });
  });

  it("keeps someone else's message that tags the bot AND names the user as received", () => {
    const m = message({
      author: { id: ALICE.id, username: "alice" },
      mentions: [BOT_USER, { id: ERIK, username: "erik" }],
    });
    expect(relevanceOf(m, ERIK, BOT)).toEqual({ keep: true, direction: "received" });
  });

  it("stores nothing of someone else's tag that does not name the user — but marks it to be answered", () => {
    const m = message({ author: { id: ALICE.id, username: "alice" }, mentions: [BOT_USER, BOB] });
    expect(relevanceOf(m, ERIK, BOT)).toEqual({ keep: false, foreign: true });
  });

  it("never answers the bot's own messages, or any bot's — an answer must not answer itself", () => {
    const own = message({ author: { id: BOT, username: "tracker", bot: true }, mentions: [BOT_USER] });
    expect(relevanceOf(own, ERIK, BOT)).toEqual({ keep: false });
  });

  it("reads a tag an integration posted — a bot or a webhook — like anyone else's", () => {
    // Lucky35, 2026-09-30: tags relayed in from another tool were dropped unseen.
    const bot = message({
      author: { id: "888", username: "other-bot", bot: true },
      mentions: [BOT_USER, { id: ERIK, username: "erik" }],
    });
    expect(relevanceOf(bot, ERIK, BOT)).toEqual({ keep: true, direction: "received" });
    expect(isApp(bot)).toBe(true);

    const hook = message({ author: { id: "777", username: "Trello" }, webhook_id: "777", mentions: [BOT_USER, ALICE] });
    expect(relevanceOf(hook, ERIK, BOT)).toEqual({ keep: false, foreign: true });
    expect(isApp(hook)).toBe(true);
    expect(isApp(message())).toBe(false);
  });

  it("reads a forwarded message by what it forwards, tag and people included", () => {
    const forward = message({
      content: "",
      message_reference: { type: 1, message_id: "123" },
      message_snapshots: [{ message: { content: `<@${BOT}> <@${ALICE.id}> redo the banner`, mentions: [BOT_USER, ALICE] } }],
    });
    // The owner forwarded it: work they handed out — not a reply, so not a command.
    expect(relevanceOf(forward, ERIK, BOT)).toEqual({ keep: true, direction: "sent" });
    expect(readableMessage(forward).content).toBe(`<@${BOT}> <@${ALICE.id}> redo the banner`);
    expect(assigneesOf(readableMessage(forward), ERIK, BOT)).toEqual([{ id: ALICE.id, name: "alice" }]);
    expect(repliesTo(forward)).toBeNull();
  });

  it("tells a reply from a forward", () => {
    expect(repliesTo(message({ type: 19, message_reference: { message_id: "9" } }))).toBe("9");
    expect(repliesTo(message({ message_reference: { type: 0, message_id: "9" } }))).toBe("9");
    expect(repliesTo(message({ message_reference: { type: 1, message_id: "9" } }))).toBeNull();
    expect(repliesTo(message())).toBeNull();
  });

  it("keeps nothing when no bot is connected", () => {
    expect(relevanceOf(message({ mentions: [BOT_USER] }), ERIK, null)).toEqual({ keep: false });
  });

  it("drops empty text and message types that are not a message or a reply", () => {
    expect(relevanceOf(message({ mentions: [BOT_USER], content: "   " }), ERIK, BOT)).toEqual({ keep: false });
    expect(relevanceOf(message({ mentions: [BOT_USER], type: 7 }), ERIK, BOT)).toEqual({ keep: false });
  });
});

describe("relevanceOf — a teammate handing out work through the owner's bot (2026-10-06)", () => {
  // Cenri has signed in to the tracker; Bob never has.
  const CENRI = { id: "666666666666666666", username: "cenri" };
  const team = new Set([ERIK, CENRI.id]);
  const by = (who: { id: string; username: string }, mentions: Array<{ id: string; username: string }>, extra: Partial<DiscordMessage> = {}) =>
    message({ author: { id: who.id, username: who.username }, mentions, ...extra });

  it("files a teammate's tag naming someone else — or only themselves — as sent", () => {
    expect(relevanceOf(by(CENRI, [BOT_USER, ALICE]), ERIK, BOT, [], team)).toEqual({ keep: true, direction: "sent" });
    expect(relevanceOf(by(CENRI, [CENRI, BOT_USER]), ERIK, BOT, [], team)).toEqual({ keep: true, direction: "sent" });
  });

  it("a teammate's reply is never a command: only the owner changes the owner's tasks by reply", () => {
    const reply = by(CENRI, [BOT_USER], { type: 19, message_reference: { message_id: "777777777777777777" } });
    expect(relevanceOf(reply, ERIK, BOT, [], team)).toEqual({ keep: true, direction: "sent" });
  });

  it("asking the owner is still received, whoever asks", () => {
    expect(relevanceOf(by(CENRI, [{ id: ERIK, username: "erik" }, BOT_USER]), ERIK, BOT, [], team)).toEqual({
      keep: true,
      direction: "received",
    });
  });

  it("a stranger — never signed in — is answered and dropped, as before", () => {
    expect(relevanceOf(by(BOB, [BOT_USER, ALICE]), ERIK, BOT, [], team)).toEqual({ keep: false, foreign: true });
    expect(relevanceOf(by(CENRI, [BOT_USER, ALICE]), ERIK, BOT)).toEqual({ keep: false, foreign: true });
  });

  it("an integration is never a teammate", () => {
    const app = by(CENRI, [BOT_USER, ALICE], { webhook_id: "888888888888888888" });
    expect(relevanceOf(app, ERIK, BOT, [], team)).toEqual({ keep: false, foreign: true });
  });

  it("records who asked — unless it was the owner", () => {
    expect(requesterOf(CENRI.id, "Cenri", ERIK)).toEqual({ requested_by_discord_id: CENRI.id, requested_by_name: "Cenri" });
    expect(requesterOf(ERIK, "Erik", ERIK)).toEqual({ requested_by_discord_id: null, requested_by_name: null });
    expect(requesterOf(null, "someone", ERIK)).toEqual({ requested_by_discord_id: null, requested_by_name: null });
  });
});

describe("tagsBot", () => {
  it("finds the markup, and refuses without a bot id", () => {
    expect(tagsBot(`hey <@${BOT}> track this`, BOT)).toBe(true);
    expect(tagsBot("hey tracker, track this", BOT)).toBe(false);
    expect(tagsBot(`hey <@${BOT}>`, null)).toBe(false);
  });

  it("counts the bot's own role as a tag, and no other role", () => {
    const botRole = "777000000000000001";
    expect(tagsBot(`<@&${botRole}> redo the thumbnail`, BOT, [botRole])).toBe(true);
    expect(tagsBot(`<@&888000000000000002> redo the thumbnail`, BOT, [botRole])).toBe(false);
    // Before the worker has learned the role, it is not a tag.
    expect(tagsBot(`<@&${botRole}> redo the thumbnail`, BOT)).toBe(false);
  });
});

describe("relevanceOf — tagging the bot's role, the commonest silent miss", () => {
  const BOT_ROLE = "777000000000000001";

  it("keeps a message that tagged the bot's role instead of the bot", () => {
    const m = message({ mentions: [ALICE], content: `<@&${BOT_ROLE}> <@${ALICE.id}> redo the thumbnail` });
    expect(relevanceOf(m, ERIK, BOT, [BOT_ROLE])).toEqual({ keep: true, direction: "sent" });
  });

  it("keeps a role-tagged message from someone else that names the user", () => {
    const m = message({
      author: { id: ALICE.id, username: "alice" },
      mentions: [{ id: ERIK, username: "erik" }],
      content: `<@&${BOT_ROLE}> <@${ERIK}> send the invoice`,
    });
    expect(relevanceOf(m, ERIK, BOT, [BOT_ROLE])).toEqual({ keep: true, direction: "received" });
  });

  it("still ignores a mention of any other role", () => {
    const m = message({ content: "<@&888000000000000002> standup in five" });
    expect(relevanceOf(m, ERIK, BOT, [BOT_ROLE])).toEqual({ keep: false });
  });
});

describe("roleIdsFromContent and stripMentions", () => {
  it("reads role markup only, de-duplicated", () => {
    expect(roleIdsFromContent("<@&1> <@2> <#3> <@&1> <@&4>")).toEqual(["1", "4"]);
  });

  it("leaves the words a person reads", () => {
    expect(stripMentions(`<@${BOT}>  <@!${ALICE.id}> redo <#123> the <@&9> thumbnail `)).toBe("redo the thumbnail");
  });
});

describe("assigneesOf", () => {
  it("maps the mention payload to { id, name }, taking the username as the label", () => {
    expect(assigneesOf(message({ mentions: [ALICE] }), ERIK, BOT)).toEqual([
      { id: ALICE.id, name: "alice" },
    ]);
  });

  it("drops a self-mention — your own name is never your own assignee", () => {
    const m = message({ mentions: [{ id: ERIK, username: "erik" }, ALICE] });
    expect(assigneesOf(m, ERIK, BOT)).toEqual([{ id: ALICE.id, name: "alice" }]);
  });

  it("drops the tracker bot", () => {
    const m = message({ mentions: [{ id: BOT, username: "tracker" }, BOB] });
    expect(assigneesOf(m, ERIK, BOT)).toEqual([{ id: BOB.id, name: "bob" }]);
  });

  it("keeps everyone when no bot id is known", () => {
    const m = message({ mentions: [ALICE, BOB] });
    expect(assigneesOf(m, ERIK, null)).toHaveLength(2);
    expect(assigneesOf(m, ERIK)).toHaveLength(2);
  });

  it("de-duplicates a repeated mention by id", () => {
    const m = message({ mentions: [ALICE, ALICE, BOB] });
    expect(assigneesOf(m, ERIK, BOT)).toEqual([
      { id: ALICE.id, name: "alice" },
      { id: BOB.id, name: "bob" },
    ]);
  });

  it("preserves the order Discord returned", () => {
    const m = message({ mentions: [BOB, ALICE] });
    expect(assigneesOf(m, ERIK, BOT).map((a) => a.name)).toEqual(["bob", "alice"]);
  });

  it("skips a person who is in `mentions` only because a reply pinged them", () => {
    const m = message({
      mentions: [ALICE, BOB],
      content: `<@${BOB.id}> can you take this`,
      message_reference: { message_id: "777" },
    });
    expect(assigneesOf(m, ERIK, BOT)).toEqual([{ id: BOB.id, name: "bob" }]);
  });

  it("returns [] when mentions is absent", () => {
    expect(assigneesOf(message(), ERIK, BOT)).toEqual([]);
  });

  it("returns [] when mentions is empty", () => {
    expect(assigneesOf(message({ mentions: [] }), ERIK, BOT)).toEqual([]);
  });
});

describe("mentionIdsFromContent", () => {
  it("extracts a plain user mention", () => {
    expect(mentionIdsFromContent("please ship <@222222222222222222> today")).toEqual([
      "222222222222222222",
    ]);
  });

  it("extracts the legacy nickname form", () => {
    expect(mentionIdsFromContent("<@!222222222222222222> ping")).toEqual(["222222222222222222"]);
  });

  it("ignores role markup <@&456> — a role is not a person", () => {
    expect(mentionIdsFromContent("heads up <@&456789012345678901>")).toEqual([]);
  });

  it("ignores channel markup <#789> — a channel is not a person", () => {
    expect(mentionIdsFromContent("see <#789012345678901234> for context")).toEqual([]);
  });

  it("picks people out of a string that also carries a role and a channel", () => {
    const content = "<@&456789012345678901> <@222222222222222222> in <#789012345678901234>";
    expect(mentionIdsFromContent(content)).toEqual(["222222222222222222"]);
  });

  it("handles several mentions in one string, in order, de-duplicated", () => {
    const content = "<@333333333333333333> and <@222222222222222222> and <@!333333333333333333>";
    expect(mentionIdsFromContent(content)).toEqual([
      "333333333333333333",
      "222222222222222222",
    ]);
  });

  it("returns [] for plain text", () => {
    expect(mentionIdsFromContent("no mentions here at all")).toEqual([]);
  });
});

describe("chooseAssignee", () => {
  const candidates = [
    { id: ALICE.id, name: "alice" },
    { id: BOB.id, name: "bob" },
  ];

  it("takes an exact id match", () => {
    expect(chooseAssignee(candidates, ` ${BOB.id} `)).toEqual({ id: BOB.id, name: "bob" });
  });

  it("takes a name match, case-insensitively", () => {
    expect(chooseAssignee(candidates, "ALICE")).toEqual({ id: ALICE.id, name: "alice" });
  });

  it("returns the only candidate when the answer is empty", () => {
    expect(chooseAssignee([{ id: ALICE.id, name: "alice" }], "")).toEqual({
      id: ALICE.id,
      name: "alice",
    });
  });

  it("returns null on an empty answer with two candidates — nobody, not a guess", () => {
    expect(chooseAssignee(candidates, "")).toBeNull();
  });

  it("returns null when the answer matches nobody and there are two candidates", () => {
    expect(chooseAssignee(candidates, "carol")).toBeNull();
  });

  it("never invents a person out of an empty candidate list", () => {
    expect(chooseAssignee([], "alice")).toBeNull();
    expect(chooseAssignee([], "")).toBeNull();
  });
});

describe("relevanceOf — a report from someone with open work (Lucky35's PO, 2026-10-07)", () => {
  const reporting = { reporters: new Set([ALICE.id]), picks: new Set(["777777777777777777"]) };

  it("keeps a tag from someone with open work as a report — before any other reading", () => {
    const proof = message({ author: { id: ALICE.id, username: "alice" }, content: `<@${BOT}> done https://drive/x` });
    expect(relevanceOf(proof, ERIK, BOT, [], new Set(), reporting)).toEqual({ keep: true, direction: "report" });
    // Teammate or not: a report first.
    expect(relevanceOf(proof, ERIK, BOT, [], new Set([ALICE.id]), reporting)).toEqual({ keep: true, direction: "report" });
    // Without open work it is what it always was.
    expect(relevanceOf(proof, ERIK, BOT, [], new Set([ALICE.id]))).toEqual({ keep: true, direction: "sent" });
  });

  it("keeps their number in reply to the bot's 'which task?' list, tagged or not", () => {
    const pick = message({
      author: { id: ALICE.id, username: "alice" },
      content: "2",
      type: 19,
      message_reference: { message_id: "777777777777777777" },
    });
    expect(relevanceOf(pick, ERIK, BOT, [], new Set(), reporting)).toEqual({ keep: true, direction: "report" });
    // A reply to some other message is not a pick.
    expect(relevanceOf({ ...pick, message_reference: { message_id: "1" } }, ERIK, BOT, [], new Set(), reporting)).toEqual({ keep: false });
  });

  it("never reads the owner's own tag as a report", () => {
    const own = message({ content: `<@${BOT}> <@${ALICE.id}> redo the cut`, mentions: [ALICE] });
    expect(relevanceOf(own, ERIK, BOT, [], new Set(), { reporters: new Set([ERIK]) })).toEqual({ keep: true, direction: "sent" });
  });

  it("falls back, when it reports nothing, to what it would otherwise be", () => {
    expect(fallbackDirection(`<@${BOT}> <@${ERIK}> can you review it?`, ALICE.id, ERIK, new Set())).toBe("received");
    expect(fallbackDirection(`<@${BOT}> <@${BOB.id}> make the banner`, ALICE.id, ERIK, new Set([ALICE.id]))).toBe("sent");
    expect(fallbackDirection(`<@${BOT}> thanks`, ALICE.id, ERIK, new Set())).toBe("foreign");
  });
});
