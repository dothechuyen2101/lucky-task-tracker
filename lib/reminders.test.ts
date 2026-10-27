import { describe, expect, it } from "vitest";

import {
  APPROACH_MIN_GAP_MS,
  ASSIGNEE_FALLBACK_CADENCE_MINUTES,
  ASSIGNEE_OVERDUE_LIMIT,
  type AssigneeStream,
  COUNTDOWN_WINDOW_MS,
  MAX_OVERDUE_DAYS,
  assigneeStatusLine,
  computeNextAlertAt,
  countdownFull,
  countdownText,
  isLastAssigneeReminder,
  isOverdue,
  manualReminderText,
  relativeTime,
  reminderText,
  remindsGiver,
  shouldRemindAssignee,
} from "./reminders";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;

function next(overrides: Partial<Parameters<typeof computeNextAlertAt>[0]> = {}) {
  return computeNextAlertAt({
    now: NOW,
    status: "open",
    deadline: new Date(NOW.getTime() + DAY),
    alertEveryMinutes: 60,
    lastAlertAt: null,
    ...overrides,
  });
}

describe("computeNextAlertAt", () => {
  it("schedules the first reminder one interval out", () => {
    expect(next()?.toISOString()).toBe(new Date(NOW.getTime() + HOUR).toISOString());
  });

  it("refuses to schedule without a deadline — a reminder is about a date", () => {
    expect(next({ deadline: null })).toBeNull();
  });

  it("refuses to schedule with the frequency off", () => {
    expect(next({ alertEveryMinutes: null })).toBeNull();
  });

  it("stops the moment a task leaves 'open'", () => {
    expect(next({ status: "done" })).toBeNull();
    expect(next({ status: "dismissed" })).toBeNull();
  });

  it("keeps reminding after the deadline passes", () => {
    const overdue = next({ deadline: new Date(NOW.getTime() - 2 * DAY) });
    expect(overdue?.toISOString()).toBe(new Date(NOW.getTime() + HOUR).toISOString());
  });

  it("gives up once the task is MAX_OVERDUE_DAYS past its deadline", () => {
    const ancient = new Date(NOW.getTime() - (MAX_OVERDUE_DAYS + 1) * DAY);
    expect(next({ deadline: ancient })).toBeNull();
  });

  it("does not schedule past the give-up point", () => {
    // Deadline 30 minutes short of the cutoff, hourly cadence: the next slot
    // would land after the cutoff, so there is no next slot.
    const deadline = new Date(NOW.getTime() - MAX_OVERDUE_DAYS * DAY + 30 * 60_000);
    expect(next({ deadline, alertEveryMinutes: 60 })).toBeNull();
  });

  it("skips missed intervals instead of firing a burst", () => {
    // Worker was down for six hours on an hourly cadence. One reminder is owed,
    // not six.
    const result = next({ lastAlertAt: new Date(NOW.getTime() - 6 * HOUR) });
    expect(result?.toISOString()).toBe(new Date(NOW.getTime() + HOUR).toISOString());
  });

  it("keeps the original phase when catching up", () => {
    // Last alert at :20 past, hourly. The next slot is :20 past, not :00.
    const lastAlertAt = new Date("2026-09-02T06:20:00.000Z");
    expect(next({ lastAlertAt })?.toISOString()).toBe("2026-09-02T12:20:00.000Z");
  });

  it("never returns a time in the past", () => {
    for (const minutes of [15, 60, 1440, 10080]) {
      const result = next({
        alertEveryMinutes: minutes,
        lastAlertAt: new Date(NOW.getTime() - 400 * DAY),
        deadline: new Date(NOW.getTime() + DAY),
      });
      expect(result === null || result > NOW).toBe(true);
    }
  });
});

