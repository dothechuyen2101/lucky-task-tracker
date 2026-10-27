import { describe, expect, it } from "vitest";

import { DEFAULT_AUTO_CADENCE_MINUTES } from "./deadlines";
import {
  MIN_REQUEST_KEY_LENGTH,
  RECEIPT_DIGEST_MAX_LINES,
  LATE_ANSWER_MS,
  type OwedRow,
  type Receipt,
  SKIP_LABELS,
  duplicateReason,
  isSkip,
  lateAnswer,
  likeContains,
  olderThanFilter,
  placeOf,
  receiptDigest,
  receiptFor,
  requestKey,
  skipReply,
  taskFromMessage,
} from "./triage";
import type { SkippedMessage } from "./types/database";

const BOT = "999999999999999999";
const ALICE = { id: "222222222222222222", name: "alice" };
const BOB = { id: "333333333333333333", name: "bob" };
const SENT = "2026-09-07T09:00:00.000Z";
const NOW = new Date("2026-09-07T09:05:00.000Z");

function skipped(overrides: Partial<SkippedMessage> = {}): SkippedMessage {
  return {
    id: "msg-1",
    content: `<@${BOT}> <@${ALICE.id}> redo the thumbnail, deadline is 24 hours`,
    jump_url: "https://discord.com/channels/1/2/3",
    sent_at: SENT,
    channel_name: "design",
    author_name: "Erik",
    author_id: null,
    direction: "sent",
    mentions: [ALICE],
    classification_reason: "chatter: reads like banter",
    skip_category: "chatter",
    via_dm: false,
    ...overrides,
  };
}

const ctx = { userId: "user-1", timezone: "Africa/Johannesburg", now: NOW };

describe("isSkip", () => {
  it("files only tasks", () => {
    expect(isSkip("task")).toBe(false);
    for (const category of ["thanks", "chatter", "question", "command"] as const) {
      expect(isSkip(category)).toBe(true);
    }
  });
});

describe("skipReply — what the bot says in the channel", () => {
  it("answers a question and a command it could not apply, with fixed text that tags itself", () => {
    expect(skipReply("question", BOT)).toContain(`<@${BOT}>`);
    expect(skipReply("command", BOT)).toContain("reply to the message that created it");
  });

  it("says nothing to thanks or chatter — the 👀 is answer enough", () => {
    expect(skipReply("thanks", BOT)).toBeNull();
    expect(skipReply("chatter", BOT)).toBeNull();
  });
});

describe("taskFromMessage — who asked (2026-10-06)", () => {
  const ctx = { userId: "user-1", timezone: "UTC", now: NOW, ownerDiscordId: "111111111111111111" };

  it("a teammate's message, filed by hand, is asked by them", () => {
    const row = taskFromMessage(skipped({ author_id: "666666666666666666", author_name: "Cenri" }), ctx);
    expect(row).toMatchObject({ requested_by_discord_id: "666666666666666666", requested_by_name: "Cenri" });
  });

  it("the owner's own is asked by nobody else", () => {
    const row = taskFromMessage(skipped({ author_id: "111111111111111111" }), ctx);
    expect(row.requested_by_discord_id).toBeNull();
  });
});

describe("taskFromMessage — 'Make it a task' on something the tracker skipped", () => {
  it("files it the way the worker would have: its words, its one person, its stated deadline, live", () => {
    const row = taskFromMessage(skipped(), ctx);
    expect(row).toMatchObject({
      user_id: "user-1",
      message_id: "msg-1",
      title: "redo the thumbnail, deadline is 24 hours",
      direction: "given",
      assignee_discord_id: ALICE.id,
      assignee_name: "alice",
      deadline: "2026-09-08T09:00:00.000Z",
      deadline_source: "auto",
      alert_every_minutes: DEFAULT_AUTO_CADENCE_MINUTES,
      source_url: "https://discord.com/channels/1/2/3",
    });
    expect(typeof row.next_alert_at).toBe("string");
    expect(row.suggested_deadline).toBe("2026-09-08T09:00:00.000Z");
  });

  it("never picks between several people, and sets no clock when none was stated", () => {
    const row = taskFromMessage(
      skipped({ content: `<@${BOT}> <@${ALICE.id}> <@${BOB.id}> sort the drive`, mentions: [ALICE, BOB] }),
      ctx,
    );
    expect(row.assignee_discord_id).toBeNull();
    expect(row.deadline).toBeUndefined();
    expect(row.next_alert_at).toBeUndefined();
  });

  it("counts the assignee as told when the message @-mentioned them in a channel — not when it was a DM to the bot", () => {
    expect(taskFromMessage(skipped(), ctx).assignee_told_at).toBe(ctx.now.toISOString());
    expect(taskFromMessage(skipped({ via_dm: true }), ctx).assignee_told_at).toBeNull();
  });

  it("names where a message was read, a DM included", () => {
    expect(placeOf({ channel_name: "design" })).toBe("#design");
    expect(placeOf({ channel_name: null, via_dm: true })).toBe("a DM to your bot");
  });

  it("keeps received work received, with who asked", () => {
    const row = taskFromMessage(skipped({ direction: "received", author_name: "Bao" }), ctx);
    expect(row.direction).toBe("received");
    expect(row.counterparty).toBe("Bao");
    expect(row.assignee_discord_id).toBeNull();
  });

  it("falls back to a placeholder title when the message was only mentions", () => {
    expect(taskFromMessage(skipped({ content: `<@${BOT}>`, mentions: [] }), ctx).title).toBe("Untitled task");
  });
});

