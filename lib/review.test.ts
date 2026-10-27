import { describe, expect, it } from "vitest";

import { assigneeActionChanges } from "./assignee";
import { reminderText } from "./reminders";
import {
  PENDING_STAGE,
  REVIEW_NOTE_MAX,
  REVIEW_NUDGE_EVERY_MS,
  SENT_BACK_STAGE,
  awaitsReview,
  cleanNote,
  closedLabel,
  countsOnTime,
  decisionLabel,
  durationText,
  finishedByAssignee,
  finishedNotice,
  isReviewDecision,
  nextReviewNudge,
  restoredDeadline,
  reviewChanges,
  reviewChoices,
  reviewNudgeText,
  reviewPenalty,
  reviewedWork,
  settledByReview,
  suggestedApproval,
  timeLeftAtFinish,
  undoBlocker,
  undoChanges,
  undoableVerdict,
  undoneNotice,
  verdictNotice,
  verdictReply,
} from "./review";
import { MAX_STAGE } from "./stages";
import type { Task, TaskReview } from "./types/database";

const NOW = new Date("2026-10-04T10:00:00.000Z");
const OWNER = "111111111111111111";
const MINH = "222222222222222222";

type ReviewTask = Parameters<typeof reviewChanges>[0];

/** Minh reported it done an hour ago, with a day to spare; nobody has reviewed it. */
function reported(overrides: Partial<ReviewTask> = {}): ReviewTask {
  return {
    status: "done",
    completed_by: "assignee",
    review_state: "pending",
    review_rejections: 0,
    completed_at: "2026-10-04T09:00:00.000Z",
    stage: PENDING_STAGE,
    stage_at: {
      "1": "2026-10-02T10:00:00.000Z",
      "2": "2026-10-03T10:00:00.000Z",
      "3": "2026-10-04T09:00:00.000Z",
    },
    deadline: "2026-10-05T10:00:00.000Z",
    deadline_source: "auto",
    alert_every_minutes: 1440,
    last_alert_at: null,
    direction: "given",
    assignee_discord_id: MINH,
    assignee_name: "minh",
    title: "Cut the trailer",
    assignee_alerts_sent: 2,
    assignee_last_alert_at: "2026-10-03T10:00:00.000Z",
    assignee_last_error: null,
    assignee_overdue_alerts: 3,
    assignee_muted_at: null,
    assignee_muted_by: null,
    ...overrides,
  };
}

/** Given to Minh, open, never reported. */
function open(overrides: Partial<ReviewTask> = {}): ReviewTask {
  return reported({ status: "open", completed_by: null, review_state: null, completed_at: null, stage: 2, ...overrides });
}

