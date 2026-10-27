"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, FileText, Link2, Undo2 } from "lucide-react";

import { formatWhen } from "@/lib/board";
import { type ActivityEntry, type ActivityReply, type ActivitySource, activityOf, latestUpdate } from "@/lib/activity";
import { isImage } from "@/lib/proof";
import { relativeTime } from "@/lib/reminders";
import { REVIEW_NOTE_MAX, reviewPenalty } from "@/lib/review";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Alert, Task, TaskEvent, TaskProof, TaskReview } from "@/lib/types/database";

/**
 * What has happened on a task (Lucky35's PO, 2026-10-07, Loom 1): who changed
 * what and when, what the assignee reported and with which proof, every
 * verdict, every reminder the bot sent and whether it arrived, and what
 * people replied in Discord — newest first, with the latest thing a person did
 * on top. Enough to decide whether to close it, keep it open, or remind them
 * now ("Remind now", `components/remind-now.tsx`, which this lists too).
 *
 * Read on the viewer's own session, so RLS decides what they see: the owner
 * sees everything; the assignee and the person who asked see the changes, the
 * proof and the verdicts, never the owner's message log. Read again whenever
 * the task row changes.
 */

const SHOWN_AT_FIRST = 8;

type Props = {
  task: Task;
  zone: string;
  now: Date;
  /** The verdict that can still be taken back, if any — and how. */
  undoable?: TaskReview | null;
  onUndo?: (review: TaskReview) => void;
  /**
   * Who is looking, for the score: a verdict's −1 may be corrected by Lucky35
   * or by the reviewer who gave it (`tt_correct_score`, 20261009_01).
   */
  scoreViewer?: { discordId: string; admin: boolean };
  busy: boolean;
};

type Loaded = {
  events: TaskEvent[];
  reviews: TaskReview[];
  proofs: TaskProof[];
  alerts: Alert[];
  replies: ActivityReply[];
  source: ActivitySource | null;
};

type Result = { data: unknown; error: { message: string } | null };

export function TaskActivity({ task, zone, now, undoable, onUndo, scoreViewer, busy }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let live = true;
    const db = createSupabaseBrowserClient();
    const sourceId = task.source_message_id ?? task.message_id;
    Promise.all([
      db.from("tt_task_events").select("*").eq("task_id", task.id).order("at", { ascending: true }),
      db.from("tt_task_reviews").select("*").eq("task_id", task.id).order("decided_at", { ascending: true }),
      db.from("tt_task_proofs").select("*").eq("task_id", task.id).order("created_at", { ascending: true }),
      // The owner's own log: anyone else is served nothing, by RLS.
      db.from("tt_alerts").select("id, kind, ok, error, sent_at").eq("task_id", task.id).order("sent_at", { ascending: true }).limit(500),
      db
        .from("tt_messages")
        .select("id, author_name, content, sent_at, via_dm")
        .eq("command_target_task", task.id)
        .order("sent_at", { ascending: true })
        .limit(200),
      sourceId
        ? db.from("tt_messages").select("author_name, channel_name, via_dm, sent_at").eq("id", sourceId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]).then(
      ([events, reviews, proofs, alerts, replies, source]: Result[]) => {
        if (!live) return;
        // A table not there yet (a migration still to apply) costs only its own lines.
        setError(proofs.error?.message ?? reviews.error?.message ?? null);
        setLoaded({
          events: (events.error ? [] : (events.data ?? [])) as TaskEvent[],
          reviews: (reviews.data ?? []) as TaskReview[],
          proofs: (proofs.data ?? []) as TaskProof[],
          alerts: (alerts.error ? [] : (alerts.data ?? [])) as Alert[],
          replies: (replies.error ? [] : (replies.data ?? [])) as ActivityReply[],
          source: (source.error ? null : source.data) as ActivitySource | null,
        });
      },
      (caught: unknown) => {
        if (live) setError(caught instanceof Error ? caught.message : String(caught));
      },
    );
    return () => {
      live = false;
    };
  }, [task.id, task.updated_at, task.source_message_id, task.message_id]);

  if (error) return <p className="detail-hint">Could not load what happened on it: {error}</p>;
  if (!loaded) return null;

  const entries = activityOf({ task, ...loaded }, (iso) => formatWhen(iso, zone));
  const latest = latestUpdate(entries);
  const shown = showAll ? entries : entries.slice(0, SHOWN_AT_FIRST);

  return (
    <section className="task-activity" aria-label="Activity">
      <div className="activity-head">
        <p className="sub-title">Activity</p>
      </div>
      {latest ? (
        <p className="activity-latest">
          <span className="activity-latest-k">Latest</span> <b>{latest.who ?? "Task Tracker"}</b> {latest.text} ·{" "}
          {relativeTime(latest.at, now)}
        </p>
      ) : null}
      <ol className="activity-list">
        {shown.map((entry) => (
          <ActivityRow
            key={entry.key}
            entry={entry}
            zone={zone}
            undo={entry.review && undoable && entry.review.id === undoable.id && onUndo ? () => onUndo(entry.review!) : null}
            correctable={Boolean(entry.review && scoreViewer && correctableBy(entry.review, scoreViewer))}
            busy={busy}
          />
        ))}
      </ol>
      {entries.length > SHOWN_AT_FIRST ? (
        <button className="tc-all" onClick={() => setShowAll((all) => !all)}>
          {showAll ? "Show less" : `Show all ${entries.length}`}
        </button>
      ) : null}
    </section>
  );
}

