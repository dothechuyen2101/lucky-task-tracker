/**
 * What has happened on a task, newest first — pure, so it is testable.
 *
 * Lucky35's PO, 2026-10-07 (Loom 1): opening a task, the reviewer could not
 * tell whether anyone had done anything or been messaged, so could not decide
 * to close it, keep it open or send a reminder. One timeline answers that,
 * from every place the tracker already keeps a trace:
 *
 *   changes   who moved the status, the stage, the deadline, the assignee
 *             (`tt_task_events`, written by a trigger — `20261007_02`)
 *   reminders sent by hand — "Remind now" — with who and what they said
 *             (`tt_task_events` kind 'reminded', `20261007_03`)
 *   proof     what the assignee reported it done with (`tt_task_proofs`)
 *   verdicts  approve / disapprove / extend, and any taken back
 *   the bot   the reminders and notices it sent, and whether they arrived
 *             (`tt_alerts`; the owner's only)
 *   replies   what people answered in Discord about it (`tt_messages`)
 *
 * The same moment is never told twice: a report's status and stage change is
 * the proof entry, a verdict's is the verdict entry, and a run of reminders is
 * one line with a count.
 *
 * Imported by a client component: no network, no database, no clock.
 */

import { decisionLabel, reviewPenalty } from "@/lib/review";
import { stripMentions } from "@/lib/relevance";
import { stageLabel } from "@/lib/stages";
import type { Alert, Task, TaskEvent, TaskProof, TaskReview } from "@/lib/types/database";

export type ActivityEntry = {
  key: string;
  at: string;
  /** Who did it; null for the tracker itself. */
  who: string | null;
  text: string;
  /** Their words, quoted: a note, a reply. */
  quote?: string | null;
  /** The proof a report was sent with. */
  proofs?: TaskProof[];
  /** The verdict, when the entry is one. */
  review?: TaskReview;
  tone: "neutral" | "good" | "bad" | "muted";
  /** Something the bot sent — quieter than what a person did. */
  bot?: boolean;
};

/** The message a task was filed from. */
export type ActivitySource = { author_name: string | null; channel_name: string | null; via_dm: boolean; sent_at: string };

/** A message about the task: an owner's reply in Discord, an assignee's answer by DM. */
export type ActivityReply = {
  id: string;
  author_name: string | null;
  content: string;
  sent_at: string;
  via_dm: boolean;
};

export type ActivityInput = {
  task: Pick<Task, "id" | "created_at" | "owner_name" | "assignee_name" | "requested_by_name" | "direction" | "counterparty">;
  source: ActivitySource | null;
  events: readonly TaskEvent[];
  reviews: readonly TaskReview[];
  proofs: readonly TaskProof[];
  alerts: ReadonlyArray<Pick<Alert, "id" | "kind" | "ok" | "error" | "sent_at">>;
  replies: readonly ActivityReply[];
};

/** Two moments this close are one action seen from two tables. */
const SAME_MOMENT_MS = 15_000;

/** Proof sent this close together is one report. */
const ONE_REPORT_MS = 60_000;

const near = (a: string, b: string, ms = SAME_MOMENT_MS) => Math.abs(Date.parse(a) - Date.parse(b)) <= ms;

const STATUS_WORDS: Record<string, string> = {
  open: "open",
  done: "done",
  dismissed: "dismissed",
  failed: "failed",
};

/** The pair a change was stored as, or null. */
function pair(changes: Record<string, unknown>, field: string): [unknown, unknown] | null {
  const value = changes[field];
  return Array.isArray(value) && value.length === 2 ? [value[0], value[1]] : null;
}

/**
 * Every entry, newest first. `when` prints a time in the reader's zone (the
 * caller passes `formatWhen` bound to it).
 */