function changesOf(result: ReturnType<typeof reviewChanges>) {
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("what waits for review", () => {
  it("is work reported done that nobody has reviewed", () => {
    expect(awaitsReview(reported())).toBe(true);
    expect(awaitsReview(reported({ review_state: "accepted" }))).toBe(false);
    expect(awaitsReview(open())).toBe(false);
    expect(finishedByAssignee(reported())).toBe(true);
    expect(finishedByAssignee(reported({ completed_by: "owner" }))).toBe(false);
  });

  it("is never Completed: reporting it done leaves it at Testing until someone approves it", () => {
    const result = assigneeActionChanges({ ...open(), stage: 1 } as Task, "done", NOW, OWNER);
    if (!result.ok) throw new Error(result.error);
    expect(result.changes).toMatchObject({ status: "done", review_state: "pending", stage: PENDING_STAGE, completed_by: "assignee" });
    expect(PENDING_STAGE).toBeLessThan(4);
  });

  it("reviews only work handed to someone other than the owner", () => {
    expect(reviewedWork(open(), OWNER)).toBe(true);
    expect(reviewedWork(open({ assignee_discord_id: OWNER }), OWNER)).toBe(false);
    expect(reviewedWork(open({ assignee_discord_id: null }), OWNER)).toBe(false);
    expect(reviewedWork(open({ direction: "received" }), OWNER)).toBe(false);
  });

  it("offers approve, disapprove (which reopens) and extend on reported work; approve and disapprove on open work; nothing once settled", () => {
    expect(reviewChoices(reported())).toEqual(["approve_on_time", "approve_late", "disapprove_reopen", "extend"]);
    expect(reviewChoices(open())).toEqual(["approve_on_time", "approve_late", "disapprove_reopen"]);
    expect(reviewChoices(reported({ review_state: "accepted" }))).toEqual([]);
    expect(reviewChoices(reported({ status: "failed" }))).toEqual([]);
    expect(settledByReview(reported({ review_state: "accepted" }))).toBe(true);
    expect(settledByReview(reported({ status: "failed" }))).toBe(true);
    expect(settledByReview(reported())).toBe(false);
  });
});

describe("the score of each verdict (task.md)", () => {
  it("costs −1 for late and for either disapproval, nothing for on time or extend", () => {
    expect(reviewPenalty("approve_on_time")).toBe(0);
    expect(reviewPenalty("approve_late")).toBe(1);
    expect(reviewPenalty("disapprove_close")).toBe(1);
    expect(reviewPenalty("disapprove_reopen")).toBe(1);
    expect(reviewPenalty("extend")).toBe(0);
    expect(countsOnTime("approve_on_time")).toBe(true);
    expect(countsOnTime("approve_late")).toBe(false);
    expect(isReviewDecision("extend")).toBe(true);
    expect(isReviewDecision("accept")).toBe(false);
    expect(decisionLabel("disapprove_reopen")).toBe("Disapproved — reopened");
  });

  it("suggests on time or late from when it was reported — the reviewer may choose either", () => {
    expect(suggestedApproval(reported(), NOW)).toBe("approve_on_time");
    expect(suggestedApproval(reported({ completed_at: "2026-10-05T10:00:01.000Z" }), NOW)).toBe("approve_late");
    // Exactly at the deadline is on time.
    expect(suggestedApproval(reported({ completed_at: "2026-10-05T10:00:00.000Z" }), NOW)).toBe("approve_on_time");
    expect(suggestedApproval(reported({ deadline: null }), NOW)).toBe("approve_on_time");
    // Not reported: judged by now.
    expect(suggestedApproval(open({ deadline: "2026-10-04T09:00:00.000Z" }), NOW)).toBe("approve_late");
    expect(changesOf(reviewChanges(reported(), { decision: "approve_late" }, NOW, OWNER)).record.decision).toBe("approve_late");
  });
});

describe("reviewChanges", () => {
  it("approve: Closed on the rail, finished when they reported it, nothing left to remind", () => {
    const { changes, record } = changesOf(reviewChanges(reported(), { decision: "approve_on_time", note: "great" }, NOW, OWNER));
    expect(changes).toMatchObject({
      status: "done",
      stage: MAX_STAGE,
      review_state: "accepted",
      reviewed_at: NOW.toISOString(),
      completed_at: "2026-10-04T09:00:00.000Z",
      completed_by: "assignee",
      next_alert_at: null,
      review_nudge_at: null,
    });
    expect(Object.keys(changes.stage_at ?? {})).toEqual(["1", "2", "3", "4", "5"]);
    expect(record).toMatchObject({
      decision: "approve_on_time",
      note: "great",
      deadline: "2026-10-05T10:00:00.000Z",
      finished_at: "2026-10-04T09:00:00.000Z",
      assignee_discord_id: MINH,
      task_title: "Cut the trailer",
    });
  });

  it("approve straight from open: the reviewer closed it, now — with no report behind it", () => {
    const { changes, record } = changesOf(reviewChanges(open(), { decision: "approve_on_time" }, NOW, OWNER));
    expect(changes).toMatchObject({ status: "done", completed_at: NOW.toISOString(), completed_by: "owner", review_state: "accepted" });
    expect(record.finished_at).toBeNull();
  });

  it("never closes as failed any more — disapproving reopens it (PO, 2026-10-07)", () => {
    const refused = reviewChanges(reported(), { decision: "disapprove_close", note: "wrong file" }, NOW, OWNER);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("reopens");
  });

  it("disapprove and reopen: In progress again on the reviewer's new deadline, reminders derived", () => {
    const due = "2026-10-06T10:00:00.000Z";
    const { changes, record } = changesOf(reviewChanges(reported(), { decision: "disapprove_reopen", note: "the footer is missing", deadline: due }, NOW, OWNER));
    expect(changes).toMatchObject({
      status: "open",
      stage: SENT_BACK_STAGE,
      completed_at: null,
      completed_by: null,
      review_state: "rejected",
      review_rejections: 1,
      deadline: due,
      deadline_source: "manual",
      assignee_overdue_alerts: 0,
    });
    expect(changes.next_alert_at).not.toBeNull();
    expect(Date.parse(changes.next_alert_at as string)).toBeGreaterThan(NOW.getTime());
    expect(record.new_deadline).toBe(due);
  });

  it("refuses a disapproval without a note — the −1 is kept with its reason (PO, 2026-10-09)", () => {
    const due = "2026-10-06T10:00:00.000Z";
    for (const note of [undefined, null, "", "   "]) {
      const refused = reviewChanges(reported(), { decision: "disapprove_reopen", note, deadline: due }, NOW, OWNER);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error).toContain("needs a note");
    }
    // Approving and extending still need none.
    expect(reviewChanges(reported(), { decision: "approve_late" }, NOW, OWNER).ok).toBe(true);
    expect(reviewChanges(reported(), { decision: "extend", deadline: due }, NOW, OWNER).ok).toBe(true);
  });

  it("extend: open again on the new deadline, with nothing counted and no rejection", () => {
    const due = "2026-10-07T10:00:00.000Z";
    const { changes } = changesOf(reviewChanges(reported(), { decision: "extend", deadline: due }, NOW, OWNER));
    expect(changes).toMatchObject({ status: "open", review_state: "extended", deadline: due, stage: SENT_BACK_STAGE });
    expect(changes.review_rejections).toBeUndefined();
  });

  it("refuses a reopen or extend without a deadline after now", () => {
    expect(reviewChanges(reported(), { decision: "disapprove_reopen", note: "the footer is missing" }, NOW, OWNER).ok).toBe(false);
    expect(reviewChanges(reported(), { decision: "extend", deadline: "2026-10-04T09:59:00.000Z" }, NOW, OWNER).ok).toBe(false);
    expect(reviewChanges(reported(), { decision: "extend", deadline: "not a date" }, NOW, OWNER).ok).toBe(false);
  });

  it("refuses a verdict on settled work, and extend on open work", () => {
    expect(reviewChanges(reported({ review_state: "accepted" }), { decision: "approve_on_time" }, NOW, OWNER).ok).toBe(false);
    expect(reviewChanges(reported({ status: "failed" }), { decision: "disapprove_close" }, NOW, OWNER).ok).toBe(false);
    expect(reviewChanges(open(), { decision: "extend", deadline: "2026-10-07T10:00:00.000Z" }, NOW, OWNER).ok).toBe(false);
  });

  it("reopens with the time they had left, given back from now, as the form's starting deadline", () => {
    expect(timeLeftAtFinish(reported())).toBe(25 * 3_600_000);
    expect(restoredDeadline(reported(), NOW)).toBe(new Date(NOW.getTime() + 25 * 3_600_000).toISOString());
    // None left: a day from now.
    expect(restoredDeadline(reported({ completed_at: "2026-10-06T10:00:00.000Z" }), NOW)).toBe(
      new Date(NOW.getTime() + 24 * 3_600_000).toISOString(),
    );
  });
});

