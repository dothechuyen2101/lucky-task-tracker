"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Bell, BellOff, Check, ExternalLink, Lock, Play, RotateCcw, Trash2, UserX, X } from "lucide-react";

import { useTimeZone } from "@/components/clock";
import { LiveCountdown } from "@/components/countdown";
import { PersonPicker } from "@/components/person-picker";
import { type ProofDraft, ProofForm } from "@/components/proof-form";
import { type RemindResult, RemindNow } from "@/components/remind-now";
import { ReviewPanel } from "@/components/review-panel";
import { TaskActivity } from "@/components/task-activity";
import { ASSIGNEE_STAGE_MAX, type AssigneeAction } from "@/lib/assignee";
import {
  type KnownPerson,
  PRIORITIES,
  type Viewer,
  canReview,
  formatWhen,
  fromZonedInput,
  askedByViewer,
  isShared,
  missingOf,
  personKeyOf,
  personOnCard,
  priorityOf,
  toZonedInput,
  urgencyOf,
} from "@/lib/board";
import { PROJECT_COLORS } from "@/lib/colors";
import { DEFAULT_AUTO_CADENCE_MINUTES, EXTEND_CHOICES, extendDeadline } from "@/lib/deadlines";
import { isDmLink } from "@/lib/discord-links";
import {
  ALERT_FREQUENCIES,
  FRESH_ASSIGNEE_STREAM,
  assigneeCapped,
  assigneeStatusLine,
  relativeTime,
  remindsGiver,
  shouldRemindAssignee,
} from "@/lib/reminders";
import {
  PENDING_STAGE,
  type ReviewInput,
  awaitsReview,
  closedLabel,
  finishedByAssignee,
  reviewChoices,
  reviewedWork,
  settledByReview,
  undoableVerdict,
} from "@/lib/review";
import { IN_PROGRESS_STAGE, STAGES, isDoneStage, stageLabel } from "@/lib/stages";
import { readableMentions } from "@/lib/tagged";
import type { Priority, Task, TaskReview } from "@/lib/types/database";

/**
 * The task in focus, in full — the area beside the track.
 *
 * Everything you do to one task happens here: its title and description, who
 * has it, the deadline and how often it reminds, how far along it is, colour,
 * done, dismiss and delete. A card on the track only shows; this is where you
 * act.
 *
 * A task somebody else gave you is shown whole, and the only things you can do
 * to it are the assignee's own answers — I've started, it is done (with its
 * proof, which is required), stop reminding me, remind me again — which go
 * through `/api/tasks/assignee` and tell whoever reviews it.
 *
 * Work reported done waits here for review (Lucky35's PO, 2026-10-07), with
 * its proof and every earlier round (`TaskHistory`): approve on time, approve
 * late, disapprove — which reopens it — or extend (`ReviewPanel`). The reviewer
 * is whoever created it: the person who asked for it through the owner's bot,
 * or the owner. Closing work given to someone else yourself is the same
 * panel — approving it — and approved or failed work is final. Nothing else is
 * offered on another account's row, because the database would refuse it and
 * a control that cannot work teaches nothing.
 *
 * It writes nothing itself: every change is raised to `Tracker`, which holds the
 * one write path and its rollback. Remounted per task (`key={task.id}` at the
 * call site) so a half-typed title never follows focus to another card.
 */

/*
 * `datetime-local` speaks wall time with no zone; the database stores
 * timestamptz. The field is read and written in the person's own zone
 * (`toZonedInput` / `fromZonedInput` in lib/board.ts) — the same zone the
 * classifier reads "Tuesday" in — so a deadline typed as "18:00" means six in
 * the evening where they are, and the server and the browser render the field
 * the same.
 */

/** Who put the clock on this task. Provenance, not urgency — it carries no colour. */
function deadlineProvenance(task: Task): string {
  if (!task.deadline) return "not yet";
  return task.deadline_source === "auto" ? "from the message" : "by hand";
}