/** A verdict whose −1 this viewer may correct: one that cost a point and still stands, given by them — or any, for Lucky35. */
function correctableBy(review: TaskReview, viewer: { discordId: string; admin: boolean }): boolean {
  if (reviewPenalty(review.decision) === 0 || review.excused_at !== null) return false;
  return viewer.admin || (viewer.discordId !== "" && review.reviewer_discord_id === viewer.discordId);
}

function ActivityRow({
  entry,
  zone,
  undo,
  correctable,
  busy,
}: {
  entry: ActivityEntry;
  zone: string;
  undo: (() => void) | null;
  correctable: boolean;
  busy: boolean;
}) {
  return (
    <li className="activity-item" data-tone={entry.tone} data-bot={Boolean(entry.bot)}>
      <p className="activity-line">
        <b>{entry.who ?? "Task Tracker"}</b> {entry.text}
        <span className="activity-when"> · {formatWhen(entry.at, zone)}</span>
      </p>
      {entry.quote ? <p className="history-note">“{entry.quote}”</p> : null}
      {entry.proofs?.map((proof) => <ProofItem key={proof.id} proof={proof} />)}
      {undo ? (
        <button className="btn btn-sm activity-undo" disabled={busy} onClick={undo} title="Clicked by mistake? Put the task back as it was — nothing from this verdict will count">
          <Undo2 /> Undo this verdict
        </button>
      ) : null}
      {correctable && entry.review ? <CorrectVerdict review={entry.review} /> : null}
    </li>
  );
}

/**
 * Correct a verdict's −1 without touching the task (PO, 2026-10-09: "a wrong
 * point is reversed by adding a new entry"): a +1 beside it in the person's
 * score history, with a note. Undo is for putting the TASK back; this is for
 * a verdict that was right about the task and wrong about the point.
 */
function CorrectVerdict({ review }: { review: TaskReview }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);

  if (said?.ok) {
    return (
      <p className="detail-hint">
        {said.text}{" "}
        <Link className="tc-all" href={`/scores?person=${encodeURIComponent(review.assignee_discord_id ?? "")}`}>
          Score history
        </Link>
      </p>
    );
  }
  if (!open) {
    return (
      <button className="btn btn-sm activity-undo" onClick={() => setOpen(true)} title="Give the point back — the −1 stays listed, with a +1 correction beside it">
        <Undo2 /> Correct the −1…
      </button>
    );
  }
  const ready = note.trim() !== "";
  return (
    <form
      className="score-correct"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || busy) return;
        setBusy(true);
        createSupabaseBrowserClient()
          .rpc("tt_correct_score", { p_entry: null, p_review: review.id, p_note: note })
          .then(
            ({ error }: { error: { message: string } | null }) => {
              setBusy(false);
              setSaid(error ? { ok: false, text: error.message } : { ok: true, text: "Corrected — +1 added beside the −1." });
            },
            (caught: unknown) => {
              setBusy(false);
              setSaid({ ok: false, text: caught instanceof Error ? caught.message : String(caught) });
            },
          );
      }}
    >
      <textarea
        className="note-edit"
        value={note}
        rows={2}
        maxLength={REVIEW_NOTE_MAX}
        autoFocus
        required
        placeholder="Why? Required — e.g. “correction, disapproved by mistake”."
        aria-label="Why — required"
        onChange={(event) => setNote(event.target.value)}
      />
      {said && !said.ok ? <p className="detail-hint review-deadline-warn">{said.text}</p> : null}
      <div className="row-actions">
        <button className="btn btn-sm btn-primary" type="submit" disabled={!ready || busy}>
          Add +1 correction
        </button>
        <button className="btn btn-sm" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** One piece of proof — words, a link, a picture or a file. Shared with the score history. */
export function ProofItem({ proof }: { proof: TaskProof }) {
  if (proof.kind === "text") return <p className="proof-text">{proof.body}</p>;
  if (proof.kind === "link") {
    return (
      <a className="proof-link" href={proof.body ?? "#"} target="_blank" rel="noreferrer">
        <Link2 aria-hidden="true" /> {proof.body}
      </a>
    );
  }
  const href = `/api/tasks/proof/${proof.id}`;
  return isImage(proof) ? (
    <a className="proof-image" href={href} target="_blank" rel="noreferrer" title={proof.file_name ?? "Open"}>
      {/* A redirect to a short-lived link: next/image cannot optimise it. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={href} alt={proof.file_name ?? "Proof"} loading="lazy" />
    </a>
  ) : (
    <a className="proof-link" href={href} target="_blank" rel="noreferrer">
      <FileText aria-hidden="true" /> {proof.file_name ?? "File"}
      {proof.size_bytes ? <span className="proof-size"> · {Math.max(1, Math.round(proof.size_bytes / 1024))} KB</span> : null}
      <ExternalLink aria-hidden="true" />
    </a>
  );
}