describe("computeNextAlertAt — reminders on the way in to a deadline", () => {
  it("reminds an hour before a 24-hour deadline, not at the moment it is late", () => {
    // "deadline is 24 hours", daily default: the cadence alone would first fire
    // exactly on the deadline.
    const deadline = new Date(NOW.getTime() + DAY);
    const result = next({ deadline, alertEveryMinutes: 1440 });
    expect(result?.toISOString()).toBe(new Date(deadline.getTime() - HOUR).toISOString());
  });

  it("reminds a day before a deadline further out than the cadence", () => {
    const deadline = new Date(NOW.getTime() + 3 * DAY);
    const result = next({ deadline, alertEveryMinutes: 10080 });
    expect(result?.toISOString()).toBe(new Date(deadline.getTime() - DAY).toISOString());
  });

  it("walks the approach: an hour before, then at the deadline, then the cadence", () => {
    const deadline = new Date(NOW.getTime() + DAY);
    const hourBefore = new Date(deadline.getTime() - HOUR);

    const atDeadline = computeNextAlertAt({
      now: hourBefore,
      status: "open",
      deadline,
      alertEveryMinutes: 1440,
      lastAlertAt: hourBefore,
    });
    expect(atDeadline?.toISOString()).toBe(deadline.toISOString());

    const afterDeadline = computeNextAlertAt({
      now: deadline,
      status: "open",
      deadline,
      alertEveryMinutes: 1440,
      lastAlertAt: deadline,
    });
    expect(afterDeadline?.toISOString()).toBe(new Date(deadline.getTime() + DAY).toISOString());
  });

  it("lets a faster cadence win — the approach points never delay a reminder", () => {
    expect(next({ alertEveryMinutes: 15 })?.toISOString()).toBe(
      new Date(NOW.getTime() + 15 * 60_000).toISOString(),
    );
  });

  it("skips an approach point that would land right after the last reminder", () => {
    const deadline = new Date(NOW.getTime() + HOUR + 10 * 60_000);
    // Reminded 10 minutes ago; the hour-before point is 10 minutes out — 20
    // minutes after that reminder, inside the minimum gap. Next is the deadline.
    const lastAlertAt = new Date(NOW.getTime() - 10 * 60_000);
    expect(20 * 60_000).toBeLessThan(APPROACH_MIN_GAP_MS);
    const result = next({ deadline, alertEveryMinutes: 1440, lastAlertAt });
    expect(result?.toISOString()).toBe(deadline.toISOString());
  });

  it("sends no approach reminders when reminders are off", () => {
    expect(next({ alertEveryMinutes: null, deadline: new Date(NOW.getTime() + 2 * HOUR) })).toBeNull();
  });
});

describe("isOverdue", () => {
  it("is false without a deadline", () => {
    expect(isOverdue(null, NOW)).toBe(false);
  });

  it("splits on the deadline", () => {
    expect(isOverdue(new Date(NOW.getTime() - 1), NOW)).toBe(true);
    expect(isOverdue(new Date(NOW.getTime() + 1), NOW)).toBe(false);
  });
});

describe("relativeTime", () => {
  it("reads naturally in both directions", () => {
    expect(relativeTime(new Date(NOW.getTime() + 3 * HOUR), NOW)).toBe("in 3 hours");
    expect(relativeTime(new Date(NOW.getTime() - 2 * DAY), NOW)).toBe("2 days ago");
    expect(relativeTime(new Date(NOW.getTime() + HOUR), NOW)).toBe("in 1 hour");
  });

  it("does not say '0 minutes'", () => {
    expect(relativeTime(new Date(NOW.getTime() + 10_000), NOW)).toBe("in under a minute");
    expect(relativeTime(new Date(NOW.getTime() - 10_000), NOW)).toBe("just now");
    // The same instant — "last reminded" read at the moment it was sent.
    expect(relativeTime(NOW, NOW)).toBe("just now");
  });
});