describe("chasing the review", () => {
  it("reminds daily", () => {
    expect(Date.parse(nextReviewNudge(NOW)) - NOW.getTime()).toBe(REVIEW_NUDGE_EVERY_MS);
  });

  it("tells the reviewer what came as proof, with a link — and only the owner how to answer by reply", () => {
    const text = finishedNotice("Cut the trailer", "minh", "https://t/?task=1", { proof: ["🔗 <https://drive/x>"], canReply: true });
    expect(text).toContain("minh reported **Cut the trailer** done");
    expect(text).toContain("> 🔗 <https://drive/x>");
    expect(text).toContain("<https://t/?task=1>");
    expect(text).toContain("`approve`");
    expect(finishedNotice("Cut the trailer", "minh", "https://t/?task=1", { canReply: false })).not.toContain("`approve`");
  });

  it("says how long it has waited, and that the clock is stopped", () => {
    const text = reviewNudgeText("Cut the trailer", "minh", "2026-10-03T10:00:00.000Z", NOW, "https://t/?task=1");
    expect(text).toContain("1 day ago");
    expect(text).toContain("does not count against them");
  });

  it("puts a duration in words", () => {
    expect(durationText(45 * 60_000)).toBe("45 minutes");
    expect(durationText(90 * 60_000)).toBe("1 hour 30 minutes");
    expect(durationText(26 * 3_600_000)).toBe("1 day 2 hours");
  });
});