describe("requestKey — the same request tagged twice", () => {
  const ROLE = "777000000000000001";
  const BOT_IDS = [BOT, ROLE];

  it("matches the same words to the same people, whether the bot was tagged by name or by role", () => {
    const first = requestKey(`<@${BOT}> <@${ALICE.id}> Redo the thumbnail, deadline is 24 hours!`, BOT_IDS);
    const again = requestKey(`<@&${ROLE}>   <@!${ALICE.id}> redo the THUMBNAIL — deadline is 24 hours`, BOT_IDS);
    expect(first).not.toBeNull();
    expect(again).toBe(first);
  });

  it("tells the same words given to different people apart", () => {
    // The audit's case (2026-09-30): Bob's copy was read as Alice's repeat.
    const alice = requestKey(`<@${BOT}> <@${ALICE.id}> submit your timesheet`, BOT_IDS);
    const bob = requestKey(`<@${BOT}> <@${BOB.id}> submit your timesheet`, BOT_IDS);
    const nobody = requestKey(`<@${BOT}> submit your timesheet`, BOT_IDS);
    expect(alice).not.toBe(bob);
    expect(alice).not.toBe(nobody);
    // The same people in another order are the same people.
    expect(requestKey(`<@${BOT}> <@${ALICE.id}> <@${BOB.id}> sort the drive now`, BOT_IDS)).toBe(
      requestKey(`<@${BOB.id}> <@${ALICE.id}> <@${BOT}> sort the drive now`, BOT_IDS),
    );
  });

  it("tells different requests apart", () => {
    expect(requestKey(`<@${BOT}> redo the thumbnail`, BOT_IDS)).not.toBe(requestKey(`<@${BOT}> redo the banner art`, BOT_IDS));
  });

  it("refuses to call a short, generic ask a repeat", () => {
    expect(requestKey(`<@${BOT}> fix it`, BOT_IDS)).toBeNull();
    expect("fix it".length).toBeLessThan(MIN_REQUEST_KEY_LENGTH);
  });

  it("reads non-English text too", () => {
    expect(requestKey(`<@${BOT}> Làm lại ảnh bìa, hạn 24 giờ`, BOT_IDS)).toBe("làm lại ảnh bìa hạn 24 giờ");
  });
});

