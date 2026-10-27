"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight, Download, ExternalLink, Undo2 } from "lucide-react";

import { ProofItem } from "@/components/task-activity";
import { formatWhen, personColor } from "@/lib/board";
import { REVIEW_NOTE_MAX } from "@/lib/review";
import {
  type HistoryViewer,
  type Period,
  type PeriodKind,
  type PersonTotals,
  type Sign,
  PERIOD_KINDS,
  amountOf,
  asKind,
  canCorrect,
  correctionsOf,
  csvFileName,
  entriesOfSign,
  formatPoints,
  hasBegun,
  historyCsv,
  lateLine,
  periodLabel,
  periodRange,
  reasonLabel,
  shiftPeriod,
  todayIn,
  totalsCsv,
  totalsFor,
} from "@/lib/score-history";
import { ON_TIME_BONUS, ON_TIME_RUN } from "@/lib/team";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { ScoreEntry, TaskProof } from "@/lib/types/database";

/**
 * The score history (Lucky35's PO, 2026-10-09): for each person, the minus
 * and plus points of a day, a week or a month, with every entry that makes
 * them up underneath — open one for its reason, its note, its task and the
 * proof. Nothing here edits an entry: nothing can. A mistake gets a
 * correction beside it (`tt_correct_score`), offered to Lucky35 and to
 * whoever made the decision. Lucky35 exports what is on screen as CSV —
 * built from the very rows shown, so the two cannot disagree.
 *
 * Every Minus and Plus figure opens the entries it counted (Lucky35,
 * 2026-10-18: "click on the minuses and see what were the missed tasks"), and
 * each minus says, without another click, what it was for: the task and a way
 * to open it, the deadline and when the work was reported done, the
 * reviewer's note.
 */

type Props = {
  /** Every entry the viewer may read (RLS): their own, or everyone's for Lucky35. */
  entries: ScoreEntry[];
  viewer: HistoryViewer;
  /** Whose history is shown; null — Lucky35 only — for everyone. */
  person: string | null;
  /** Who can be chosen: everyone with a history for Lucky35, else the viewer alone. */
  people: { id: string; name: string }[];
  period: Period;
  zone: string;
  /** When the server rendered: "today" is the same day on both sides. */
  renderedAt: string;
};

const KIND_LABEL: Record<PeriodKind, string> = { day: "Day", week: "Week", month: "Month" };
const NOW_LABEL: Record<PeriodKind, string> = { day: "Today", week: "This week", month: "This month" };