describe("what each side is told", () => {
  it("tells the assignee each verdict, what it cost, and the new deadline", () => {
    expect(verdictNotice("approve_late", "Cut the trailer", "Luka", null, null, null)).toContain("counts −1");
    const reopen = verdictNotice("disapprove_reopen", "Cut the trailer", "Luka", "the footer is missing", "2026-10-06T10:00:00.000Z", null);
    expect(reopen).toContain("−1");
    expect(reopen).toContain("Note: the footer is missing");
    expect(reopen).toContain("New deadline:");
    expect(reopen).toContain("reply to this message with the proof");
    expect(verdictNotice("extend", "Cut the trailer", "Luka", null, "2026-10-06T10:00:00.000Z", null)).toContain("nothing is counted");
  });

  it("tells the reviewer whether the assignee heard", () => {
    expect(verdictReply("approve_on_time", "Cut the trailer", "minh", true, null)).toContain("minh has been told");
    expect(verdictReply("disapprove_close", "Cut the trailer", "minh", false, null)).toContain("could not DM minh");
  });

  it("carries a disapproval into every reminder after it", () => {
    const task = {
      ...open(),
      review_state: "rejected",
      review_note: "the footer is missing",
      title: "Cut the trailer",
      detail: "",
      source_url: null,
      deadline: "2026-10-06T10:00:00.000Z",
    } as unknown as Task;
    expect(reminderText(task, NOW, {})).toContain("the footer is missing");
  });
});

describe("cleanNote", () => {
  it("is one trimmed paragraph, bounded", () => {
    expect(cleanNote("  a\n\n b  ")).toBe("a b");
    expect(cleanNote("x".repeat(REVIEW_NOTE_MAX + 10))).toHaveLength(REVIEW_NOTE_MAX);
    expect(cleanNote(null)).toBe("");
  });
});

describe("closedLabel", () => {
  it("says how it ended, from either side", () => {
    expect(closedLabel(reported(), false, "minh")).toBe("Finished by minh · to review");
    expect(closedLabel(reported(), true, "")).toBe("Finished · awaiting review");
    expect(closedLabel(reported({ review_state: "accepted" }), false, "minh")).toBe("Approved · done by minh");
    expect(closedLabel(reported({ status: "failed" }), false, "minh")).toBe("Failed");
    expect(closedLabel(reported({ status: "dismissed" }), false, "minh")).toBe("Dismissed");
    // Taken off a card they were only copied in on (2026-10-20).
    expect(closedLabel({ ...reported({ status: "dismissed" }), dismiss_reason: "only_cc" }, false, "minh")).toBe(
      "Not for them — only copied in",
    );
    expect(closedLabel(reported({ completed_by: "owner", review_state: null }), false, "minh")).toBe("Done");
  });
});

