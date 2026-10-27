/**
 * When the next reminder fires.
 *
 * `next_alert_at` is the only thing the scheduler looks at, so all of the
 * policy lives here rather than being spread across the worker and the UI.
 * Two rules shape it:
 *
 *   1. A reminder is about a deadline. No deadline, no reminders — the frequency
 *      selector in the UI is disabled until a date is set, and this function
 *      returns null for the same case, so a task can never nag about nothing.
 *
 *   2. Reminders keep going after the deadline passes, because a missed
 *      deadline is exactly when you want to be told. They stop at
 *      MAX_OVERDUE_DAYS so a task abandoned in October is not still pinging in
 *      December; close it or push the date to restart the clock.
 *
 *   3. On the way IN to a deadline there are fixed reminders as well as the
 *      cadence — a day before, an hour before, and when it falls due. A task
 *      given "deadline is 24 hours" with the daily default would otherwise get
 *      its first reminder at the very moment it became late.
 *
 *   4. The cadence on the row is the GIVER's. "No reminder" silences the
 *      giver's copy only; the person the task was given to keeps theirs — the
 *      approach reminders and a few after the deadline — until they, or the
 *      giver, press "Stop reminding" (Lucky35, 2026-09-30). One
 *      `next_alert_at` still drives both: it is the next moment EITHER stream
 *      is due, and the worker decides at send time who is told.
 */

export const ALERT_FREQUENCIES = [
  { minutes: null, label: "No reminders", short: "Off" },
  { minutes: 15, label: "Every 15 minutes", short: "15m" },
  { minutes: 30, label: "Every 30 minutes", short: "30m" },
  { minutes: 60, label: "Hourly", short: "1h" },
  { minutes: 180, label: "Every 3 hours", short: "3h" },
  { minutes: 360, label: "Every 6 hours", short: "6h" },
  { minutes: 720, label: "Every 12 hours", short: "12h" },
  { minutes: 1440, label: "Daily", short: "1d" },
  { minutes: 2880, label: "Every 2 days", short: "2d" },
  { minutes: 10080, label: "Weekly", short: "1w" },
] as const;

/** How long past a deadline an open task goes on reminding. */
export const MAX_OVERDUE_DAYS = 30;

/**
 * The assignee's cadence when the giver has switched their own reminders off.
 * Daily, like every other default cadence in the app; after the deadline the
 * overdue cap (`ASSIGNEE_OVERDUE_LIMIT`) ends it within days.
 */
export const ASSIGNEE_FALLBACK_CADENCE_MINUTES = 1440;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** How far before the deadline the fixed approach reminders land. 0 is "now due". */
export const APPROACH_LEADS_MS = [DAY, HOUR, 0] as const;

/**
 * An approach reminder this close after the last one sent is skipped, so a
 * cadence reminder and an approach reminder never arrive back to back.
 */
export const APPROACH_MIN_GAP_MS = 30 * MINUTE;

export function frequencyLabel(minutes: number | null): string {
  return ALERT_FREQUENCIES.find((f) => f.minutes === minutes)?.short ?? `${minutes}m`;
}

export type AlertInput = {
  now: Date;
  status: string;
  deadline: string | Date | null;
  alertEveryMinutes: number | null;
  /** null on a task that has never been reminded — the first one is one interval out. */
  lastAlertAt?: string | Date | null;
  /**
   * The task's assignee stream, when it was given to somebody, and the giver's
   * own Discord id (a task given to yourself has no second stream). With the
   * giver's cadence off, a live assignee stream still schedules the task
   * (rule 4 above). Leave it out and only the giver's cadence counts.
   */
  assignee?: { stream: AssigneeStream; ownerDiscordId: string | null } | null;
};

/** The columns of a task its whole schedule — both streams — is derived from. */
export type Schedulable = AssigneeStream & {
  status: string;
  alert_every_minutes: number | null;
  last_alert_at: string | null;
};

/**
 * `next_alert_at` for a row: the giver's cadence and the assignee's stream
 * together. The one call every writer makes — the board, the worker, the
 * assignee's route — so they cannot disagree about when a task is next due.
 * `lastAlertAt` stands in for the row's own when a send was just made.
 */