describe("reminderText", () => {
  it("leads with overdue when it is overdue", () => {
    const text = reminderText(
      { title: "Ship the preset layer", deadline: new Date(NOW.getTime() - DAY) },
      NOW,
    );
    expect(text.startsWith("⏰ **Overdue**")).toBe(true);
    expect(text).toContain("Ship the preset layer");
  });

  it("leads with the countdown when it is not", () => {
    const text = reminderText(
      { title: "Ship the preset layer", deadline: new Date(NOW.getTime() + 3 * HOUR) },
      NOW,
    );
    expect(text.startsWith("⏳ **Due in 3 hours**")).toBe(true);
  });

  it("carries the jump link when there is one", () => {
    const text = reminderText(
      {
        title: "T",
        deadline: NOW,
        source_url: "https://discord.com/channels/1/2/3",
      },
      NOW,
    );
    expect(text).toContain("https://discord.com/channels/1/2/3");
  });
});

describe("countdownText", () => {
  it("returns null when there is no deadline", () => {
    expect(countdownText(null, NOW)).toBeNull();
  });

  it("returns null 25 hours before the deadline", () => {
    expect(countdownText(new Date(NOW.getTime() + 25 * HOUR), NOW)).toBeNull();
  });

  // The window is symmetric. This is the case that stops "+694:12:07" on a task
  // sitting 29 days overdue while its reminders are still firing.
  it("returns null 25 hours after the deadline", () => {
    expect(countdownText(new Date(NOW.getTime() - 25 * HOUR), NOW)).toBeNull();
  });

  it("returns null exactly on the window boundary", () => {
    expect(countdownText(new Date(NOW.getTime() + COUNTDOWN_WINDOW_MS), NOW)).toBeNull();
  });

  it("counts down from just inside the window", () => {
    const deadline = new Date(NOW.getTime() + 23 * HOUR + 59 * 60_000 + 59_000);
    expect(countdownText(deadline, NOW)).toBe("23:59:59");
  });

  it("leaves hours unpadded and pads minutes and seconds to two", () => {
    const deadline = new Date(NOW.getTime() + 3 * HOUR + 7 * 60_000 + 42_000);
    expect(countdownText(deadline, NOW)).toBe("3:07:42");
  });

  it("counts up from a passed deadline with a leading plus", () => {
    const deadline = new Date(NOW.getTime() - (2 * 60_000 + 5_000));
    expect(countdownText(deadline, NOW)).toBe("+0:02:05");
  });

  it("floors sub-second time remaining, and it is still in the future", () => {
    expect(countdownText(new Date(NOW.getTime() + 400), NOW)).toBe("0:00:00");
  });
});

describe("countdownFull", () => {
  it("returns null without a deadline", () => {
    expect(countdownFull(null, NOW)).toBeNull();
  });

  it("counts down with days once there is more than a day left", () => {
    const deadline = new Date(NOW.getTime() + 2 * DAY + 4 * HOUR + 12 * 60_000 + 33_000);
    expect(countdownFull(deadline, NOW)).toEqual({ past: false, text: "2d 04:12:33" });
  });

  it("drops the day figure inside a day, and leaves the hour unpadded", () => {
    const deadline = new Date(NOW.getTime() + 3 * HOUR + 7 * 60_000 + 42_000);
    expect(countdownFull(deadline, NOW)).toEqual({ past: false, text: "3:07:42" });
  });

  it("counts up from a passed deadline and says so in `past`", () => {
    const deadline = new Date(NOW.getTime() - (DAY + 2 * HOUR));
    expect(countdownFull(deadline, NOW)).toEqual({ past: true, text: "1d 02:00:00" });
  });

  it("has no window — a week out still ticks", () => {
    expect(countdownFull(new Date(NOW.getTime() + 7 * DAY), NOW)?.text).toBe("7d 00:00:00");
  });
});

