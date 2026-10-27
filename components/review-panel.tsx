"use client";

import { useState } from "react";
import { Check, Clock, X } from "lucide-react";

import { formatWhen, fromZonedInput, toZonedInput } from "@/lib/board";
import { EXTEND_CHOICES, extendDeadline } from "@/lib/deadlines";
import { relativeTime } from "@/lib/reminders";
import {
  REVIEW_NOTE_MAX,
  type ReviewInput,
  awaitsReview,
  cleanNote,
  durationText,
  restoredDeadline,
  reviewChoices,
  suggestedApproval,
  timeLeftAtFinish,
} from "@/lib/review";
import type { Task } from "@/lib/types/database";

/**
 * The reviewer's four choices (Lucky35's PO, 2026-10-07):
 *
 *   Approve — on time     towards +0.5 per 5
 *   Approve — late        −1
 *   Disapprove…           −1, and it REOPENS on a new deadline — back to In
 *                         progress, so they keep working (PO, 2026-10-07:
 *                         no "close as failed" any more). A note is
 *                         required: it is kept with the −1 (PO, 2026-10-09)
 *   Extend deadline…      no penalty, open again on the new deadline
 *
 * The approval the facts point to is marked "suggested"; the reviewer may
 * choose the other. On a task never reported, the reviewer can still approve
 * it themselves or disapprove it — extending an open task is the deadline's
 * own +1h / +6h / +1 day. It writes nothing: the choice is raised to `Tracker`.
 */

type Mode = "choose" | "disapprove" | "extend";

type ReviewPanelProps = {
  task: Task;
  now: Date;
  zone: string;
  /** Whose score it moves. */
  assigneeName: string;
  busy: boolean;
  onDecide: (input: ReviewInput) => void;
  /** Shown on a task not reported yet: closes the panel. */
  onCancel?: () => void;
};