type TaskDetailProps = {
  task: Task;
  viewer: Viewer;
  now: Date;
  busy: boolean;
  /** Everyone the viewer has handed work to — the choices for a missing assignee. */
  known: KnownPerson[];
  /** The viewer's own Discord name, stored as the label when they take a task on. */
  selfName: string | null;
  nameOf: (key: string, task: Task) => string;
  onUpdate: (task: Task, changes: Partial<Task>, scheduled?: boolean) => Promise<void>;
  onStatus: (task: Task, status: Task["status"]) => Promise<void>;
  onStage: (task: Task, ordinal: number) => Promise<void>;
  onDelete: (task: Task) => Promise<void>;
  /** The assignee's answers, on a task somebody else gave the viewer — `stage` with how far along. */
  onAssigneeAction: (task: Task, action: AssigneeAction, opts?: { stage?: number }) => Promise<void>;
  /** Take its person off a card they were only copied in on — the owner, or whoever asked for it (2026-10-20). */
  onNotForThem: (task: Task) => Promise<void>;
  /** Its person says it is not theirs: whoever reviews it is told. An error, or null when it went. */
  onNotMine: (task: Task) => Promise<string | null>;
  /** The verdicts the viewer can read — the newest on this task may be taken back. */
  reviews: TaskReview[];
  /** Take a verdict back (PO, 2026-10-07: "clicked Completed by mistake"). */
  onUndo: (task: Task, review: TaskReview) => Promise<void>;
  /** The viewer is Lucky35 (`tt_is_score_admin()`): may correct any verdict's −1. Only what is offered — the database decides. */
  scoreAdmin: boolean;
  /** DM the assignee a reminder now; resolves to what went wrong, or null. */
  /** "Remind now": DM the assignee at once — `message`, or the usual reminder when it is empty. */
  onRemind: (task: Task, message: string) => Promise<RemindResult>;
  /** "I'm on it": In progress — the assignee's answer on a shared task, the rail on one's own. */
  onStart: (task: Task) => Promise<void>;
  /** A reviewer's verdict: approve on time / late, disapprove (close, reopen), extend. */
  onDecide: (task: Task, input: ReviewInput) => Promise<void>;
  /** The assignee reports it done, with its proof; resolves true when it went through. */
  onReport: (task: Task, proof: ProofDraft) => Promise<boolean>;
  onOpenPerson: (key: string) => void;
  onOpenPersonTasks: (key: string) => void;
  /** The other cards the same message filed — one per person it tagged. */
  siblings: Task[];
  onOpenTask: (id: string) => void;
  /** The name for a Discord id in the message, or null when nothing names it. */
  mentionName: (id: string, task: Task) => string | null;
};