describe("reminderText — what the assignee and the giver read", () => {
  const deadline = new Date(NOW.getTime() + 3 * HOUR);

  it("carries the deadline as Discord timestamp markup, absolute and live-relative", () => {
    const unix = Math.floor(deadline.getTime() / 1000);
    const text = reminderText({ title: "T", deadline }, NOW);
    expect(text).toContain(`<t:${unix}:F>`);
    expect(text).toContain(`<t:${unix}:R>`);
  });

  it("names the other party and links the board when told to", () => {
    const text = reminderText({ title: "T", deadline }, NOW, {
      from: "Lucky35",
      link: "https://tracker.example/?task=abc",
    });
    expect(text).toContain("From Lucky35");
    expect(text).toContain("https://tracker.example/?task=abc");

    expect(reminderText({ title: "T", deadline }, NOW, { to: "minh" })).toContain("Given to minh");
  });

  it("still leads with the urgency line", () => {
    expect(reminderText({ title: "T", deadline }, NOW, { from: "Lucky35" }).startsWith("⏳ **Due in 3 hours**")).toBe(true);
  });
});

describe("the assignee's reminders", () => {
  const OWNER = "111111111111111111";
  const MINH = "222222222222222222";

  function stream(overrides: Partial<AssigneeStream> = {}): AssigneeStream {
    return {
      direction: "given",
      deadline: new Date(NOW.getTime() + DAY).toISOString(),
      assignee_discord_id: MINH,
      assignee_alerts_sent: 0,
      assignee_last_alert_at: null,
      assignee_last_error: null,
      assignee_overdue_alerts: 0,
      assignee_muted_at: null,
      assignee_muted_by: null,
      ...overrides,
    };
  }

  const overdue = new Date(NOW.getTime() - HOUR).toISOString();

  it("reminds the assignee on given work, and nobody on received work or work kept for yourself", () => {
    expect(shouldRemindAssignee(stream(), OWNER, NOW)).toBe(true);
    expect(shouldRemindAssignee(stream({ direction: "received" }), OWNER, NOW)).toBe(false);
    expect(shouldRemindAssignee(stream({ assignee_discord_id: OWNER }), OWNER, NOW)).toBe(false);
    expect(shouldRemindAssignee(stream({ assignee_discord_id: null }), OWNER, NOW)).toBe(false);
  });

  it("stops when either side turned the reminders off", () => {
    const at = NOW.toISOString();
    expect(shouldRemindAssignee(stream({ assignee_muted_at: at, assignee_muted_by: "assignee" }), OWNER, NOW)).toBe(false);
    expect(shouldRemindAssignee(stream({ assignee_muted_at: at, assignee_muted_by: "owner" }), OWNER, NOW)).toBe(false);
  });

  it(`sends ${ASSIGNEE_OVERDUE_LIMIT} reminders after the deadline and then no more`, () => {
    expect(shouldRemindAssignee(stream({ deadline: overdue, assignee_overdue_alerts: 0 }), OWNER, NOW)).toBe(true);
    expect(isLastAssigneeReminder(stream({ deadline: overdue, assignee_overdue_alerts: ASSIGNEE_OVERDUE_LIMIT - 1 }), NOW)).toBe(true);
    expect(isLastAssigneeReminder(stream({ deadline: overdue, assignee_overdue_alerts: 0 }), NOW)).toBe(false);
    expect(shouldRemindAssignee(stream({ deadline: overdue, assignee_overdue_alerts: ASSIGNEE_OVERDUE_LIMIT }), OWNER, NOW)).toBe(false);
  });

  it("does not count reminders before the deadline against the cap", () => {
    expect(isLastAssigneeReminder(stream({ assignee_overdue_alerts: 99 }), NOW)).toBe(false);
    expect(shouldRemindAssignee(stream({ assignee_overdue_alerts: 99 }), OWNER, NOW)).toBe(true);
  });

  it("tells the giver, in one line, what is happening on the assignee's side", () => {
    const line = (overrides: Partial<AssigneeStream>) => assigneeStatusLine(stream(overrides), "minh", OWNER, NOW);

    expect(line({})).toBe("minh has not been reminded yet.");
    expect(line({ assignee_alerts_sent: 4, assignee_last_alert_at: new Date(NOW.getTime() - 2 * HOUR).toISOString() })).toBe(
      "minh has been reminded 4× — last 2 hours ago.",
    );
    expect(line({ assignee_last_error: "403" })).toContain("tell them yourself");
    expect(line({ assignee_muted_at: new Date(NOW.getTime() - DAY).toISOString(), assignee_muted_by: "assignee" })).toBe(
      "minh turned their reminders off 1 day ago.",
    );
    expect(line({ assignee_muted_at: NOW.toISOString(), assignee_muted_by: "owner" })).toContain("you turned them off");
    expect(line({ deadline: overdue, assignee_overdue_alerts: ASSIGNEE_OVERDUE_LIMIT })).toContain("follow up yourself");
    expect(assigneeStatusLine(stream({ direction: "received" }), "minh", OWNER, NOW)).toBeNull();
  });

  it("says a task with no deadline reminds nobody yet, rather than 'not reminded yet'", () => {
    expect(assigneeStatusLine(stream({ deadline: null }), "minh", OWNER, NOW)).toBe("minh is reminded once this has a deadline.");
  });
});