export function nextAlertFor(
  task: Schedulable,
  now: Date,
  ownerDiscordId: string | null,
  lastAlertAt: string | Date | null = task.last_alert_at,
): Date | null {
  return computeNextAlertAt({
    now,
    status: task.status,
    deadline: task.deadline,
    alertEveryMinutes: task.alert_every_minutes,
    lastAlertAt,
    assignee: { stream: task, ownerDiscordId },
  });
}

/** True when the giver's own copy of the reminders is on: "No reminder" is null. */
export function remindsGiver(alertEveryMinutes: number | null | undefined): boolean {
  return typeof alertEveryMinutes === "number" && alertEveryMinutes > 0;
}

function asDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The next moment this task should be reminded about, or null if it never
 * should be. Pure — the worker and the UI both call it, and the UI needs to
 * show "next reminder in 3h" without a round trip.
 */
export function computeNextAlertAt(input: AlertInput): Date | null {
  const { now, status, alertEveryMinutes } = input;

  if (status !== "open") return null;

  // The giver's cadence, or — with theirs off — the assignee's own, while the
  // assignee is still being reminded at all.
  const assigneeOn = input.assignee ? shouldRemindAssignee(input.assignee.stream, input.assignee.ownerDiscordId, now) : false;
  const every = remindsGiver(alertEveryMinutes)
    ? (alertEveryMinutes as number)
    : assigneeOn
      ? ASSIGNEE_FALLBACK_CADENCE_MINUTES
      : null;
  if (!every) return null;

  const deadline = asDate(input.deadline);
  if (!deadline) return null;

  // Stop nagging about something long dead.
  const expiry = new Date(deadline.getTime() + MAX_OVERDUE_DAYS * DAY);
  if (now >= expiry) return null;

  const lastAlertAt = asDate(input.lastAlertAt);
  const cadence = nextCadenceSlot(now, every * MINUTE, lastAlertAt, expiry);
  const approach = nextApproachSlot(deadline, now, lastAlertAt);

  if (!cadence) return approach;
  if (!approach) return cadence;
  return approach < cadence ? approach : cadence;
}

function nextCadenceSlot(now: Date, interval: number, lastAlertAt: Date | null, expiry: Date): Date | null {
  const candidate = new Date((lastAlertAt ?? now).getTime() + interval);

  // A task reminded a long time ago (the worker was down, the deadline moved)
  // should not fire a burst catching up on every interval it missed. Skip
  // forward to the next slot on or after now, keeping the original phase.
  if (candidate > now) {
    return candidate > expiry ? null : candidate;
  }

  // floor + 1, not ceil: when the gap is an exact multiple of the interval,
  // ceil lands the next alert exactly on `now`, and the worker — which selects
  // `next_alert_at <= now` — would fire the reminder it has just sent a second
  // time in the same tick. The next slot must be strictly in the future.
  const missed = Math.floor((now.getTime() - candidate.getTime()) / interval) + 1;
  const next = new Date(candidate.getTime() + missed * interval);
  return next > expiry ? null : next;
}

/**
 * The earliest fixed approach reminder still ahead. Strictly after `now`, for
 * the same reason as the floor + 1 above, and never within
 * APPROACH_MIN_GAP_MS of the reminder that was last sent.
 */
function nextApproachSlot(deadline: Date, now: Date, lastAlertAt: Date | null): Date | null {
  for (const lead of APPROACH_LEADS_MS) {
    const at = new Date(deadline.getTime() - lead);
    if (at <= now) continue;
    if (lastAlertAt && at.getTime() - lastAlertAt.getTime() < APPROACH_MIN_GAP_MS) continue;
    return at;
  }
  return null;
}

/** True when the deadline is in the past. */
export function isOverdue(deadline: string | Date | null, now: Date): boolean {
  const date = asDate(deadline);
  return date !== null && date < now;
}

/**
 * "in 3 hours" / "2 days ago". Used in the reminder text and on the row, so it
 * has to read naturally in a sentence either way round.
 */