export function ReviewPanel({ task, now, zone, assigneeName, busy, onDecide, onCancel }: ReviewPanelProps) {
  const choices = reviewChoices(task);
  const pending = awaitsReview(task);
  const suggested = suggestedApproval(task, now);
  const [mode, setMode] = useState<Mode>("choose");
  const [note, setNote] = useState("");
  const [deadlineText, setDeadlineText] = useState(() => toZonedInput(restoredDeadline(task, now), zone));

  const who = assigneeName || "them";
  const newDeadline = deadlineText ? fromZonedInput(deadlineText, zone) : null;
  const deadlineOk = Boolean(newDeadline && Date.parse(newDeadline) > now.getTime());
  // A disapproval is kept with its reason in the score history (PO, 2026-10-09).
  const noteOk = cleanNote(note) !== "";
  const left = timeLeftAtFinish(task);

  if (choices.length === 0) return null;

  const timing = !task.deadline
    ? "It has no deadline."
    : pending && task.completed_at
      ? Date.parse(task.completed_at) <= Date.parse(task.deadline)
        ? `Reported ${left ? `${durationText(left)} before` : "by"} the deadline (${formatWhen(task.deadline, zone)}).`
        : `Reported ${durationText(Date.parse(task.completed_at) - Date.parse(task.deadline))} after the deadline (${formatWhen(task.deadline, zone)}).`
      : Date.parse(task.deadline) >= now.getTime()
        ? `Due ${relativeTime(task.deadline, now)}.`
        : `The deadline passed ${relativeTime(task.deadline, now)}.`;

  return (
    <section className="review-panel" aria-label="Review">
      <p className="detail-review-line">
        {pending ? (
          <>
            <b>{assigneeName || "They"}</b> reported this done{task.completed_at ? ` ${relativeTime(task.completed_at, now)}` : ""}. Is it?
          </>
        ) : (
          <>Close it yourself, or say it was not done — {who} has not reported it.</>
        )}
      </p>
      <p className="detail-hint">{timing}</p>

      {mode === "choose" ? (
        <>
          <div className="review-choices">
            {(["approve_on_time", "approve_late"] as const).map((decision) => (
              <button
                key={decision}
                className={`btn btn-sm review-choice${decision === suggested ? " btn-primary" : ""}`}
                disabled={busy}
                onClick={() => onDecide({ decision })}
                title={decision === "approve_on_time" ? "Counts towards +0.5 for every 5" : `−1 for ${who}`}
              >
                <Check /> {decision === "approve_on_time" ? "Approve — on time" : "Approve — late"}
                {decision === suggested ? <span className="review-suggested">suggested</span> : null}
                <span className="review-cost">{decision === "approve_on_time" ? "+" : "−1"}</span>
              </button>
            ))}
            <button className="btn btn-sm review-choice" disabled={busy} onClick={() => setMode("disapprove")}>
              <X /> Disapprove…<span className="review-cost">−1</span>
            </button>
            {choices.includes("extend") ? (
              <button className="btn btn-sm review-choice" disabled={busy} onClick={() => setMode("extend")}>
                <Clock /> Extend deadline…<span className="review-cost">0</span>
              </button>
            ) : null}
          </div>
          {onCancel ? (
            <button className="tc-all" onClick={onCancel}>
              Not now
            </button>
          ) : null}
        </>
      ) : null}

      {mode === "disapprove" ? (
        <div className="review-step">
          <p className="sub-title">Disapprove — −1 for {who}</p>
          <textarea
            className="note-edit"
            value={note}
            rows={2}
            maxLength={REVIEW_NOTE_MAX}
            autoFocus
            required
            placeholder={`What was wrong or missing? Required — ${who} gets this by DM, and it is kept with the −1.`}
            aria-label="Why — required"
            aria-invalid={!noteOk}
            onChange={(event) => setNote(event.target.value)}
          />
          {!noteOk ? <p className="detail-hint review-deadline-warn">Say why before you confirm — a disapproval needs a note.</p> : null}
          <p className="detail-hint">
            It reopens — back to In progress for {who}, on the new deadline below — so they can finish it.
          </p>
          <DeadlineField task={task} now={now} zone={zone} value={deadlineText} onChange={setDeadlineText} ok={deadlineOk} />
          <div className="row-actions">
            <button
              className="btn btn-sm btn-danger-solid"
              disabled={busy || !deadlineOk || !noteOk}
              title={noteOk ? undefined : "Write why first"}
              onClick={() => onDecide({ decision: "disapprove_reopen", note, deadline: newDeadline })}
            >
              <X /> Disapprove and reopen
            </button>
            <button className="btn btn-sm" onClick={() => setMode("choose")}>
              Back
            </button>
          </div>
          <p className="detail-hint">
            −1 is counted the moment you confirm. Its proof and this verdict stay on the task. Clicked by mistake? Undo it
            from the task&apos;s activity.
          </p>
        </div>
      ) : null}

      {mode === "extend" ? (
        <div className="review-step">
          <p className="sub-title">Extend the deadline — no penalty</p>
          <DeadlineField task={task} now={now} zone={zone} value={deadlineText} onChange={setDeadlineText} ok={deadlineOk} quick />
          <textarea
            className="note-edit"
            value={note}
            rows={2}
            maxLength={REVIEW_NOTE_MAX}
            placeholder={`Anything ${who} should know? Optional.`}
            aria-label="Note"
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="row-actions">
            <button
              className="btn btn-sm btn-primary"
              disabled={busy || !deadlineOk}
              onClick={() => onDecide({ decision: "extend", note, deadline: newDeadline })}
            >
              <Clock /> Extend
            </button>
            <button className="btn btn-sm" onClick={() => setMode("choose")}>
              Back
            </button>
          </div>
          <p className="detail-hint">It goes back to In progress with the new deadline, and nothing is counted against {who}.</p>
        </div>
      ) : null}
    </section>
  );
}

function DeadlineField({
  task,
  now,
  zone,
  value,
  onChange,
  ok,
  quick = false,
}: {
  task: Task;
  now: Date;
  zone: string;
  value: string;
  onChange: (value: string) => void;
  ok: boolean;
  quick?: boolean;
}) {
  return (
    <div className="review-deadline">
      <label className="detail-review-deadline">
        <span>New deadline</span>
        <input
          className="deadline-input"
          type="datetime-local"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`New deadline, in ${zone}`}
          title={`In ${zone}`}
        />
      </label>
      {quick ? (
        <div className="detail-extend">
          {EXTEND_CHOICES.map((choice) => (
            <button
              key={choice.minutes}
              type="button"
              className="btn btn-sm"
              onClick={() => onChange(toZonedInput(extendDeadline(task.deadline, choice.minutes, now), zone))}
              title={task.deadline ? `${choice.label.slice(1)} after the deadline it has` : `${choice.label.slice(1)} from now`}
            >
              {choice.label}
            </button>
          ))}
        </div>
      ) : null}
      {!ok ? <p className="detail-hint review-deadline-warn">Pick a deadline after now.</p> : null}
    </div>
  );
}