export function ScoreHistory({ entries, viewer, person, people, period, zone, renderedAt }: Props) {
  const now = useMemo(() => new Date(renderedAt), [renderedAt]);
  const range = periodRange(period, zone);
  const corrections = useMemo(() => correctionsOf(entries), [entries]);
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? null;
  const shown = person ? [person] : people.map((p) => p.id);
  const totals = totalsFor(entries, range, { people: shown, nameOf });
  const single = totals.length === 1 ? totals[0] : null;
  const label = periodLabel(period);
  // One person's page: their Minus or Plus figure narrows the list to it.
  const [singleSign, setSingleSign] = useState<Sign | null>(null);
  const toggleSingle = (sign: Sign) => setSingleSign((current) => (current === sign ? null : sign));

  const hrefFor = (next: Partial<{ person: string | null; period: Period }>) => {
    const p = next.period ?? period;
    const who = next.person === undefined ? person : next.person;
    const params = new URLSearchParams();
    if (who && viewer.admin) params.set("person", who);
    params.set("period", p.kind);
    params.set("day", p.day);
    return `/scores?${params.toString()}`;
  };
  const previous = shiftPeriod(period, -1);
  const next = shiftPeriod(period, 1);
  const today: Period = { kind: period.kind, day: todayIn(now, zone) };
  const isNow = periodRange(today, zone).start === range.start;

  return (
    <div className="person-view score-history">
      <header className="panel person-view-head">
        <div className="person-view-id">
          <h2 className="person-panel-name" tabIndex={-1}>
            Score history
          </h2>
          <span className="person-handle">
            {viewer.admin
              ? "Every point anyone gained or lost, why, and who decided — kept for good."
              : "Every point you gained or lost, why, and who decided — kept for good."}{" "}
            In {zone}.
          </span>
        </div>
        <nav className="month-nav" aria-label={`Choose a ${period.kind}`}>
          <Link className="btn btn-sm" href={hrefFor({ period: previous })} aria-label={periodLabel(previous)} title={periodLabel(previous)}>
            <ChevronLeft />
          </Link>
          <span className="month-nav-label" aria-current="page">
            {label}
          </span>
          {hasBegun(next, now, zone) ? (
            <Link className="btn btn-sm" href={hrefFor({ period: next })} aria-label={periodLabel(next)} title={periodLabel(next)}>
              <ChevronRight />
            </Link>
          ) : (
            <button className="btn btn-sm" disabled aria-label="Nothing later yet">
              <ChevronRight />
            </button>
          )}
          {isNow ? null : (
            <Link className="btn btn-sm" href={hrefFor({ period: today })}>
              {NOW_LABEL[period.kind]}
            </Link>
          )}
        </nav>
      </header>

      <div className="panel score-controls">
        <div className="score-kinds" role="group" aria-label="Count by">
          {PERIOD_KINDS.map((kind) => (
            <Link
              key={kind}
              className="score-kind"
              data-on={kind === period.kind}
              aria-current={kind === period.kind ? "true" : undefined}
              href={hrefFor({ period: asKind(period, kind) })}
            >
              {KIND_LABEL[kind]}
            </Link>
          ))}
        </div>
        {viewer.admin ? <PersonPicker people={people} person={person} hrefFor={hrefFor} /> : null}
        {viewer.admin ? <ExportButtons totals={totals} period={period} zone={zone} who={single?.name ?? null} corrections={corrections} /> : null}
      </div>

      {single ? (
        <div className="figures score-figs">
          <button
            className="figure figure-btn"
            onClick={() => toggleSingle("minus")}
            disabled={single.minusCount === 0}
            aria-pressed={singleSign === "minus"}
            title={single.minusCount === 0 ? "Nothing lost in this period" : "Show only what cost points"}
          >
            <span className={`v ${single.minus < 0 ? "attention" : ""}`}>{formatPoints(single.minus)}</span>
            <span className="k">Minus · {single.minusCount}</span>
          </button>
          <button
            className="figure figure-btn"
            onClick={() => toggleSingle("plus")}
            disabled={single.plusCount === 0}
            aria-pressed={singleSign === "plus"}
            title={single.plusCount === 0 ? "Nothing gained in this period" : "Show only what earned points"}
          >
            <span className="v">{formatPoints(single.plus)}</span>
            <span className="k">Plus · {single.plusCount}</span>
          </button>
          <div className="figure">
            <span className={`v ${single.score < 0 ? "attention" : ""}`}>{formatPoints(single.score)}</span>
            <span className="k">This {period.kind}</span>
          </div>
          <div className="figure">
            <span className={`v ${single.scoreToDate < 0 ? "attention" : ""}`}>{formatPoints(single.scoreToDate)}</span>
            <span className="k">Score to date</span>
          </div>
        </div>
      ) : null}

      {totals.length === 0 ? (
        <section className="panel">
          <p className="empty">No points yet — the first appear when a reviewer approves late, disapproves, or approves {ON_TIME_RUN} on time.</p>
        </section>
      ) : single ? (
        <section className="panel score-person" aria-label={`${single.name}, ${label}`}>
          <p className="sub-title">
            {single.name} <span className="skipped-count">{single.entries.length}</span>
          </p>
          {singleSign ? (
            <SignNote sign={singleSign} count={entriesOfSign(single.entries, singleSign).length} onShowAll={() => setSingleSign(null)} />
          ) : null}
          <EntryList
            entries={singleSign ? entriesOfSign(single.entries, singleSign) : single.entries}
            all={entries}
            corrections={corrections}
            viewer={viewer}
            zone={zone}
          />
        </section>
      ) : (
        <section className="panel score-table" aria-label={`Everyone, ${label}`}>
          <div className="score-row score-head" aria-hidden="true">
            <span />
            <span>Person</span>
            <span>Minus</span>
            <span>Plus</span>
            <span>This {period.kind}</span>
            <span>To date</span>
          </div>
          {totals.map((row) => (
            <PersonRow key={row.person} row={row} all={entries} corrections={corrections} viewer={viewer} zone={zone} href={hrefFor({ person: row.person })} />
          ))}
        </section>
      )}

      <section className="panel scores-rules" aria-label="How the score works">
        <p className="sub-title">How it counts</p>
        <ul>
          <li>
            <b>−1</b> when work is approved late, or disapproved — with the reviewer&apos;s note saying why.
          </li>
          <li>
            <b>+{ON_TIME_BONUS}</b> for every {ON_TIME_RUN} tasks approved on time, counted in total, not in a row; the
            entry lists the {ON_TIME_RUN}.
          </li>
          <li>
            Entries are never edited or removed — not by anyone. A mistake is put right by a <b>correction</b>: a new
            entry of the opposite amount, beside the one it reverses. Undoing a verdict, or dismissing the task, writes
            one by itself.
          </li>
          <li>An entry counts in the {period.kind} it was decided in — a correction in the {period.kind} it was made.</li>
        </ul>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PersonPicker({
  people,
  person,
  hrefFor,
}: {
  people: { id: string; name: string }[];
  person: string | null;
  hrefFor: (next: { person: string | null }) => string;
}) {
  const router = useRouter();
  return (
    <label className="view-field score-person-pick">
      Person
      <select
        className="view-sort"
        value={person ?? ""}
        onChange={(event) => router.push(hrefFor({ person: event.target.value || null }))}
      >
        <option value="">Everyone</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function ExportButtons({
  totals,
  period,
  zone,
  who,
  corrections,
}: {
  totals: PersonTotals[];
  period: Period;
  zone: string;
  who: string | null;
  corrections: ReadonlyMap<string, ScoreEntry>;
}) {
  const save = (kind: "history" | "totals") => {
    const origin = window.location.origin;
    const text =
      kind === "history"
        ? historyCsv(
            totals.flatMap((t) => t.entries),
            { timeZone: zone, taskUrl: (id) => `${origin}/?task=${encodeURIComponent(id)}`, corrections },
          )
        : totalsCsv(totals, period, zone);
    // A byte-order mark, so a spreadsheet reads Vietnamese names as UTF-8.
    const blob = new Blob(["﻿", text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = csvFileName(kind, who ?? "everyone", period);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="score-export" role="group" aria-label="Export as CSV">
      <button className="btn btn-sm" onClick={() => save("history")} title="Every entry shown, one line each">
        <Download /> History CSV
      </button>
      <button className="btn btn-sm" onClick={() => save("totals")} title="The totals shown, one line per person">
        <Download /> Totals CSV
      </button>
    </div>
  );
}

function PersonRow({
  row,
  all,
  corrections,
  viewer,
  zone,
  href,
}: {
  row: PersonTotals;
  all: ScoreEntry[];
  corrections: ReadonlyMap<string, ScoreEntry>;
  viewer: HistoryViewer;
  zone: string;
  href: string;
}) {
  // What is open under the row: everything (the arrow), or one side of it
  // (the Minus or the Plus figure).
  const [open, setOpen] = useState<"all" | Sign | null>(null);
  const toggle = (what: "all" | Sign) => setOpen((current) => (current === what ? null : what));
  const listed = open === "minus" || open === "plus" ? entriesOfSign(row.entries, open) : row.entries;
  return (
    <div className="score-person-row" data-open={open !== null}>
      <div className="score-row">
        <button
          className="scores-toggle"
          onClick={() => toggle("all")}
          aria-expanded={open !== null}
          disabled={row.entries.length === 0}
          title={row.entries.length === 0 ? "Nothing in this period" : "Show the entries"}
        >
          {open ? <ChevronDown /> : <ChevronRight />}
        </button>
        <span className="scores-name">
          <span className="card-dot" style={{ background: personColor(row.person) }} />
          <Link className="tc-name" href={href} title={`Only ${row.name}`}>
            {row.name}
          </Link>
        </span>
        <button
          className="score-num score-num-btn"
          data-down={row.minus < 0}
          onClick={() => toggle("minus")}
          disabled={row.minusCount === 0}
          aria-pressed={open === "minus"}
          title={row.minusCount === 0 ? "Nothing lost in this period" : `Show only what cost ${row.name} points`}
        >
          {formatPoints(row.minus)} <small>{row.minusCount}</small>
        </button>
        <button
          className="score-num score-num-btn"
          onClick={() => toggle("plus")}
          disabled={row.plusCount === 0}
          aria-pressed={open === "plus"}
          title={row.plusCount === 0 ? "Nothing gained in this period" : `Show only what earned ${row.name} points`}
        >
          {formatPoints(row.plus)} <small>{row.plusCount}</small>
        </button>
        <span className="team-score" data-down={row.score < 0}>
          {formatPoints(row.score)}
        </span>
        <span className="team-score" data-down={row.scoreToDate < 0}>
          {formatPoints(row.scoreToDate)}
        </span>
      </div>
      {open === "minus" || open === "plus" ? <SignNote sign={open} count={listed.length} onShowAll={() => setOpen("all")} /> : null}
      {open ? <EntryList entries={listed} all={all} corrections={corrections} viewer={viewer} zone={zone} /> : null}
    </div>
  );
}

/** Which side the list shows, and the way back to all of it. */
function SignNote({ sign, count, onShowAll }: { sign: Sign; count: number; onShowAll: () => void }) {
  return (
    <p className="detail-hint score-sign-note">
      {sign === "minus" ? `Only what cost points — ${count}.` : `Only what earned points — ${count}.`}{" "}
      <button className="tc-all" onClick={onShowAll}>
        Show everything
      </button>
    </p>
  );
}

/** What the minus lines of a list say without another click: the review, the miss, the task. */
type ListFacts = {
  tasks: Map<string, { id: string; title: string; status: string }>;
  reviews: Map<string, { deadline: string | null; finished_at: string | null }>;
  misses: Map<string, { deadline: string | null }>;
};

function EntryList({
  entries,
  all,
  corrections,
  viewer,
  zone,
}: {
  entries: ScoreEntry[];
  all: ScoreEntry[];
  corrections: ReadonlyMap<string, ScoreEntry>;
  viewer: HistoryViewer;
  zone: string;
}) {
  const [facts, setFacts] = useState<ListFacts | null>(null);

  // The verdicts, misses and tasks behind the minus lines, read once for the
  // list on the viewer's session. Keyed on the ids: the entries array is new
  // on every render.
  const minus = entriesOfSign(entries, "minus");
  const key = minus.map((entry) => entry.id).join(",");
  useEffect(() => {
    if (key === "") return;
    let live = true;
    const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
    const reviewIds = unique(minus.flatMap((entry) => entry.review_ids));
    const missIds = unique(minus.map((entry) => entry.miss_id ?? ""));
    const taskIds = unique(minus.flatMap((entry) => entry.task_ids));
    const db = createSupabaseBrowserClient();
    const none = Promise.resolve({ data: [] as unknown[] });
    Promise.all([
      reviewIds.length ? db.from("tt_task_reviews").select("id, deadline, finished_at").in("id", reviewIds) : none,
      missIds.length ? db.from("tt_deadline_misses").select("id, deadline").in("id", missIds) : none,
      taskIds.length ? db.from("tt_tasks").select("id, title, status").in("id", taskIds) : none,
    ]).then(
      ([reviews, misses, tasks]) => {
        if (!live) return;
        setFacts({
          reviews: new Map(((reviews.data ?? []) as Array<{ id: string; deadline: string | null; finished_at: string | null }>).map((r) => [r.id, r])),
          misses: new Map(((misses.data ?? []) as Array<{ id: string; deadline: string | null }>).map((m) => [m.id, m])),
          tasks: new Map(((tasks.data ?? []) as Array<{ id: string; title: string; status: string }>).map((t) => [t.id, t])),
        });
      },
      () => {
        if (live) setFacts({ reviews: new Map(), misses: new Map(), tasks: new Map() });
      },
    );
    return () => {
      live = false;
    };
    // `minus` follows from the entries `key` names; the key is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (entries.length === 0) return <p className="detail-hint scores-none">Nothing moved in this period.</p>;
  return (
    <ol className="score-entries">
      {[...entries].reverse().map((entry) => (
        <EntryRow key={entry.id} entry={entry} all={all} corrections={corrections} viewer={viewer} zone={zone} facts={facts} />
      ))}
    </ol>
  );
}

export function EntryRow({
  entry,
  all,
  corrections,
  viewer,
  zone,
  facts = null,
}: {
  entry: ScoreEntry;
  all: ScoreEntry[];
  corrections: ReadonlyMap<string, ScoreEntry>;
  viewer: HistoryViewer;
  zone: string;
  /** What the list read about its minus lines; null while it reads, or for a list that read nothing. */
  facts?: ListFacts | null;
}) {
  const [open, setOpen] = useState(false);
  const amount = amountOf(entry);
  const correctedBy = corrections.get(entry.id) ?? null;
  const reverses = entry.corrects ? (all.find((e) => e.id === entry.corrects) ?? null) : null;
  const tasks = entry.task_titles.length === 1 ? entry.task_titles[0] : `${entry.task_titles.length} tasks`;

  return (
    <li className="score-entry" id={`entry-${entry.id}`} data-corrected={Boolean(correctedBy)} data-open={open}>
      <button className="score-entry-line" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="ledger-delta" data-sign={amount < 0 ? "down" : "up"}>
          {formatPoints(amount)}
        </span>
        <span className="ledger-body">
          <span className="ledger-label">
            {reasonLabel(entry)}
            {correctedBy ? <span className="score-corrected"> · corrected</span> : null}
          </span>
          <span className="ledger-task">{tasks}</span>
        </span>
        <span className="ledger-meta score-when" title={formatWhen(entry.decided_at, zone)}>
          {formatWhen(entry.decided_at, zone)}
        </span>
      </button>
      {amount < 0 && facts ? <MinusFacts entry={entry} facts={facts} zone={zone} /> : null}
      {open ? (
        <EntryDetail entry={entry} reverses={reverses} correctedBy={correctedBy} corrections={corrections} viewer={viewer} zone={zone} />
      ) : null}
    </li>
  );
}

type TaskFacts = { id: string; title: string; status: string } | undefined;

export function EntryDetail({
  entry,
  reverses,
  correctedBy,
  corrections,
  viewer,
  zone,
}: {
  entry: ScoreEntry;
  reverses: ScoreEntry | null;
  correctedBy: ScoreEntry | null;
  corrections: ReadonlyMap<string, ScoreEntry>;
  viewer: HistoryViewer;
  zone: string;
}) {
  const [tasks, setTasks] = useState<Map<string, TaskFacts> | null>(null);
  const [proofs, setProofs] = useState<TaskProof[]>([]);

  // The tasks and their proof, read on the viewer's session: RLS lets the
  // person and Lucky35 read the proof behind a point, even of a deleted task.
  useEffect(() => {
    let live = true;
    if (entry.task_ids.length === 0) return;
    const db = createSupabaseBrowserClient();
    Promise.all([
      db.from("tt_tasks").select("id, title, status").in("id", entry.task_ids),
      db.from("tt_task_proofs").select("*").in("task_id", entry.task_ids).order("created_at", { ascending: true }),
    ]).then(
      ([found, proofRows]) => {
        if (!live) return;
        const map = new Map<string, TaskFacts>();
        for (const row of (found.data ?? []) as { id: string; title: string; status: string }[]) map.set(row.id, row);
        setTasks(map);
        setProofs((proofRows.data ?? []) as TaskProof[]);
      },
      () => {
        if (live) setTasks(new Map());
      },
    );
    return () => {
      live = false;
    };
  }, [entry.task_ids]);

  const decider = entry.decided_by_name ?? (entry.decided_by_discord_id ? entry.decided_by_discord_id : "the tracker itself");

  return (
    <div className="score-detail">
      <dl className="score-facts">
        <dt>Reason</dt>
        <dd>{reasonLabel(entry)}</dd>
        {entry.note ? (
          <>
            <dt>Note</dt>
            <dd className="history-note">“{entry.note}”</dd>
          </>
        ) : null}
        <dt>Decided</dt>
        <dd>
          by <b>{decider}</b> · {formatWhen(entry.decided_at, zone)}
        </dd>
        {entry.backfilled ? (
          <>
            <dt>Recorded</dt>
            <dd>written from the records kept before this history began</dd>
          </>
        ) : null}
        {reverses ? (
          <>
            <dt>Reverses</dt>
            <dd>
              <a href={`#entry-${reverses.id}`}>
                {reasonLabel(reverses)} ({formatPoints(amountOf(reverses))}) of {formatWhen(reverses.decided_at, zone)}
              </a>
            </dd>
          </>
        ) : null}
        {correctedBy ? (
          <>
            <dt>Corrected</dt>
            <dd>
              <a href={`#entry-${correctedBy.id}`}>
                {formatPoints(amountOf(correctedBy))} by {correctedBy.decided_by_name ?? "the tracker"} ·{" "}
                {formatWhen(correctedBy.decided_at, zone)}
              </a>
              {correctedBy.note ? <span className="history-note"> “{correctedBy.note}”</span> : null}
            </dd>
          </>
        ) : null}
      </dl>

      <p className="sub-title score-detail-k">{entry.task_ids.length === 1 ? "Task" : `The ${entry.task_ids.length} tasks`}</p>
      <ul className="score-tasks">
        {entry.task_ids.map((id, index) => {
          const found = tasks?.get(id);
          const mine = proofs.filter((proof) => proof.task_id === id);
          return (
            <li key={id}>
              <span className="score-task-title">{found?.title ?? entry.task_titles[index] ?? "A task"}</span>
              {tasks === null ? null : found ? (
                <Link className="tc-all" href={`/?task=${encodeURIComponent(id)}`} title="Open it on the board">
                  Open task <ExternalLink aria-hidden="true" />
                </Link>
              ) : (
                <span className="detail-hint">deleted, or on a board you cannot open</span>
              )}
              {mine.length > 0 ? (
                <div className="score-proofs">
                  {mine.map((proof) => (
                    <ProofItem key={proof.id} proof={proof} />
                  ))}
                </div>
              ) : tasks !== null ? (
                <span className="detail-hint score-no-proof">No proof on it.</span>
              ) : null}
            </li>
          );
        })}
      </ul>

      {canCorrect(entry, corrections, viewer) ? <CorrectForm entry={entry} /> : null}
      <p className="detail-hint score-id">Entry {entry.id}</p>
    </div>
  );
}

function CorrectForm({ entry }: { entry: ScoreEntry }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reversal = -amountOf(entry);

  if (!open) {
    return (
      <button className="btn btn-sm" onClick={() => setOpen(true)} title="Add an entry that reverses this one — both stay listed">
        <Undo2 /> Correct… ({formatPoints(reversal)})
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
        setError(null);
        createSupabaseBrowserClient()
          .rpc("tt_correct_score", { p_entry: entry.id, p_review: null, p_note: note })
          .then(
            ({ error: failed }: { error: { message: string } | null }) => {
              setBusy(false);
              if (failed) {
                setError(failed.message);
                return;
              }
              setOpen(false);
              setNote("");
              router.refresh();
            },
            (caught: unknown) => {
              setBusy(false);
              setError(caught instanceof Error ? caught.message : String(caught));
            },
          );
      }}
    >
      <p className="sub-title">Correct this entry — {formatPoints(reversal)}</p>
      <textarea
        className="note-edit"
        value={note}
        rows={2}
        maxLength={REVIEW_NOTE_MAX}
        autoFocus
        required
        placeholder="Why? Required — e.g. “correction, disapproved by mistake”. Kept with the correction for good."
        aria-label="Why — required"
        onChange={(event) => setNote(event.target.value)}
      />
      <p className="detail-hint">This entry stays as it is. A new one of {formatPoints(reversal)} is added beside it, with your name and this note.</p>
      {error ? <p className="detail-hint review-deadline-warn">{error}</p> : null}
      <div className="row-actions">
        <button className="btn btn-sm btn-primary" type="submit" disabled={!ready || busy}>
          Add the correction
        </button>
        <button className="btn btn-sm" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * What a minus was for, without another click (Lucky35, 2026-10-18): the
 * deadline it was judged on and when the work was reported done, the
 * reviewer's note on a disapproval, and the task — one click away.
 */
function MinusFacts({ entry, facts, zone }: { entry: ScoreEntry; facts: ListFacts; zone: string }) {
  const review = entry.review_ids.map((id) => facts.reviews.get(id)).find(Boolean);
  const miss = entry.miss_id ? facts.misses.get(entry.miss_id) : undefined;
  const late =
    entry.reason === "approved_late"
      ? lateLine(review?.deadline, review?.finished_at, zone)
      : entry.reason === "missed_deadline"
        ? lateLine(miss?.deadline, null, zone)
        : null;
  const note = entry.reason === "disapproved" ? entry.note : null;
  const only = entry.task_ids.length === 1 ? entry.task_ids[0] : null;
  const task = only ? facts.tasks.get(only) : undefined;
  if (!late && !note && !only) return null;
  return (
    <div className="score-entry-facts">
      {late ? <span className="score-late">{late}</span> : null}
      {note ? <span className="history-note">“{note}”</span> : null}
      {only ? (
        task ? (
          <Link className="tc-all" href={`/?task=${encodeURIComponent(only)}`} title="Open it on the board">
            Open task <ExternalLink aria-hidden="true" />
          </Link>
        ) : (
          <span className="detail-hint">deleted, or on a board you cannot open</span>
        )
      ) : null}
    </div>
  );
}