describe("the giver's 'No reminder' is the giver's alone (Lucky35, 2026-09-30)", () => {
  const OWNER = "111111111111111111";
  const MINH = "222222222222222222";
  const deadline = new Date(NOW.getTime() + 3 * DAY);

  function stream(overrides: Partial<AssigneeStream> = {}): AssigneeStream {
    return {
      direction: "given",
      deadline: deadline.toISOString(),
      assignee_discord_id: MINH,
      assignee_alerts_sent: 0,
      assignee_last_alert_at: null,
      assignee_last_error: null,
      assignee_overdue_alerts: 0,
      assignee_muted_at: null,
      assignee_muted_by: null,
      ...overrides,
    };
  }

  const off = (overrides: Partial<AssigneeStream> = {}, now = NOW, lastAlertAt: Date | null = null) =>
    computeNextAlertAt({
      now,
      status: "open",
      deadline,
      alertEveryMinutes: null,
      lastAlertAt,
      assignee: { stream: { ...stream(), ...overrides }, ownerDiscordId: OWNER },
    });

  it("knows the giver's copy is off only when the cadence is", () => {
    expect(remindsGiver(null)).toBe(false);
    expect(remindsGiver(0)).toBe(false);
    expect(remindsGiver(60)).toBe(true);
  });

  it("still schedules the assignee's reminders, at their own daily cadence", () => {
    expect(off()?.toISOString()).toBe(new Date(NOW.getTime() + ASSIGNEE_FALLBACK_CADENCE_MINUTES * 60_000).toISOString());
  });

  it("still gives the assignee the fixed reminders on the way in", () => {
    const hourBefore = new Date(deadline.getTime() - HOUR);
    const dayAndABitBefore = new Date(deadline.getTime() - DAY - 10 * 60_000);
    expect(off({}, dayAndABitBefore)?.toISOString()).toBe(new Date(deadline.getTime() - DAY).toISOString());
    expect(off({}, new Date(hourBefore.getTime() - 60_000), new Date(deadline.getTime() - DAY))?.toISOString()).toBe(
      hourBefore.toISOString(),
    );
  });

  it("schedules nothing once the assignee's stream is off too — muted, capped, or nobody else", () => {
    expect(off({ assignee_muted_at: NOW.toISOString(), assignee_muted_by: "assignee" })).toBeNull();
    expect(off({ assignee_muted_at: NOW.toISOString(), assignee_muted_by: "owner" })).toBeNull();
    expect(off({ assignee_discord_id: OWNER })).toBeNull();
    expect(off({ direction: "received" })).toBeNull();

    const late = new Date(deadline.getTime() + DAY);
    expect(off({ assignee_overdue_alerts: ASSIGNEE_OVERDUE_LIMIT }, late)).toBeNull();
    expect(off({ assignee_overdue_alerts: ASSIGNEE_OVERDUE_LIMIT - 1 }, late)).not.toBeNull();
  });

  it("without an assignee stream, 'No reminder' still means none", () => {
    expect(computeNextAlertAt({ now: NOW, status: "open", deadline, alertEveryMinutes: null, lastAlertAt: null })).toBeNull();
  });

  it("with the giver's cadence on, it is the giver's cadence that schedules both", () => {
    const both = computeNextAlertAt({
      now: NOW,
      status: "open",
      deadline,
      alertEveryMinutes: 60,
      lastAlertAt: null,
      assignee: { stream: stream(), ownerDiscordId: OWNER },
    });
    expect(both?.toISOString()).toBe(new Date(NOW.getTime() + HOUR).toISOString());
  });
});