export function relativeTime(target: string | Date | null, now: Date): string {
  const date = asDate(target);
  if (!date) return "no deadline";

  const deltaMs = date.getTime() - now.getTime();
  const abs = Math.abs(deltaMs);
  const past = deltaMs < 0;

  const units: Array<[number, string]> = [
    [DAY * 7, "week"],
    [DAY, "day"],
    [3_600_000, "hour"],
    [MINUTE, "minute"],
  ];

  for (const [size, name] of units) {
    if (abs >= size) {
      const n = Math.floor(abs / size);
      const plural = n === 1 ? name : `${name}s`;
      return past ? `${n} ${plural} ago` : `in ${n} ${plural}`;
    }
  }

  // The very instant is "just now", not the future: the giver's reminder says
  // when the assignee was last reminded, and that was this same instant — the
  // simulation of 2026-09-30 printed "last in under a minute".
  return past || deltaMs === 0 ? "just now" : "in under a minute";
}

/** Inside this window (either direction) a deadline gets a ticking figure. */
export const COUNTDOWN_WINDOW_MS = 24 * 3_600_000;

/**
 * "3:07:42" counting down to a deadline, "+0:12:05" counting up from one that
 * has passed, and null outside a day in either direction.
 *
 * A SECOND formatter beside `relativeTime`, never a change to it: `relativeTime`
 * is what Luka reads in Discord via `reminderText`, its minute ladder is pinned
 * by tests, and unifying the two would silently rewrite what lands in the
 * channel. This one is display-only and never reaches the worker.
 *
 * The window test is on the ABSOLUTE delta because reminders keep firing for
 * MAX_OVERDUE_DAYS, so a task can legitimately sit 29 days overdue and an
 * unbounded count-up would render "+694:12:07". Returning null keeps that one
 * decision here rather than duplicating it in the component.
 */