export function activityOf(input: ActivityInput, when: (iso: string) => string): ActivityEntry[] {
  const { task, source, events, reviews, proofs, alerts, replies } = input;
  const assignee = task.assignee_name ?? "the assignee";
  const entries: ActivityEntry[] = [];

  // --- how it began ---------------------------------------------------------
  const created = events.find((event) => event.kind === "created");
  const by = created?.actor_name ?? source?.author_name ?? task.requested_by_name ?? task.counterparty ?? task.owner_name ?? null;
  const start = created ? (created.changes as Record<string, unknown>) : {};
  const startedWith = [
    typeof start.assignee === "string" ? `for ${start.assignee}` : null,
    typeof start.deadline === "string" ? `due ${when(start.deadline)}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const where = source ? (source.via_dm ? " by DM to the bot" : source.channel_name ? ` in #${source.channel_name}` : "") : "";
  entries.push({
    key: `created:${task.id}`,
    at: created?.at ?? task.created_at,
    who: by,
    text: `created it${where}${startedWith ? ` — ${startedWith}` : ""}`,
    tone: "neutral",
  });

  // --- reports, with their proof ----------------------------------------------
  const reports: TaskProof[][] = [];
  for (const proof of [...proofs].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    const last = reports[reports.length - 1];
    if (last && near(last[last.length - 1].created_at, proof.created_at, ONE_REPORT_MS)) last.push(proof);
    else reports.push([proof]);
  }
  for (const group of reports) {
    entries.push({
      key: `report:${group[0].id}`,
      at: group[0].created_at,
      who: group[0].submitted_by_name ?? assignee,
      text: `reported it done${group[0].source === "discord" ? " on Discord" : ""}`,
      proofs: group,
      tone: "neutral",
    });
  }

  // --- verdicts ---------------------------------------------------------------
  for (const review of reviews) {
    const undone = review.excused_reason === "undone";
    const excused = review.excused_at !== null && !undone;
    const cost = reviewPenalty(review.decision) > 0 ? " (−1)" : "";
    entries.push({
      key: `review:${review.id}`,
      at: review.decided_at,
      who: review.reviewer_name ?? "The reviewer",
      text:
        `${decisionLabel(review.decision).replace(/^./, (c) => c.toLowerCase())}${cost}` +
        (review.new_deadline ? ` — new deadline ${when(review.new_deadline)}` : "") +
        (undone ? " — taken back" : excused ? " — not counted" : ""),
      quote: review.note,
      review,
      tone: undone || excused ? "muted" : review.decision.startsWith("approve") ? "good" : reviewPenalty(review.decision) > 0 ? "bad" : "neutral",
    });
  }

  // --- reminders sent by hand: who, to whom, and their words ------------------
  for (const event of events) {
    if (event.kind !== "reminded") continue;
    const changes = event.changes as Record<string, unknown>;
    const to = typeof changes.to === "string" && changes.to !== "" ? changes.to : assignee;
    const words = typeof changes.message === "string" && changes.message.trim() !== "" ? changes.message.trim() : null;
    const ok = changes.ok !== false;
    entries.push({
      key: `reminded:${event.id}`,
      at: event.at,
      who: event.actor_name,
      text: ok
        ? `reminded ${to} now${words ? "" : " — the usual reminder"}`
        : `tried to remind ${to} — it did not arrive`,
      quote: ok ? words : typeof changes.error === "string" ? changes.error : words,
      tone: ok ? "neutral" : "bad",
    });
  }

  // --- "not mine": its person said they were only copied in (2026-10-20) ------
  for (const event of events) {
    if (event.kind !== "not_mine") continue;
    entries.push({
      key: `not_mine:${event.id}`,
      at: event.at,
      who: event.actor_name,
      text: "said it is not theirs — they were only copied in",
      tone: "neutral",
    });
  }

  // --- changes made on the task itself ---------------------------------------
  const reportNear = (at: string) => proofs.some((proof) => near(proof.created_at, at, ONE_REPORT_MS));
  const verdictNear = (at: string) => reviews.some((review) => near(review.decided_at, at));
  for (const event of events) {
    if (event.kind !== "changed") continue;
    const changes = event.changes as Record<string, unknown>;
    const owned = verdictNear(event.at) || reportNear(event.at);
    const parts: string[] = [];

    const status = pair(changes, "status");
    const review = pair(changes, "review_state");
    if (status && !owned) {
      const [from, to] = status as [string, string];
      if (from === "done" && to === "open" && review?.[0] === "pending") parts.push("took back their report — it is open again");
      else if (to === "done" && review?.[1] === "pending") parts.push("reported it done");
      else if (to === "done") parts.push("marked it done");
      else if (to === "dismissed") parts.push("dismissed it");
      else if (from === "dismissed" && to === "open") parts.push("restored it");
      else if (to === "open") parts.push("reopened it");
      else parts.push(`set it ${STATUS_WORDS[to] ?? to}`);
    }

    const stage = pair(changes, "stage");
    if (stage && !owned && !status) {
      const [from, to] = stage as [number, number];
      parts.push(to < from ? `moved it back to ${stageLabel(to)}` : `moved it to ${stageLabel(to)}`);
    }

    const deadline = pair(changes, "deadline");
    if (deadline && !verdictNear(event.at)) {
      const [from, to] = deadline as [string | null, string | null];
      if (!from && to) parts.push(`set the deadline: ${when(to)}`);
      else if (from && !to) parts.push("removed the deadline");
      else if (from && to) {
        const later = Date.parse(to) > Date.parse(from);
        parts.push(`${later ? "extended" : "moved"} the deadline from ${when(from)} to ${when(to)}`);
      }
    }

    const handed = pair(changes, "assignee");
    if (handed) {
      const [from, to] = handed as [string | null, string | null];
      parts.push(to ? `gave it to ${to}${from ? ` (was ${from})` : ""}` : `took it off ${from ?? "its assignee"}`);
    }

    const priority = pair(changes, "priority");
    if (priority) parts.push(`set the priority to ${String(priority[1])}`);

    const title = pair(changes, "title");
    if (title) parts.push(`renamed it “${String(title[1])}”`);

    if (parts.length === 0) continue;
    entries.push({ key: `event:${event.id}`, at: event.at, who: event.actor_name, text: parts.join("; "), tone: "neutral" });
  }

  // --- what the bot sent -------------------------------------------------------
  const BOT_TEXT: Record<string, (ok: boolean) => string> = {
    assignee: (ok) => (ok ? `reminded ${assignee}` : `could not deliver a reminder to ${assignee}`),
    manual_reminder: (ok) => (ok ? `sent ${assignee} a reminder, by hand` : `could not deliver the reminder to ${assignee}`),
    assigned: (ok) => (ok ? `told ${assignee} the task is theirs` : `could not tell ${assignee} the task is theirs`),
    handoff: (ok) => (ok ? "told the previous assignee it is no longer theirs" : "could not tell the previous assignee"),
    verdict: (ok) => (ok ? `sent ${assignee} the verdict` : `could not send ${assignee} the verdict`),
    review_nudge: (ok) => (ok ? "reminded the reviewer it is waiting" : "could not remind the reviewer"),
  };
  // A reminder sent by hand is told above, with who sent it — its alert row is
  // the same DM.
  const byHand = events.filter((event) => event.kind === "reminded");
  const sent = [...alerts]
    .filter((alert) => alert.kind in BOT_TEXT)
    .filter((alert) => alert.kind !== "manual_reminder" || !byHand.some((event) => near(event.at, alert.sent_at)))
    .sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at));
  let run: { kind: string; ok: boolean; first: string; last: string; count: number; error: string | null; id: string } | null = null;
  const flush = () => {
    if (!run) return;
    const text = BOT_TEXT[run.kind](run.ok);
    entries.push({
      key: `alert:${run.id}`,
      at: run.last,
      who: null,
      text: run.count > 1 ? `${text} — ${run.count} times since ${when(run.first)}` : text,
      quote: run.ok ? null : run.error,
      tone: run.ok ? "muted" : "bad",
      bot: true,
    });
    run = null;
  };
  for (const alert of sent) {
    // Only reminders of the same outcome fold into one line.
    if (run && run.kind === alert.kind && run.ok === alert.ok && (alert.kind === "assignee" || alert.kind === "review_nudge")) {
      run.count += 1;
      run.last = alert.sent_at;
      continue;
    }
    flush();
    run = { kind: alert.kind, ok: alert.ok, first: alert.sent_at, last: alert.sent_at, count: 1, error: alert.error, id: alert.id };
  }
  flush();

  // --- what people said about it in Discord ----------------------------------
  for (const reply of replies) {
    const words = stripMentions(reply.content) || reply.content;
    entries.push({
      key: `reply:${reply.id}`,
      at: reply.sent_at,
      who: reply.author_name,
      text: reply.via_dm ? "wrote to the bot about it" : "replied about it in Discord",
      quote: words.length > 240 ? `${words.slice(0, 239)}…` : words,
      tone: "neutral",
    });
  }

  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.key.localeCompare(b.key));
}

/** The newest thing a PERSON did — what "latest update" means to a reviewer. */
export function latestUpdate(entries: readonly ActivityEntry[]): ActivityEntry | null {
  return entries.find((entry) => !entry.bot) ?? null;
}