describe("reminderText — the two sides of one reminder", () => {
  it("tells the giver how to give more time; never the assignee", () => {
    const task = { title: "T", deadline: new Date(NOW.getTime() + 3 * HOUR) };
    expect(reminderText(task, NOW, { to: "Rea", link: "https://t.example/?task=1" })).toContain("`6 more hours`");
    expect(reminderText(task, NOW, { from: "Luka", assignee: { last: false } })).not.toContain("more hours");
    // Work the giver kept for themselves: nobody to give time to.
    expect(reminderText(task, NOW, {})).not.toContain("more hours");
  });

  const task = { title: "Redo the thumbnail", deadline: new Date(NOW.getTime() + 3 * HOUR) };

  it("tells the assignee how to answer it, and wraps the link so Discord does not unfurl it", () => {
    const text = reminderText(task, NOW, { from: "Lucky35", assignee: { last: false }, link: "https://t.example/?task=1" });
    expect(text).toContain("`start` when you begin, the proof when it is finished");
    expect(text).toContain("or `stop` to stop these reminders");
    expect(text).toContain("<https://t.example/?task=1>");
    expect(text).not.toContain("last reminder");
  });

  it("points the assignee at everything on them when it can", () => {
    const text = reminderText(task, NOW, {
      from: "Lucky35",
      assignee: { last: false },
      link: "https://t.example/?task=1",
      mine: "https://t.example/?mine",
    });
    expect(text).toContain("All your tasks, from everyone: <https://t.example/?mine>");
  });

  it("says so when it is the last one the assignee will get", () => {
    const text = reminderText(task, NOW, { from: "Lucky35", assignee: { last: true } });
    expect(text).toContain("the last reminder I will send you");
    expect(text).toContain("Lucky35 has been told");
  });

  it("carries the assignee's status on the giver's copy", () => {
    const text = reminderText(task, NOW, { to: "minh", assigneeStatus: "minh has been reminded 2× — last 1 hour ago." });
    expect(text).toContain("Given to minh");
    expect(text).toContain("minh has been reminded 2×");
  });
});

describe("manualReminderText — \"Remind now\" (PO, 2026-10-07, task 5)", () => {
  const deadline = new Date(NOW.getTime() + 3 * HOUR);
  const context = { from: "Luka", assignee: { last: false }, link: "https://tracker.example/?task=abc", mine: "https://tracker.example/?mine" };

  it("with nothing typed, sends the usual reminder under who is asking", () => {
    const text = manualReminderText("Lucky35", { title: "Fix the footer", deadline }, "   ", NOW, context);
    expect(text.startsWith("👋 **Lucky35** is checking on this one:\n")).toBe(true);
    expect(text).toContain(reminderText({ title: "Fix the footer", deadline }, NOW, context));
  });

  it("with a message, sends exactly those words — naming the task, and how to answer", () => {
    const words = "Client asked again.\nCan you send it by 5?";
    const text = manualReminderText("Lucky35", { title: "Fix the footer", deadline }, `  ${words}\n`, NOW, context);
    const lines = text.split("\n");
    expect(lines[0]).toBe("📣 **Lucky35** about **Fix the footer**:");
    expect(text).toContain(`\n${words}\n`);
    expect(text).toContain("Reply to this message with `done`");
    expect(text).toContain("<https://tracker.example/?mine>");
    // Their words, not the automatic reminder's.
    expect(text).not.toContain("Due in 3 hours");
  });
});