describe("taking a verdict back (PO, 2026-10-07: \"clicked Completed by mistake\")", () => {
  /** The verdict as `decide` records it: what it changed, before and after. */
  function verdict(task: ReviewTask, input: Parameters<typeof reviewChanges>[1]) {
    const { changes, record } = changesOf(reviewChanges(task, input, NOW, OWNER));
    const review = { id: "r1", task_id: "t1", decided_at: NOW.toISOString(), excused_reason: null, ...record } as unknown as TaskReview;
    return { after: { ...task, ...changes } as ReviewTask, review };
  }

  it("keeps what the task was, and what it became", () => {
    const { review } = verdict(reported(), { decision: "approve_on_time" });
    expect(review.before).toMatchObject({ status: "done", review_state: "pending", stage: PENDING_STAGE });
    expect(review.after).toMatchObject({ status: "done", review_state: "accepted", stage: MAX_STAGE });
    // Never the schedule: that is derived again on undo.
    expect(review.before).not.toHaveProperty("next_alert_at");
  });

  it("puts an approval back to waiting for review, exactly", () => {
    const { after, review } = verdict(reported(), { decision: "approve_on_time" });
    const result = undoChanges(after, review, NOW, OWNER);
    if (!result.ok) throw new Error(result.error);
    expect(result.changes).toMatchObject({
      status: "done",
      review_state: "pending",
      stage: PENDING_STAGE,
      completed_at: "2026-10-04T09:00:00.000Z",
      reviewed_at: null,
      next_alert_at: null,
    });
    // The reviewer is reminded a day from now, not at once.
    expect(result.changes.review_nudge_at).toBe(new Date(NOW.getTime() + 24 * 3_600_000).toISOString());
  });

  it("puts a reopen back too — the old deadline and stage, nothing counted", () => {
    const { after, review } = verdict(reported(), { decision: "disapprove_reopen", note: "the footer is missing", deadline: "2026-10-06T10:00:00.000Z" });
    const result = undoChanges(after, review, NOW, OWNER);
    if (!result.ok) throw new Error(result.error);
    expect(result.changes).toMatchObject({ status: "done", review_state: "pending", deadline: "2026-10-05T10:00:00.000Z", review_rejections: 0 });
  });

  it("refuses once something has happened since, once taken back, and on verdicts kept without a snapshot", () => {
    const { after, review } = verdict(reported(), { decision: "disapprove_reopen", note: "the footer is missing", deadline: "2026-10-06T10:00:00.000Z" });
    // Minh reported it again meanwhile.
    expect(undoBlocker({ ...after, status: "done", review_state: "pending", stage: PENDING_STAGE }, review)).toContain("happened");
    expect(undoBlocker(after, { ...review, excused_reason: "undone" })).toContain("already");
    expect(undoBlocker(after, { ...review, before: null, after: null })).toContain("before verdicts could be taken back");
    expect(undoBlocker(after, review)).toBeNull();
  });

  it("offers Undo only on the newest verdict still standing", () => {
    const first = verdict(reported(), { decision: "disapprove_reopen", note: "the footer is missing", deadline: "2026-10-06T10:00:00.000Z" });
    const task = { ...first.after, id: "t1" } as ReviewTask & Pick<Task, "id">;
    expect(undoableVerdict(task, [first.review])?.id).toBe("r1");
    const older = { ...first.review, id: "r0", decided_at: "2026-10-01T00:00:00.000Z" };
    expect(undoableVerdict(task, [older, first.review])?.id).toBe("r1");
    expect(undoableVerdict({ ...task, status: "done" } as never, [first.review])).toBeNull();
  });

  it("tells the assignee it was taken back, and where it stands", () => {
    expect(undoneNotice("approve_on_time", "T", "Luka", { status: "done", review_state: "pending" }, null)).toContain(
      "waiting for review again",
    );
    expect(undoneNotice("disapprove_reopen", "T", "Luka", { status: "open" }, null)).toContain("open again");
  });
});

describe("the assignee says how far along it is (PO, 2026-10-07)", () => {
  it("sets Not started, Started or In progress — and back — never past In progress", () => {
    const task = open({ stage: 2 });
    const back = assigneeActionChanges(task, "stage", NOW, OWNER, { stage: 1 });
    expect(back.ok && back.changes.stage).toBe(1);
    expect(back.ok && back.changes.stage_at).toEqual({ "1": "2026-10-02T10:00:00.000Z" });
    expect(assigneeActionChanges(task, "stage", NOW, OWNER, { stage: 3 }).ok).toBe(false);
    expect(assigneeActionChanges(task, "stage", NOW, OWNER, { stage: 2 })).toEqual({ ok: true, changes: {} });
    expect(assigneeActionChanges(reported(), "stage", NOW, OWNER, { stage: 1 }).ok).toBe(false);
  });

  it("takes back a report nobody has reviewed: open again, In progress", () => {
    const result = assigneeActionChanges(reported(), "withdraw", NOW, OWNER);
    if (!result.ok) throw new Error(result.error);
    expect(result.changes).toMatchObject({ status: "open", stage: 2, review_state: null, completed_at: null, completed_by: null });
    expect(typeof result.changes.next_alert_at).toBe("string");
    // Once reviewed, it is the reviewer's to take back.
    expect(assigneeActionChanges(reported({ review_state: "accepted" }), "withdraw", NOW, OWNER).ok).toBe(false);
  });
});
