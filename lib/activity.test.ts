import { describe, expect, it } from "vitest";

import { type ActivityInput, activityOf, latestUpdate } from "./activity";
import type { TaskEvent, TaskProof, TaskReview } from "./types/database";

const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

let seq = 0;
const event = (at: string, changes: Record<string, unknown>, actor: string | null = "Luka", kind: TaskEvent["kind"] = "changed"): TaskEvent => ({
  id: `e${++seq}`,
  user_id: "u1",
  task_id: "t1",
  at,
  actor_discord_id: actor ? "1" : null,
  actor_name: actor,
  kind,
  changes,
});

const proof = (at: string, body: string): TaskProof =>
  ({ id: `p${++seq}`, task_id: "t1", created_at: at, kind: "text", body, source: "board", submitted_by_name: "Rea" }) as unknown as TaskProof;

const review = (at: string, decision: TaskReview["decision"], extra: Partial<TaskReview> = {}): TaskReview =>
  ({
    id: `r${++seq}`,
    task_id: "t1",
    decided_at: at,
    decision,
    reviewer_name: "Luka",
    note: null,
    new_deadline: null,
    excused_at: null,
    excused_reason: null,
    ...extra,
  }) as unknown as TaskReview;

function input(overrides: Partial<ActivityInput> = {}): ActivityInput {
  return {
    task: {
      id: "t1",
      created_at: "2026-10-06T09:00:00.000Z",
      owner_name: "Luka",
      assignee_name: "Rea",
      requested_by_name: null,
      direction: "given",
      counterparty: null,
    },
    source: { author_name: "Lucky35", channel_name: "cenri-john", via_dm: false, sent_at: "2026-10-06T08:59:00.000Z" },
    events: [],
    reviews: [],
    proofs: [],
    alerts: [],
    replies: [],
    ...overrides,
  };
}