export function countdownText(deadline: string | Date | null, now: Date): string | null {
  const date = asDate(deadline);
  if (!date) return null;

  const deltaMs = date.getTime() - now.getTime();
  const abs = Math.abs(deltaMs);
  if (abs >= COUNTDOWN_WINDOW_MS) return null;

  // Floor, not round: the figure is monotone and never shows a second it has
  // already passed. The widest string this can produce is "+23:59:59".
  const total = Math.floor(abs / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");

  // A leading minus would read as "negative time remaining"; the plus reads as
  // "elapsed since due", which is what counting up means.
  return `${deltaMs < 0 ? "+" : ""}${hours}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * The countdown on a task card: time left to a deadline, or time since one that
 * has passed, to the second and with no window — "2d 04:12:33", "3:07:42".
 *
 * A THIRD formatter, beside `relativeTime` (what Discord reads) and
 * `countdownText` (the old row's 24-hour figure), and never a change to either,
 * for the same reason `countdownText` gives. `past` carries the direction so the
 * caller words it — "left" or "overdue" — rather than a sign doing it.
 */
export function countdownFull(
  deadline: string | Date | null,
  now: Date,
): { past: boolean; text: string } | null {
  const date = asDate(deadline);
  if (!date) return null;

  const deltaMs = date.getTime() - now.getTime();
  const total = Math.floor(Math.abs(deltaMs) / 1000);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");

  const clock = `${days > 0 ? pad(hours) : hours}:${pad(minutes)}:${pad(seconds)}`;
  return { past: deltaMs < 0, text: days > 0 ? `${days}d ${clock}` : clock };
}

// ---------------------------------------------------------------------------
// The assignee's reminders
//
// Lucky35, 2026-09-29: the person a task was handed to kept getting DMs long
// after the deadline, from somebody else's bot, with no way to answer them —
// and the person who handed it over could not tell that any of it was
// happening. So the assignee's stream has its own rules, and the giver is told
// its state every time they are reminded themselves.
// ---------------------------------------------------------------------------

/**
 * Once the deadline has passed, the assignee is DMed this many more times and
 * then left to the giver. Their own reminders are never capped this way: it is
 * the giver's clock to run.
 */
export const ASSIGNEE_OVERDUE_LIMIT = 3;

/** The columns the assignee's reminder stream is decided from. */
export type AssigneeStream = {
  direction: string;
  deadline: string | Date | null;
  assignee_discord_id: string | null;
  assignee_alerts_sent: number;
  assignee_last_alert_at: string | null;
  assignee_last_error: string | null;
  assignee_overdue_alerts: number;
  assignee_muted_at: string | null;
  assignee_muted_by: "owner" | "assignee" | null;
};

/**
 * The stream a task starts with a NEW assignee: nothing sent to them, nothing
 * failed, nothing muted, no overdue reminders counted. Written whenever the
 * assignee changes — otherwise the person a task moves to inherits the last
 * one's "stop" or spent cap and is never reminded at all (2026-09-30 audit).
 */
export const FRESH_ASSIGNEE_STREAM = {
  assignee_alerts_sent: 0,
  assignee_last_alert_at: null,
  assignee_last_error: null,
  assignee_overdue_alerts: 0,
  assignee_muted_at: null,
  assignee_muted_by: null,
  // The new person has not been told the task exists: the worker DMs them
  // once (`tellAssignees`), so nobody learns of work only from a reminder.
  assignee_told_at: null,
  // Nobody is left to pick from, and nothing about the last person's
  // reminders is owed to the giver.
  assignee_candidates: null,
  assignee_mute_told: null,
  assignee_mute_told_at: null,
  assignee_mute_notice_due: false,
} as const;

/**
 * Whether this round of reminders also goes to the person the task was given
 * to. Not when there is nobody, when that is the owner themselves, when either
 * side switched it off, or once the overdue cap is spent.
 */
export function shouldRemindAssignee(task: AssigneeStream, ownerDiscordId: string | null, now: Date): boolean {
  const assignee = (task.assignee_discord_id ?? "").trim();
  if (task.direction !== "given" || assignee === "" || assignee === ownerDiscordId) return false;
  if (task.assignee_muted_at) return false;
  return !assigneeCapped(task, now);
}

/** True once the assignee has had every reminder the overdue cap allows. */
export function assigneeCapped(task: AssigneeStream, now: Date): boolean {
  return isOverdue(task.deadline, now) && task.assignee_overdue_alerts >= ASSIGNEE_OVERDUE_LIMIT;
}

/** True when the reminder about to go out is the last the overdue cap allows. */
export function isLastAssigneeReminder(task: AssigneeStream, now: Date): boolean {
  return isOverdue(task.deadline, now) && task.assignee_overdue_alerts + 1 >= ASSIGNEE_OVERDUE_LIMIT;
}

/**
 * One line, for the person who gave the task, on whether the person they gave
 * it to is being reminded — read in their own reminder DM and on the board.
 * Null when the task was given to nobody else.
 */
export function assigneeStatusLine(task: AssigneeStream, name: string, ownerDiscordId: string | null, now: Date): string | null {
  const assignee = (task.assignee_discord_id ?? "").trim();
  if (task.direction !== "given" || assignee === "" || assignee === ownerDiscordId) return null;

  if (task.assignee_muted_at) {
    return task.assignee_muted_by === "assignee"
      ? `${name} turned their reminders off ${relativeTime(task.assignee_muted_at, now)}.`
      : `Reminders to ${name} are off — you turned them off.`;
  }
  if (!asDate(task.deadline)) {
    return `${name} is reminded once this has a deadline.`;
  }
  if (assigneeCapped(task, now)) {
    return `${name} had ${task.assignee_overdue_alerts} reminders after it went overdue and gets no more — follow up yourself.`;
  }
  if (task.assignee_last_error) {
    return `Discord would not deliver ${name}'s last reminder — tell them yourself.`;
  }
  if (task.assignee_alerts_sent > 0 && task.assignee_last_alert_at) {
    return `${name} has been reminded ${task.assignee_alerts_sent}× — last ${relativeTime(task.assignee_last_alert_at, now)}.`;
  }
  return `${name} has not been reminded yet.`;
}

/**
 * A reminder sent by hand — "Remind now" (Lucky35's PO, 2026-10-07, task 5) —
 * at most this often per task: enough that a double click or two reviewers at
 * once never send two, short enough never to stand in anyone's way.
 */
export const MANUAL_REMIND_EVERY_MS = 2 * 60_000;

/** The longest message a reviewer may type into "Remind now" — Discord takes 2000 characters, with room for the task line. */
export const MANUAL_REMIND_MAX = 1500;

/**
 * The DM "Remind now" sends. With the reviewer's own words, exactly those,
 * under one line naming the task — so the assignee knows which one — and how
 * to answer; with none, the usual reminder (`reminderText`) under who is
 * asking.
 */