describe("receiptDigest — the DM that answers a tag the tagger may not have seen answered", () => {
  const at = { sentAt: "2026-09-29T10:00:00.000Z", jumpUrl: "https://discord.com/channels/1/2/3" };
  const filed: Receipt = { kind: "filed", text: "Redo the thumbnail", channelName: "design", note: null, owed: "late", ...at };
  const repeat: Receipt = { kind: "duplicate", text: "Redo the thumbnail", channelName: "design", note: null, owed: "late", ...at };
  const thanks: Receipt = { kind: "skipped", text: "thanks!", channelName: "dev", note: "thanks", owed: "unmarked", ...at };
  const command: Receipt = { kind: "command", text: "Marked done ↪ Redo the thumbnail", channelName: "design", note: null, owed: "late", ...at };

  it("answers every kind of tag, says when and where, and says not to tag again", () => {
    const text = receiptDigest([filed, repeat, thanks, command], { link: "https://t.example/", toOwner: false })!;
    expect(text).toContain("✅ Filed: **Redo the thumbnail** — #design · <t:1790676000:R> · <https://discord.com/channels/1/2/3>");
    expect(text).toContain("✅ Already on the board: **Redo the thumbnail**");
    expect(text).toContain('👀 Not filed (thanks): "thanks!" — #dev');
    expect(text).toContain("↪ Marked done");
    expect(text).toContain("needs tagging again");
    expect(text).toContain("<https://t.example/>");
  });

  it("says why it is writing: read late, or no reaction possible", () => {
    expect(receiptDigest([filed], { link: null, toOwner: false })).toContain("a while after you wrote it");
    expect(receiptDigest([thanks], { link: null, toOwner: false })).toContain("I couldn't put ✅ / 👀 on your tag");
    expect(receiptDigest([filed, thanks], { link: null, toOwner: false })).toContain("Some of your tags I read late");
  });

  it("asks only the owner to re-invite the bot, and tells the owner on a tagger's behalf", () => {
    expect(receiptDigest([thanks], { link: null, toOwner: true })).toContain("Invite me again from Settings");
    expect(receiptDigest([thanks], { link: null, toOwner: false })).not.toContain("Invite me again");
    expect(receiptDigest([filed], { link: null, toOwner: true, onBehalfOf: "Trello" })).toContain(
      "I couldn't DM Trello about a tag of theirs",
    );
  });

  it("itemises the first lines and counts the rest — no tag is left out of the answer", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...filed, text: `Task number ${i}` }));
    const text = receiptDigest(many, { link: null, toOwner: false })!;
    expect(text).toContain(`Task number ${RECEIPT_DIGEST_MAX_LINES - 1}`);
    expect(text).not.toContain(`Task number ${RECEIPT_DIGEST_MAX_LINES}**`);
    expect(text).toContain(`…and ${40 - RECEIPT_DIGEST_MAX_LINES} more`);
  });

  it("always fits in one Discord message, however long the titles", () => {
    const long = Array.from({ length: 15 }, () => ({ ...filed, text: "x".repeat(500), channelName: "c".repeat(90) }));
    expect(receiptDigest(long, { link: null, toOwner: false })!.length).toBeLessThanOrEqual(2000);
  });

  it("says nothing when there is nothing to answer", () => {
    expect(receiptDigest([], { link: null, toOwner: false })).toBeNull();
  });
});

describe("what is owed an answer by DM", () => {
  it("owes one to a tag answered more than LATE_ANSWER_MS after it was written — and not to a prompt one", () => {
    const now = new Date("2026-09-30T10:00:00.000Z");
    expect(lateAnswer(new Date(now.getTime() - LATE_ANSWER_MS - 1).toISOString(), now)).toBe("late");
    expect(lateAnswer(new Date(now.getTime() - 60_000).toISOString(), now)).toBeNull();
    // Backfill: months old.
    expect(lateAnswer("2026-04-01T09:00:00.000Z", now)).toBe("late");
  });

  it("rebuilds each receipt from the row, so an owed answer survives the run", () => {
    const row: OwedRow = {
      content: "<@1> <@2> redo the thumbnail",
      sent_at: "2026-09-29T10:00:00.000Z",
      channel_name: "design",
      jump_url: null,
      is_task: true,
      skip_category: null,
      classification_reason: null,
      command_result: null,
      answer_owed: "late",
    };
    expect(receiptFor(row, "Redo the thumbnail")).toMatchObject({ kind: "filed", text: "Redo the thumbnail", owed: "late" });
    expect(
      receiptFor({ ...row, is_task: false, skip_category: "duplicate", classification_reason: duplicateReason("Redo it") }, null),
    ).toMatchObject({ kind: "duplicate", text: "Redo it" });
    expect(receiptFor({ ...row, is_task: false, skip_category: "thanks" }, null)).toMatchObject({
      kind: "skipped",
      note: "thanks",
      text: "redo the thumbnail",
    });
    expect(receiptFor({ ...row, is_task: false, command_result: "Marked done" }, null)).toMatchObject({ kind: "command" });
  });
});

describe("finding a row on Not filed", () => {
  it("turns search words into an ilike pattern that takes wildcards literally", () => {
    expect(likeContains("  thumbnail ")).toBe("%thumbnail%");
    expect(likeContains("50% off_now")).toBe("%50\\% off\\_now%");
    // PostgREST reads `*` as `%`; `_` keeps it to one character.
    expect(likeContains("5* rating")).toBe("%5_ rating%");
    expect(likeContains("a")).toBeNull();
  });

  it("pages by row, not offset, with every value quoted for PostgREST", () => {
    expect(olderThanFilter({ sent_at: "2026-09-29T10:00:00.000+00:00", id: "abc" })).toBe(
      'sent_at.lt."2026-09-29T10:00:00.000+00:00",and(sent_at.eq."2026-09-29T10:00:00.000+00:00",id.lt."abc")',
    );
  });
});

describe("SKIP_LABELS", () => {
  it("names a repeat for what it is", () => {
    expect(SKIP_LABELS.duplicate).toBe("already on the board");
  });
});