describe("activityOf — what happened on a task (PO, 2026-10-07)", () => {
  it("starts with who made it and where, and lists newest first", () => {
    const entries = activityOf(
      input({
        events: [
          event("2026-10-06T09:00:00.000Z", { assignee: "Rea", deadline: "2026-10-07T09:00:00.000Z" }, "Lucky35", "created"),
          event("2026-10-06T10:00:00.000Z", { stage: [0, 2] }, "Rea"),
        ],
      }),
      when,
    );
    expect(entries.map((e) => `${e.who} ${e.text}`)).toEqual([
      "Rea moved it to In progress",
      "Lucky35 created it in #cenri-john — for Rea, due 2026-10-07 09:00",
    ]);
  });

  it("says a deadline moved, by whom, from and to", () => {
    const [entry] = activityOf(
      input({ events: [event("2026-10-06T11:00:00.000Z", { deadline: ["2026-10-06T17:55:00.000Z", "2026-10-06T23:55:00.000Z"] })] }),
      when,
    );
    expect(entry.text).toBe("extended the deadline from 2026-10-06 17:55 to 2026-10-06 23:55");
    expect(entry.who).toBe("Luka");
  });

  it("tells a report once — the proof, not the status change under it", () => {
    const entries = activityOf(
      input({
        proofs: [proof("2026-10-06T12:00:00.000Z", "sent it"), proof("2026-10-06T12:00:20.000Z", "and the link")],
        events: [event("2026-10-06T12:00:05.000Z", { status: ["open", "done"], stage: [2, 3], review_state: [null, "pending"] }, "Rea")],
      }),
      when,
    );
    const reports = entries.filter((e) => e.text.includes("reported"));
    expect(reports).toHaveLength(1);
    expect(reports[0].proofs).toHaveLength(2);
  });

  it("tells a verdict once, with what it cost — and says when it was taken back", () => {
    const entries = activityOf(
      input({
        reviews: [
          review("2026-10-06T13:00:00.000Z", "disapprove_reopen", { note: "footer missing", new_deadline: "2026-10-07T13:00:00.000Z" }),
          review("2026-10-06T14:00:00.000Z", "approve_on_time", { excused_at: "2026-10-06T14:01:00.000Z", excused_reason: "undone" }),
        ],
        events: [event("2026-10-06T13:00:01.000Z", { status: ["done", "open"], deadline: ["2026-10-06T17:00:00.000Z", "2026-10-07T13:00:00.000Z"] })],
      }),
      when,
    );
    expect(entries.filter((e) => e.key.startsWith("event:"))).toEqual([]);
    const [undone, reopened] = entries.filter((e) => e.review);
    expect(undone.text).toBe("approved — on time — taken back");
    expect(undone.tone).toBe("muted");
    expect(reopened.text).toBe("disapproved — reopened (−1) — new deadline 2026-10-07 13:00");
    expect(reopened.quote).toBe("footer missing");
  });

  it("folds a run of reminders into one line, and says when one did not arrive", () => {
    const entries = activityOf(
      input({
        alerts: [
          { id: "a1", kind: "assignee", ok: true, error: null, sent_at: "2026-10-06T10:00:00.000Z" },
          { id: "a2", kind: "assignee", ok: true, error: null, sent_at: "2026-10-06T11:00:00.000Z" },
          { id: "a3", kind: "assignee", ok: true, error: null, sent_at: "2026-10-06T12:00:00.000Z" },
          { id: "a4", kind: "assignee", ok: false, error: "Cannot send messages to this user", sent_at: "2026-10-06T13:00:00.000Z" },
          // The giver's own reminders are not news to the giver.
          { id: "a5", kind: "deadline", ok: true, error: null, sent_at: "2026-10-06T13:30:00.000Z" },
        ],
      }),
      when,
    );
    const bot = entries.filter((e) => e.bot);
    expect(bot.map((e) => e.text)).toEqual(["could not deliver a reminder to Rea", "reminded Rea — 3 times since 2026-10-06 10:00"]);
    expect(bot[0].quote).toBe("Cannot send messages to this user");
  });

  it("quotes what people replied in Discord, without the mention markup", () => {
    const [entry] = activityOf(
      input({ replies: [{ id: "m1", author_name: "Rea", content: "<@123> almost there, need 2 hours", sent_at: "2026-10-06T15:00:00.000Z", via_dm: true }] }),
      when,
    );
    expect(entry).toMatchObject({ who: "Rea", text: "wrote to the bot about it", quote: "almost there, need 2 hours" });
  });

  it("the latest update is the newest thing a person did, not the bot", () => {
    const entries = activityOf(
      input({
        events: [event("2026-10-06T10:00:00.000Z", { stage: [0, 1] }, "Rea")],
        alerts: [{ id: "a1", kind: "assignee", ok: true, error: null, sent_at: "2026-10-06T12:00:00.000Z" }],
      }),
      when,
    );
    expect(latestUpdate(entries)?.text).toBe("moved it to Started");
  });

  it("a change the tracker made itself has nobody's name on it", () => {
    const [entry] = activityOf(input({ events: [event("2026-10-06T10:00:00.000Z", { priority: ["medium", "high"] }, null)] }), when);
    expect(entry.who).toBeNull();
    expect(entry.text).toBe("set the priority to high");
  });

  it("a reminder sent by hand says who sent it and what it said — once (PO, task 5)", () => {
    const entries = activityOf(
      input({
        events: [
          event("2026-10-06T10:00:00.000Z", { to: "Rea", message: "  client is waiting, ETA?  ", ok: true, error: null }, "Luka", "reminded"),
          event("2026-10-06T11:00:00.000Z", { to: "Rea", message: null, ok: true, error: null }, "Lucky35", "reminded"),
        ],
        alerts: [
          { id: "a1", kind: "manual_reminder", ok: true, error: null, sent_at: "2026-10-06T10:00:01.000Z" },
          { id: "a2", kind: "manual_reminder", ok: true, error: null, sent_at: "2026-10-06T11:00:01.000Z" },
        ],
      }),
      when,
    );
    const reminded = entries.filter((e) => e.key.startsWith("reminded:"));
    expect(reminded.map((e) => [e.who, e.text, e.quote ?? null])).toEqual([
      ["Lucky35", "reminded Rea now — the usual reminder", null],
      ["Luka", "reminded Rea now", "client is waiting, ETA?"],
    ]);
    expect(entries.filter((e) => e.key.startsWith("alert:"))).toEqual([]);
    expect(latestUpdate(entries)?.who).toBe("Lucky35");
  });

  it("a reminder by hand that did not arrive says why", () => {
    const [entry] = activityOf(
      input({ events: [event("2026-10-06T10:00:00.000Z", { to: "Rea", message: "hi", ok: false, error: "Cannot send messages to this user" }, "Luka", "reminded")] }),
      when,
    );
    expect(entry).toMatchObject({ text: "tried to remind Rea — it did not arrive", quote: "Cannot send messages to this user", tone: "bad" });
  });

  it("an older reminder by hand, from before it was recorded, still shows from its alert", () => {
    const [entry] = activityOf(input({ alerts: [{ id: "a1", kind: "manual_reminder", ok: true, error: null, sent_at: "2026-10-06T10:00:00.000Z" }] }), when);
    expect(entry.text).toBe("sent Rea a reminder, by hand");
  });

  it("an assignee taking a report back is said so", () => {
    const [entry] = activityOf(
      input({ events: [event("2026-10-06T10:00:00.000Z", { status: ["done", "open"], stage: [3, 2], review_state: ["pending", null] }, "Rea")] }),
      when,
    );
    expect(entry.text).toBe("took back their report — it is open again");
  });
});