export function TaskDetail({ task, viewer, now, busy, known, selfName, nameOf, onUpdate, onStatus, onStage, onDelete, onAssigneeAction, onNotForThem, onNotMine, reviews, onUndo, scoreAdmin, onRemind, onStart, onDecide, onReport, onOpenPerson, onOpenPersonTasks, siblings, onOpenTask, mentionName }: TaskDetailProps) {
  const zone = useTimeZone();
  const shared = isShared(task, viewer);
  const missing = missingOf(task, viewer);
  const closed = task.status !== "open";
  const urgency = urgencyOf(task, now, zone);
  const personKey = personOnCard(task, viewer);
  const assigneeKey = personKeyOf(task);
  // On a row from another account: whether it is ON the viewer (they answer
  // it), or only readable because they asked for it.
  const onViewer = viewer.selfId !== "" && assigneeKey === viewer.selfId;

  const [title, setTitle] = useState(task.title);
  // The review panel on work not reported yet — opened by Approve, or by the
  // rail reaching Completed. Work reported done shows it without asking.
  const [reviewing, setReviewing] = useState(false);
  // The assignee's "report it done" form, with its proof.
  const [reporting, setReporting] = useState(false);
  const [detail, setDetail] = useState(task.detail);
  const [deadlineText, setDeadlineText] = useState(() => toZonedInput(task.deadline, zone));

  // The row can change under the fields — a write rolled back, a Refresh, the
  // worker. When it does, the fields follow it, so a rejected title is not
  // sent again on the next blur and a newer value is not overwritten by an
  // older one. Adjusted during render, like the board's own lists.
  const [seen, setSeen] = useState({ title: task.title, detail: task.detail, deadline: task.deadline, zone });
  if (seen.title !== task.title || seen.detail !== task.detail || seen.deadline !== task.deadline || seen.zone !== zone) {
    setSeen({ title: task.title, detail: task.detail, deadline: task.deadline, zone });
    if (seen.title !== task.title) setTitle(task.title);
    if (seen.detail !== task.detail) setDetail(task.detail);
    if (seen.deadline !== task.deadline || seen.zone !== zone) setDeadlineText(toZonedInput(task.deadline, zone));
  }

  // The description is as tall as what is written in it, so ten lines are read
  // whole rather than through a three-line slot (Cenri, 2026-10-05). Past
  // `max-height` in the CSS it scrolls; the corner still drags it taller.
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const area = descriptionRef.current;
    if (!area) return;
    // Measured with no scrollbar: collapsed to `rows` it overflows, a classic
    // scrollbar narrows it, the text wraps once more, and the fit came out a
    // line too tall.
    area.style.overflowY = "hidden";
    area.style.height = "auto";
    // scrollHeight leaves out the border, which border-box sizing counts.
    area.style.height = `${area.scrollHeight + area.offsetHeight - area.clientHeight}px`;
    area.style.overflowY = "";
  }, [detail]);

  function commitTitle() {
    const next = title.trim();
    if (next === "" || next === task.title) {
      setTitle(task.title);
      return;
    }
    void onUpdate(task, { title: next }, false);
  }

  // With the giver's own reminders off, the assignee's stream alone schedules
  // the task (lib/reminders.ts, rule 4), so a change to it re-derives the
  // schedule. With them on, the giver's cadence schedules both and is left be.
  const assigneeSchedules = !remindsGiver(task.alert_every_minutes);

  function chooseAssignee(id: string, picked: string | null) {
    if (id === assigneeKey) return;
    // A new person starts a new stream: the last one's "stop", spent cap or
    // failed DM must not follow the task to someone who never asked for it.
    if (id === "") {
      void onUpdate(task, { assignee_discord_id: null, assignee_name: null, ...FRESH_ASSIGNEE_STREAM }, assigneeSchedules);
      return;
    }
    const self = viewer.selfId !== "" && id === viewer.selfId;
    // A known person with no name carries the "@id" placeholder as its label.
    // Storing that would invent a name out of an id; null is the honest value.
    const label = self ? selfName : picked && picked !== `@${id}` ? picked : null;
    void onUpdate(task, { assignee_discord_id: id, assignee_name: label, ...FRESH_ASSIGNEE_STREAM }, assigneeSchedules);
  }

  /**
   * Save what is in the deadline field — on leaving it or pressing Enter, never
   * per keystroke: typing a year wrote 0002, 0020, 0202, 2026 as four racing
   * updates, any of which could be the one that stuck (2026-09-30 audit).
   */
  function commitDeadline() {
    const deadline = deadlineText ? fromZonedInput(deadlineText, zone) : null;
    // Half-typed or impossible: put the field back rather than save it.
    if (deadlineText && !deadline) {
      setDeadlineText(toZonedInput(task.deadline, zone));
      return;
    }
    if (deadline === task.deadline) return;
    const changes: Partial<Task> = { deadline, deadline_source: "manual" };
    // A first deadline with reminders never switched on would count down in
    // silence. Same default the classifier and the Discord command use.
    if (deadline && !task.deadline && !task.alert_every_minutes) {
      changes.alert_every_minutes = DEFAULT_AUTO_CADENCE_MINUTES;
    }
    void onUpdate(task, changes);
  }

  /** More time: later than the deadline it has, never one already missed (`extendDeadline`). */
  function extendBy(minutes: number) {
    const deadline = extendDeadline(task.deadline, minutes, new Date());
    void onUpdate(task, {
      deadline,
      deadline_source: "manual",
      ...(task.alert_every_minutes ? {} : { alert_every_minutes: DEFAULT_AUTO_CADENCE_MINUTES }),
    });
  }

  // Everyone the picker offers, with the current assignee kept on the list even
  // when nothing else names them.
  const choices: KnownPerson[] = [...known];
  if (assigneeKey !== "" && assigneeKey !== viewer.selfId && !choices.some((c) => c.id === assigneeKey)) {
    choices.unshift({ id: assigneeKey, name: nameOf(assigneeKey, task) });
  }

  // The assignee's side of the reminders, for the giver: whether they are being
  // reminded at all, and the one line that says how it is going.
  const assigneeName = assigneeKey === "" ? "" : nameOf(assigneeKey, task);
  const assigneeLine = shared ? null : assigneeStatusLine(task, assigneeName, viewer.selfId || null, now);
  // Who the next reminder goes to: the giver unless they chose "No reminder",
  // the assignee unless their stream is off (Lucky35, 2026-09-30).
  const remindsYou = remindsGiver(task.alert_every_minutes);
  const remindsThem = shouldRemindAssignee(task, viewer.selfId || null, now);
  const reminds = [remindsYou ? "you" : null, remindsThem ? assigneeName : null].filter(Boolean).join(" and ");
  const capped = assigneeCapped(task, now);
  // "Remind now": the reviewer — the board's owner, or whoever asked for it —
  // on open work someone else is doing; on the owner's own given work with
  // nobody on it yet, the button is there but cannot send.
  const canRemind = canReview(task, viewer) && task.status === "open";
  const nobodyYet = !shared && !closed && task.direction === "given" && assigneeKey === "";

  function setAssigneeMuted(muted: boolean) {
    const stamp = new Date().toISOString();
    // The giver did this themselves: they know where it stands, so nothing
    // about it is owed to them (`assignee_mute_told`).
    const told = { assignee_mute_told: muted ? ("muted" as const) : ("unmuted" as const), assignee_mute_told_at: stamp, assignee_mute_notice_due: false };
    void onUpdate(
      task,
      muted
        ? { assignee_muted_at: stamp, assignee_muted_by: "owner", ...told }
        : { assignee_muted_at: null, assignee_muted_by: null, ...told },
      assigneeSchedules,
    );
  }

  // Whether the viewer reviews this task, and whether it is waiting for them.
  const reviewer = canReview(task, viewer);
  // Take its person off a card they were only copied in on: the board's owner,
  // or whoever asked for it through the owner's bot — never about yourself.
  const canTakeOff =
    task.direction === "given" &&
    assigneeKey !== "" &&
    assigneeKey !== viewer.selfId &&
    task.status !== "dismissed" &&
    (!shared || askedByViewer(task, viewer));
  // "Not mine": null until pressed; "sending", "told", or "failed: …".
  const [notMine, setNotMine] = useState<string | null>(null);
  // Work given to someone else on the viewer's own board: its stage is theirs.
  const givenToOther = !shared && reviewedWork(task, viewer.selfId || null);
  // The viewer is the one doing work someone else gave them.
  const doerOfShared = shared && onViewer;
  // A verdict on it that can still be taken back.
  const undoable = reviewer ? undoableVerdict(task, reviews) : null;
  const reviewNow = reviewer && reviewChoices(task).length > 0 && (awaitsReview(task) || reviewing);
  // Approved, or failed: a verdict ended it, and the rail cannot undo that.
  const settled = settledByReview(task);

  /**
   * The rail, with the review's exceptions: reported work moves only by a
   * verdict (the panel above); work given to someone else reaches Completed
   * only by approving it — which opens the panel; and a verdict that ended it
   * is final.
   */
  function clickStage(ordinal: number) {
    const next = task.stage === ordinal ? ordinal - 1 : ordinal;
    // The person doing it says how far along it is (PO, 2026-10-07): Not
    // started, Started, In progress — and back; Testing is reporting it done,
    // with proof; Completed is the reviewer's approval.
    if (doerOfShared) {
      if (task.status !== "open") return;
      if (ordinal <= ASSIGNEE_STAGE_MAX) void onAssigneeAction(task, "stage", { stage: Math.max(0, next) });
      else if (ordinal === PENDING_STAGE) setReporting(true);
      return;
    }
    if (awaitsReview(task) || settled || (finishedByAssignee(task) && !isDoneStage(next))) return;
    if (reviewer && task.status === "open" && isDoneStage(next)) {
      setReviewing(true);
      return;
    }
    // Given to someone else: how far along it is is theirs to say, not the
    // giver's — the giver reviews (and only Completed opens that).
    if (givenToOther) return;
    void onStage(task, ordinal);
  }

  /** Whether a stage on the rail can be pressed by the viewer. */
  function stagePressable(ordinal: number): boolean {
    if (doerOfShared) return task.status === "open" && ordinal <= PENDING_STAGE;
    if (shared) return false;
    if (givenToOther) return task.status === "open" && reviewer && isDoneStage(ordinal);
    return true;
  }

  // Who a name typed in a DM might have meant — the owner picks; nobody was
  // told about the task until they do (Lucky35, 2026-10-03).
  const candidates = !shared && assigneeKey === "" ? (task.assignee_candidates ?? []) : [];

  return (
    <article
      className="detail"
      tabIndex={-1}
      // Waiting for review is not finished: it is not struck through.
      data-closed={closed && !awaitsReview(task)}
      aria-label={`Task: ${task.title}`}
      style={{ ["--task-color" as string]: task.color, opacity: busy ? 0.75 : 1 }}
    >
      <header className="detail-head">
        <span className="swatch" />
        {shared ? (
          <h2 className="detail-title">{task.title}</h2>
        ) : (
          <input
            className="detail-title-input"
            value={title}
            aria-label="Task title"
            onChange={(event) => setTitle(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === "Enter") (event.target as HTMLInputElement).blur();
              if (event.key === "Escape") setTitle(task.title);
            }}
          />
        )}
        {closed ? (
          <span className="tc-status" data-review={task.review_state === "pending"}>
            {closedLabel(task, shared, assigneeName)}
          </span>
        ) : null}
      </header>

      {/* What the work is, right under its name — the first thing read, not
          something found under the rail (Cenri, 2026-10-05). It rides in every
          reminder too (`reminderText`). */}
      <section className="detail-desc">
        <p className="sub-title">Description</p>
        {shared ? (
          task.detail.trim() ? (
            <p className="detail-desc-text">{task.detail}</p>
          ) : (
            <p className="detail-hint">No description.</p>
          )
        ) : (
          <textarea
            ref={descriptionRef}
            className="note-edit detail-desc-edit"
            value={detail}
            rows={4}
            aria-label="Description"
            placeholder="What needs doing — the steps, links, what done looks like. It goes in the reminders too."
            onChange={(event) => setDetail(event.target.value)}
            onBlur={() => {
              if (detail !== task.detail) void onUpdate(task, { detail }, false);
            }}
          />
        )}
      </section>

      {/* Review (Lucky35's PO, 2026-10-07): reported done, with its proof
          below; the reviewer approves it — on time or late — disapproves it
          (which reopens it) or gives more time. */}
      {reviewNow ? (
        <ReviewPanel
          key={`${task.status}:${task.review_state}`}
          task={task}
          now={now}
          zone={zone}
          assigneeName={assigneeName}
          busy={busy}
          onDecide={(input) => {
            setReviewing(false);
            void onDecide(task, input);
          }}
          onCancel={awaitsReview(task) ? undefined : () => setReviewing(false)}
        />
      ) : null}

      {task.status === "open" && (task.review_state === "rejected" || task.review_state === "extended") ? (
        <p className="detail-hint detail-sent-back">
          {task.review_state === "extended" ? "⏩ Deadline extended on review" : "↩ Disapproved and reopened"}
          {task.review_state === "rejected" && task.review_rejections > 1 ? ` (${task.review_rejections}×)` : ""}
          {task.reviewed_at ? ` ${relativeTime(task.reviewed_at, now)}` : ""}
          {shared ? ` by ${task.requested_by_name ?? task.owner_name ?? "the reviewer"}` : ""}
          {task.review_note ? `: “${task.review_note}”` : "."}
        </p>
      ) : null}

      {/* Readable because the viewer asked for it, and it is not on them:
          the owner's bot reminds; the viewer reviews it when it is reported
          done (Lucky35's PO, 2026-10-07: "the reviewer is the task creator"). */}
      {shared && !onViewer ? (
        <section className="detail-assignee-side">
          <p className="detail-lock">
            <Lock aria-hidden="true" />
            <span>
              You asked for this, through <b>{task.owner_name ?? "someone else"}</b>&apos;s bot. It is on their board,
              and their bot reminds {assigneeName && assigneeKey !== "" ? <b>{assigneeName}</b> : "whoever has it"}.
              {reviewer ? " You review it when it is reported done." : " Only they can change it."}
            </span>
          </p>
        </section>
      ) : null}

      {shared && onViewer ? (
        <section className="detail-assignee-side">
          <p className="detail-lock">
            <Lock aria-hidden="true" />
            <span>
              Given to you by <b>{task.requested_by_name ?? task.owner_name ?? "someone else"}</b>. You can say you have
              started, report it done with proof, or stop your reminders; everything else on it is theirs.
            </span>
          </p>
          {awaitsReview(task) ? (
            <div className="detail-hint">
              You reported it done — {task.requested_by_name ?? task.owner_name ?? "the giver"} reviews it next. It is not
              completed until they approve it.{" "}
              <button
                className="tc-all"
                disabled={busy}
                onClick={() => onAssigneeAction(task, "withdraw")}
                title="Reported it by mistake? It goes back to In progress, and the reviewer is told"
              >
                Take my report back
              </button>
            </div>
          ) : task.status === "done" && task.review_state === "accepted" ? (
            <p className="detail-hint">{task.requested_by_name ?? task.owner_name ?? "The giver"} approved it.</p>
          ) : task.status === "failed" ? (
            <p className="detail-hint">It was disapproved and closed.</p>
          ) : null}
          {reporting && task.status === "open" ? (
            <ProofForm
              taskId={task.id}
              title={task.title}
              reviewerName={task.requested_by_name ?? task.owner_name}
              busy={busy}
              onSubmit={async (proof) => {
                const ok = await onReport(task, proof);
                if (ok) setReporting(false);
                return ok;
              }}
              onCancel={() => setReporting(false)}
            />
          ) : null}
          <div className="row-actions">
            {task.status === "open" && task.stage < IN_PROGRESS_STAGE ? (
              <button className="btn btn-sm" disabled={busy} onClick={() => onStart(task)} title="Tell them you are working on it">
                <Play /> Start
              </button>
            ) : null}
            {task.status === "open" && !reporting ? (
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => setReporting(true)}>
                <Check /> Report done…
              </button>
            ) : null}
            {task.assignee_muted_at ? (
              task.assignee_muted_by === "assignee" ? (
                <button className="btn btn-sm" disabled={busy} onClick={() => onAssigneeAction(task, "unmute")}>
                  <Bell /> Remind me again
                </button>
              ) : (
                <span className="detail-hint">{task.owner_name ?? "The giver"} turned your reminders off.</span>
              )
            ) : task.status === "open" && !capped ? (
              <button className="btn btn-sm" disabled={busy} onClick={() => onAssigneeAction(task, "mute")}>
                <BellOff /> Stop reminding me
              </button>
            ) : null}
            {(task.status === "open" || awaitsReview(task)) && notMine === null ? (
              <button
                className="btn btn-sm"
                disabled={busy}
                title="Only copied in on it? Whoever gave it to you is told, and can take you off it"
                onClick={() => {
                  setNotMine("sending");
                  void onNotMine(task).then((failed) => setNotMine(failed ? `failed: ${failed}` : "told"));
                }}
              >
                <UserX /> Not mine
              </button>
            ) : null}
          </div>
          {notMine === "told" ? (
            <p className="detail-hint">
              {task.requested_by_name ?? task.owner_name ?? "Whoever gave it to you"} has been told it is not yours. They can take
              you off it; until then it stays as it is.
            </p>
          ) : notMine?.startsWith("failed: ") ? (
            <p className="detail-hint review-deadline-warn">{notMine.slice("failed: ".length)}</p>
          ) : null}
          <p className="detail-hint">
            {task.requested_by_name ?? task.owner_name ?? "Whoever gave it to you"} is told when you report it done, with
            your proof, and sees on the board when you start. You can also report it on Discord: tag the bot with the
            proof, in reply to the task&apos;s message.
          </p>
        </section>
      ) : null}

      {/* What has happened on it, newest first (PO, 2026-10-07, Loom 1): who
          changed what, the proof and every verdict — kept when it is reopened
          (task.md) — what the bot sent and what people replied. The reviewer
          can nudge the assignee from here, and take a verdict back. */}
      <TaskActivity
        task={task}
        zone={zone}
        now={now}
        busy={busy}
        undoable={undoable}
        onUndo={(review) => void onUndo(task, review)}
        scoreViewer={{ discordId: viewer.selfId, admin: scoreAdmin }}
      />

      {/* Priority (Lucky35's PO, 2026-10-07): set when the task is made, changed
          here by the board's owner; medium when nobody said. */}
      <section className="detail-priority">
        <p className="sub-title">Priority</p>
        {shared ? (
          <span className="priority-pill" data-priority={priorityOf(task)}>
            {PRIORITIES.find((p) => p.key === priorityOf(task))?.label}
          </span>
        ) : (
          <div className="priority-choices" role="radiogroup" aria-label="Priority">
            {PRIORITIES.map((option) => (
              <button
                key={option.key}
                type="button"
                role="radio"
                aria-checked={priorityOf(task) === option.key}
                className="priority-choice"
                data-priority={option.key}
                data-on={priorityOf(task) === option.key}
                disabled={busy}
                onClick={() => {
                  if (priorityOf(task) !== option.key) void onUpdate(task, { priority: option.key as Priority }, false);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* When. The countdown is the headline; the field under it is how it is set.
          Finished work gets no countdown — it would only count down to nothing. */}
      <section className="detail-when">
        {closed ? (
          task.deadline ? (
            <p className="detail-hint">Was due {formatWhen(task.deadline, zone)}</p>
          ) : null
        ) : task.deadline ? (
          <LiveCountdown deadline={task.deadline} urgency={urgency} now={now} size="lg" />
        ) : (
          <span className="tc-missing lg">No deadline yet</span>
        )}

        {shared ? (
          task.deadline && !closed ? (
            <p className="detail-hint">Due {formatWhen(task.deadline, zone)}</p>
          ) : null
        ) : (
          <div className="detail-row">
            <input
              className="deadline-input"
              type="datetime-local"
              data-urgency={urgency}
              value={deadlineText}
              onChange={(event) => setDeadlineText(event.target.value)}
              onBlur={commitDeadline}
              onKeyDown={(event) => {
                if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                if (event.key === "Escape") setDeadlineText(toZonedInput(task.deadline, zone));
              }}
              aria-label={`Deadline, in ${zone}`}
              title={`In ${zone} — change it in Settings`}
            />
            <select
              className="cadence"
              data-on={Boolean(task.alert_every_minutes && task.deadline)}
              value={task.alert_every_minutes ?? ""}
              disabled={!task.deadline}
              title={task.deadline ? "Reminder frequency" : "Set a deadline first"}
              onChange={(event) =>
                onUpdate(task, {
                  alert_every_minutes: event.target.value ? Number(event.target.value) : null,
                })
              }
              aria-label="Reminder frequency"
            >
              {ALERT_FREQUENCIES.map((frequency) => (
                <option key={frequency.short} value={frequency.minutes ?? ""}>
                  {frequency.short === "Off" ? "No reminder" : `Every ${frequency.short}`}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* More time, in one press (Lucky35, 2026-10-06: "give her 6 extra
            hours, otherwise she will get -1"). Added to the deadline it has —
            from now when that is gone — and only the final deadline counts,
            so a miss of the old one is taken back. */}
        {!shared && !closed ? (
          <div className="detail-extend">
            <span className="detail-extend-k">{task.deadline ? "Extend" : "Due in"}</span>
            {EXTEND_CHOICES.map((choice) => (
              <button
                key={choice.minutes}
                className="btn btn-sm"
                disabled={busy}
                onClick={() => extendBy(choice.minutes)}
                title={
                  task.deadline
                    ? `Move the deadline ${choice.label.slice(1)} later — the old one will not count against them`
                    : `Due ${choice.label.slice(1)} from now`
                }
              >
                {choice.label}
              </button>
            ))}
          </div>
        ) : null}

        {!shared && task.suggested_deadline && task.suggested_deadline !== task.deadline ? (
          <button
            className="btn btn-sm"
            onClick={() =>
              onUpdate(task, {
                deadline: task.suggested_deadline,
                deadline_source: "manual",
                ...(task.alert_every_minutes ? {} : { alert_every_minutes: DEFAULT_AUTO_CADENCE_MINUTES }),
              })
            }
            title="The message named this time"
          >
            Use {formatWhen(task.suggested_deadline, zone)}
          </button>
        ) : null}

        {!shared ? (
          <div className="detail-kvs">
            <div className="kv">
              <span>Deadline set</span>
              <span>{deadlineProvenance(task)}</span>
            </div>
            <div className="kv">
              <span>Reminds</span>
              <span>{task.next_alert_at && !closed && reminds ? reminds : "nobody yet"}</span>
            </div>
            <div className="kv">
              <span>Next reminder</span>
              <span className={task.next_alert_at && !closed ? "on" : ""}>
                {task.next_alert_at && !closed ? relativeTime(task.next_alert_at, now) : "not scheduled"}
              </span>
            </div>
            <div className="kv">
              <span>Sent so far</span>
              <span>{task.alerts_sent}</span>
            </div>
          </div>
        ) : null}

        {/* The assignee's side, for the giver: are they actually being reminded?
            Lucky35, 2026-09-29 — the giver could not tell. The same line rides
            in the giver's own reminder DM (`assigneeStatusLine`). */}
        {(assigneeLine && !closed) || canRemind || nobodyYet ? (
          <div className="detail-assignee-status">
            {assigneeLine && !closed ? <p className="detail-hint">{assigneeLine}</p> : null}
            {/* "Remind now" (PO, 2026-10-07, task 5): a ping at once, beside
                "Stop reminding" — the assignee only, an optional message,
                counted in "Sent so far" and kept in the activity. */}
            <RemindNow
              key={task.id}
              task={task}
              zone={zone}
              now={now}
              assigneeName={assigneeName}
              busy={busy}
              onRemind={canRemind ? (message) => onRemind(task, message) : null}
              blocked={nobodyYet ? "Nobody is on it yet — give it to someone first, then you can remind them." : null}
            >
              {assigneeLine && !closed ? (
                task.assignee_muted_at ? (
                  task.assignee_muted_by === "owner" ? (
                    <button className="btn btn-sm" disabled={busy} onClick={() => setAssigneeMuted(false)}>
                      <Bell /> Remind {assigneeName} again
                    </button>
                  ) : null
                ) : capped ? null : (
                  // Nothing to stop once the overdue cap is spent.
                  <button className="btn btn-sm" disabled={busy} onClick={() => setAssigneeMuted(true)}>
                    <BellOff /> Stop reminding {assigneeName}
                  </button>
                )
              ) : null}
            </RemindNow>
          </div>
        ) : null}
      </section>

      {/* Who. A given task that arrived with nobody on it is fixed right here. */}
      <section className="detail-who">
        <p className="sub-title">{task.direction === "received" ? "Asked of" : "Given to"}</p>
        {shared && !onViewer ? (
          // Asked for by the viewer, on someone else's board: who has it —
          // the board's owner when it was asked of them.
          <p className="detail-person">
            {task.direction === "received" ? (
              <b>{task.owner_name ?? "the board's owner"}</b>
            ) : assigneeKey !== "" ? (
              <button className="tc-name" onClick={() => onOpenPerson(assigneeKey)}>
                {nameOf(assigneeKey, task)}
              </button>
            ) : (
              <span className="tc-missing">Nobody yet</span>
            )}
            <span className="detail-hint"> — you asked</span>
          </p>
        ) : shared || task.direction === "received" ? (
          <p className="detail-person">
            <button className="tc-name" onClick={() => onOpenPerson(personKey)} disabled={personKey === ""}>
              You
            </button>
            {task.direction === "received" && !shared ? (
              <span className="detail-hint"> — {task.counterparty ?? "someone"} asked</span>
            ) : null}
          </p>
        ) : (
          <>
            <PersonPicker
              value={assigneeKey}
              valueLabel={assigneeKey === "" ? "Nobody yet" : assigneeKey === viewer.selfId ? "Me" : nameOf(assigneeKey, task)}
              selfId={viewer.selfId}
              selfName={selfName}
              known={choices.map((person) => ({ id: person.id, name: person.name, label: person.name, where: "worked with before" }))}
              allowNobody
              allowSelf
              missing={missing.assignee}
              ariaLabel="Who this task is given to"
              onPick={chooseAssignee}
            />
            {assigneeKey !== "" ? (
              <p className="detail-links">
                <button className="tc-name" onClick={() => onOpenPerson(assigneeKey)}>
                  {nameOf(assigneeKey, task)}
                </button>
                <button className="tc-all" onClick={() => onOpenPersonTasks(assigneeKey)}>
                  All tasks
                </button>
              </p>
            ) : candidates.length > 0 ? (
              <div className="detail-candidates">
                <p className="detail-hint">Who did you mean? It isn&apos;t given to anyone until you pick:</p>
                <div className="row-actions">
                  {candidates.map((candidate) => (
                    <button
                      key={candidate.id}
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() =>
                        onUpdate(
                          task,
                          { assignee_discord_id: candidate.id, assignee_name: candidate.name, ...FRESH_ASSIGNEE_STREAM },
                          assigneeSchedules,
                        )
                      }
                      title={candidate.where ?? undefined}
                    >
                      {candidate.label}
                      {candidate.where ? <span className="candidate-where"> · {candidate.where}</span> : null}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="detail-hint">
                Pick someone, or @-mention them next time you tag the bot and they are filled in for you.
              </p>
            )}
          </>
        )}
        {/* The same message tagged others too: each has their own card, with
            their own reminders and their own "done" (Lucky35's PO, 2026-10-05). */}
        {siblings.length > 0 ? (
          <p className="detail-links detail-siblings">
            <span className="detail-hint">Also given to</span>
            {siblings.map((sibling) => (
              <button key={sibling.id} className="tc-name" onClick={() => onOpenTask(sibling.id)} title="Open their card">
                {sibling.assignee_discord_id ? nameOf(sibling.assignee_discord_id, sibling) : "nobody yet"}
              </button>
            ))}
          </p>
        ) : null}
        {/* Copied in, not given the work (Cenri, 2026-10-20): tagged after "cc"
            or "fyi", or taken off a card as "only copied in". No card, no reminders. */}
        {(task.cc ?? []).length > 0 ? (
          <p className="detail-links detail-cc">
            <span className="detail-hint">CC</span>
            {(task.cc ?? []).map((person, index) => (
              <span key={person.id ?? `${person.name}-${index}`} className="detail-cc-name">
                {person.name ? `@${person.name}` : person.id ? nameOf(person.id, task) : "someone"}
              </span>
            ))}
          </p>
        ) : null}
        {canTakeOff ? (
          <p className="detail-hint detail-not-for">
            Only copied in?{" "}
            <button
              className="tc-all"
              disabled={busy}
              onClick={() => void onNotForThem(task)}
              title="Close this card for them: nothing counts for or against them, their reminders stop, and they are told"
            >
              Take {assigneeName || "them"} off this
            </button>
          </p>
        ) : null}
      </section>

      {/* How far along. The same five stages as ever; compact, because this column is narrow. */}
      <section className="detail-stage">
        <p className="sub-title">
          Stage <span className="detail-stage-label">{stageLabel(task.stage)}</span>
        </p>
        {givenToOther ? (
          <p className="detail-hint">
            {assigneeName || "They"} set{assigneeName ? "s" : ""} how far along it is; you review it when it is reported done.
            {task.stage > 0 && task.stage_at?.[String(task.stage)] ? ` ${stageLabel(task.stage)} since ${relativeTime(task.stage_at[String(task.stage)], now)}.` : ""}
          </p>
        ) : doerOfShared && task.status === "open" ? (
          <p className="detail-hint">Say how far along you are — click your stage again to step back. Completed is when it is approved.</p>
        ) : null}
        <div className="rail detail-rail" data-closed={closed && !awaitsReview(task)}>
          {STAGES.map((stageDef) => {
            const filled = task.stage >= stageDef.ordinal;
            const lead = task.stage === stageDef.ordinal;
            return (
              <div className="stage" key={stageDef.key} data-filled={filled} data-lead={lead}>
                <button
                  className="pip"
                  data-filled={filled}
                  data-lead={lead}
                  disabled={busy || !stagePressable(stageDef.ordinal)}
                  onClick={() => clickStage(stageDef.ordinal)}
                  title={
                    !stagePressable(stageDef.ordinal)
                      ? givenToOther
                        ? `${assigneeName || "They"} set${assigneeName ? "s" : ""} how far along it is — you review it`
                        : stageDef.label
                      : doerOfShared && stageDef.ordinal === PENDING_STAGE
                        ? "Report it done, with proof"
                        : lead
                          ? `${stageDef.label} — click again to step back`
                          : `Mark ${stageDef.label}`
                  }
                  aria-label={stageDef.label}
                  aria-pressed={filled}
                >
                  {filled ? <Check /> : null}
                </button>
                <span className="stage-name">{stageDef.label}</span>
              </div>
            );
          })}
        </div>
      </section>

      {task.source_excerpt ? (
        <section>
          <p className="sub-title">The message</p>
          <blockquote className="quote">{readableMentions(task.source_excerpt, (id) => mentionName(id, task))}</blockquote>
          <div className="quote-meta">
            <span>{formatWhen(task.created_at, zone)}</span>
            {/* Only the two people in a DM can open a link into it: the
                assignee of a task the giver sent their bot by DM is told so
                rather than handed a link that cannot work. */}
            {task.source_url && shared && isDmLink(task.source_url) ? (
              <span>Sent by DM to {task.owner_name ?? "the giver"}&apos;s bot</span>
            ) : task.source_url ? (
              <a href={task.source_url} target="_blank" rel="noreferrer">
                <ExternalLink style={{ width: 12, height: 12, display: "inline", marginRight: 4 }} />
                {isDmLink(task.source_url) ? "Open the DM" : "Open in Discord"}
              </a>
            ) : null}
          </div>
        </section>
      ) : null}

      {!shared ? (
        <>
          <section>
            <p className="sub-title">Colour</p>
            <div className="swatches">
              {PROJECT_COLORS.map((color) => (
                <button
                  key={color}
                  className="swatch-btn"
                  data-active={color.toLowerCase() === task.color.toLowerCase()}
                  style={{ background: color }}
                  onClick={() => onUpdate(task, { color }, false)}
                  aria-label={`Colour ${color}`}
                />
              ))}
            </div>
          </section>

          <div className="row-actions detail-actions">
            {settled || awaitsReview(task) || finishedByAssignee(task) ? null : task.status === "done" ? (
              // The owner's own finished work: theirs to reopen. Reported,
              // approved or failed work is moved only by a verdict.
              <button className="btn btn-sm" disabled={busy} onClick={() => onStatus(task, "open")}>
                <RotateCcw /> Reopen
              </button>
            ) : task.status === "open" && reviewer ? (
              // Given to someone else: closing it is approving it — on time or
              // late — so it opens the review.
              reviewNow ? null : (
                <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => setReviewing(true)}>
                  <Check /> Approve or disapprove…
                </button>
              )
            ) : task.status === "open" ? (
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => onStatus(task, "done")}>
                <Check /> Mark done
              </button>
            ) : null}
            {task.status === "dismissed" ? (
              <button className="btn btn-sm" disabled={busy} onClick={() => onStatus(task, "open")}>
                <RotateCcw /> Restore
              </button>
            ) : (
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={() => onStatus(task, "dismissed")}
                title="Not a task — dismiss it without deleting it"
              >
                <X /> Dismiss
              </button>
            )}
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => onDelete(task)}>
              <Trash2 /> Delete
            </button>
          </div>
        </>
      ) : null}
    </article>
  );
}