export function manualReminderText(
  who: string,
  task: Parameters<typeof reminderText>[0],
  message: string | null,
  now: Date,
  context: ReminderContext = {},
): string {
  const words = (message ?? "").trim();
  if (words === "") return [`👋 **${who}** is checking on this one:`, reminderText(task, now, context)].join("\n");
  return [
    `📣 **${who}** about **${task.title}**:`,
    words,
    "Reply to this message with `done` and your proof when it is finished.",
    context.mine ? `All your tasks: <${context.mine}>` : context.link ? `<${context.link}>` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Who a reminder is going to, and what it may say about the other party. */
export type ReminderContext = {
  /** On the giver's copy: who the task was handed to. */
  to?: string | null;
  /** On the giver's copy: the state of the assignee's reminders, from `assigneeStatusLine`. */
  assigneeStatus?: string | null;
  /** On the assignee's copy: who handed it over. */
  from?: string | null;
  /**
   * On the assignee's copy: say how to answer it (sign in, press Done or turn
   * the reminders off), and — when the overdue cap is reached by this one —
   * that it is the last.
   */
  assignee?: { last: boolean } | null;
  /** Where the task lives on the board, when the site's address is known. */
  link?: string | null;
  /** On the assignee's copy: everything on them, from everyone (`/?mine`). */
  mine?: string | null;
};

/**
 * The reminder Discord actually receives. Deliberately short: one line of
 * urgency, one line of task, one line of when, one line of where it came from.
 * A reminder that needs scrolling is not a reminder.
 *
 * The "when" line is Discord's own timestamp markup: `<t:…:F>` renders the
 * deadline in the READER's time zone and `<t:…:R>` is a relative figure the
 * Discord client keeps counting on its own. The assignee reading it sees the
 * same deadline and countdown the giver sees on the board, without an account.
 */
export function reminderText(
  task: {
    title: string;
    detail?: string | null;
    deadline: string | Date | null;
    source_url?: string | null;
    /** Sent back after review: said on both copies, with what is missing (`lib/review.ts`). */
    review_state?: string | null;
    review_note?: string | null;
  },
  now: Date,
  context: ReminderContext = {},
): string {
  const overdue = isOverdue(task.deadline, now);
  const when = relativeTime(task.deadline, now);
  const deadline = asDate(task.deadline);

  const lines = [
    overdue ? `⏰ **Overdue** — was due ${when}` : `⏳ **Due ${when}**`,
    `**${task.title}**`,
  ];

  if (deadline) {
    const unix = Math.floor(deadline.getTime() / 1000);
    lines.push(`Deadline <t:${unix}:F> (<t:${unix}:R>)`);
  }
  if (context.to) lines.push(`Given to ${context.to}`);
  if (context.assigneeStatus) lines.push(context.assigneeStatus);
  if (context.from) lines.push(`From ${context.from}`);
  if (task.review_state === "rejected") lines.push(`↩️ Sent back after review${task.review_note ? `: ${task.review_note}` : ""}`);
  if (task.detail) lines.push(task.detail);
  if (task.source_url) lines.push(`↪ ${task.source_url}`);

  // Angle brackets stop Discord unfurling the board's sign-in page under every
  // reminder.
  if (context.assignee) {
    // The bot reads its DMs with the people it reminds (`pollDms`), so the
    // simplest answer is a reply right here.
    lines.push(
      "Reply to this message with `start` when you begin, the proof when it is finished (a screenshot, a file, a link or a few words), or `stop` to stop these reminders.",
    );
    if (context.mine) lines.push(`All your tasks, from everyone: <${context.mine}>`);
    else if (context.link) lines.push(`On the board: <${context.link}>`);
    if (context.assignee.last) {
      lines.push(`This is the last reminder I will send you about it. ${context.from ?? "Whoever gave it to you"} has been told.`);
    }
  } else {
    // The giver's copy, about work they handed out: more time is one reply
    // away, and costs the assignee nothing (Lucky35, 2026-10-06).
    if (context.to) lines.push("More time for them? Reply to this message with `6 more hours` (or any amount).");
    if (context.link) lines.push(`Board: <${context.link}>`);
  }

  return lines.join("\n");
}
