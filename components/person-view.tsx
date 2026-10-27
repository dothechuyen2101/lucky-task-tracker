"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, LayoutGrid, User } from "lucide-react";

import { useTimeZone } from "@/components/clock";
import { LiveCountdown } from "@/components/countdown";
import { MessagePerson } from "@/components/message-person";
import { type Viewer, formatWhen, isShared, originLine, personColor, sortForCard, urgencyOf } from "@/lib/board";
import { completionHistory, initialsFor, overdueCount } from "@/lib/people";
import { relativeTime } from "@/lib/reminders";
import { closedLabel } from "@/lib/review";
import { amountOf, chronological, reasonLabel, tallyFor } from "@/lib/score-history";
import { monthBounds, monthOf } from "@/lib/summary";
import { formatScore, scoreBreakdown } from "@/lib/team";
import type { Person, ScoreEntry, Task } from "@/lib/types/database";

/**
 * A person, opened from their name on a card.
 *
 * Deliberately a shell for now: who they are (name and Discord handle), what
 * they have open, what they have finished, and a way to message them. The
 * notes and the 1–5 grade that already existed on the old profile panel are
 * kept — they work, and nothing that works is being taken away — but they sit
 * last and folded. The machine's side of performance is the score beside them:
 * their score history added up, its latest entries listed — every one, and
 * its corrections, on the history page (PO, 2026-10-09). Shown to Lucky35, and
 * to the person themselves; nobody else. The grade stays the owner's alone.
 *
 * It derives nothing and writes nothing: counts come from `lib/people.ts`, the
 * task list from `lib/board.ts`, and notes and grade are raised to `Tracker`.
 */

type PersonViewProps = {
  personKey: string;
  name: string;
  /** "@username" when any task carries one; null when only the id is known. */
  handle: string | null;
  isSelf: boolean;
  avatarUrl: string | null;
  /** The owner's own notes-and-grade row, or null — the normal first state. */
  person: Person | null;
  /** Everything this person was given, from `tasksOfPerson`. */
  tasks: Task[];
  /** The score history the viewer may read (`20261009_01`); this person's are picked out. */
  scoreEntries: ScoreEntry[];
  /** Whether the viewer may see this person's score: Lucky35, or it is their own. */
  scoresVisible: boolean;
  viewer: Viewer;
  now: Date;
  busy: boolean;
  onBack: () => void;
  onOpenTask: (id: string) => void;
  onOpenAllTasks: () => void;
  onNotes: (notes: string) => void;
  onGrade: (grade: number | null) => void;
};

const GRADES = [1, 2, 3, 4, 5] as const;

export function PersonView({ personKey, name, handle, isSelf, avatarUrl, person, tasks, scoreEntries, scoresVisible, viewer, now, busy, onBack, onOpenTask, onOpenAllTasks, onNotes, onGrade }: PersonViewProps) {
  const zone = useTimeZone();
  const open = sortForCard(
    tasks.filter((task) => task.status === "open"),
    now,
    zone,
  );
  const finished = tasks
    .filter((task) => task.status === "done")
    .sort((a, b) => Date.parse(b.completed_at ?? b.updated_at) - Date.parse(a.completed_at ?? a.updated_at));
  // `lib/people.ts` counts only work the viewer handed out, which is exactly
  // right for anybody else. For the viewer's own page the list above is the
  // count.
  const overdue = isSelf
    ? open.filter((task) => urgencyOf(task, now, zone) === "overdue").length
    : overdueCount(tasks, personKey, now);
  const history = isSelf ? [] : completionHistory(tasks, personKey);
  // Their history added up: this month, by the viewer's calendar, and in all.
  const theirs = scoresVisible ? chronological(scoreEntries.filter((e) => e.person_discord_id === personKey)) : [];
  const total = tallyFor(theirs, personKey);
  const month = tallyFor(theirs, personKey, monthBounds(monthOf(now, zone), zone));
  const disapproved = tasks.reduce((n, task) => n + task.review_rejections, 0);

  return (
    <div className="person-view" style={{ opacity: busy ? 0.85 : 1 }}>
      <header className="panel person-view-head">
        <button className="btn btn-sm" onClick={onBack} title="Back to the board">
          <ArrowLeft /> Back
        </button>

        <span className="person-avatar" style={{ boxShadow: `0 0 0 3px ${personColor(personKey)}33` }}>
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="" />
          ) : (
            <span className="person-avatar-initials">{initialsFor(name, personKey)}</span>
          )}
        </span>

        <div className="person-view-id">
          <h2 className="person-panel-name" tabIndex={-1}>
            {name}
          </h2>
          <span className="person-handle">{handle ?? `Discord id ${personKey}`}</span>
        </div>

        <button className="btn btn-sm" onClick={onOpenAllTasks} title={`Everything given to ${name}, as cards`}>
          <LayoutGrid /> All tasks
        </button>
      </header>

      <div className="person-figs figures">
        <div className="figure">
          <span className="v">{open.length}</span>
          <span className="k">Open</span>
        </div>
        <div className="figure">
          <span className={`v ${overdue > 0 ? "attention" : ""}`}>{overdue}</span>
          <span className="k">Overdue</span>
        </div>
        <div className="figure">
          <span className="v">{finished.length}</span>
          <span className="k">Finished</span>
        </div>
        {scoresVisible ? (
          <>
            <div className="figure" title={scoreBreakdown(month)}>
              <span className={`v ${month.score < 0 ? "attention" : ""}`}>{formatScore(month.score)}</span>
              <span className="k">Score, this month</span>
            </div>
            <div className="figure" title={scoreBreakdown(total)}>
              <span className={`v ${total.score < 0 ? "attention" : ""}`}>{formatScore(total.score)}</span>
              <span className="k">Score, in all</span>
            </div>
          </>
        ) : null}
        {!isSelf ? (
          <div className="figure">
            <span className="v">{disapproved}</span>
            <span className="k">Disapproved</span>
          </div>
        ) : null}
      </div>

      <div className="person-view-grid">
        <section className="panel">
          <p className="sub-title">Open</p>
          {open.length > 0 ? (
            <div className="mini-grid">
              {open.map((task) => (
                <MiniCard key={task.id} task={task} viewer={viewer} now={now} onOpen={onOpenTask} />
              ))}
            </div>
          ) : (
            <p className="empty">Nothing open on {isSelf ? "you" : name}.</p>
          )}
        </section>

        <section className="panel">
          <p className="sub-title">Finished</p>
          {finished.length > 0 ? (
            <div className="mini-grid">
              {finished.map((task) => (
                <MiniCard key={task.id} task={task} viewer={viewer} now={now} onOpen={onOpenTask} />
              ))}
            </div>
          ) : (
            <p className="empty">Nothing finished yet. When a task is marked done it lands here.</p>
          )}
        </section>
      </div>

      {scoresVisible ? <LatestPoints name={isSelf ? "you" : name} personKey={personKey} entries={theirs} /> : null}

      {!isSelf ? (
        <section className="panel">
          <MessagePerson personKey={personKey} name={name} />
        </section>
      ) : null}

      {!isSelf ? (
        <NotesAndGrade person={person} historyCount={history.length} onNotes={onNotes} onGrade={onGrade} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * The owner's private notes and hand-set grade for a person — carried over from
 * the old profile panel unchanged in behaviour. Folded by default: this page is
 * about the work, and the judgement is a later piece.
 *
 * The grade is set by a human and by nothing else, which the database enforces
 * with the CHECK constraint on `tt_people.grade`.
 */
function NotesAndGrade({ person, historyCount, onNotes, onGrade }: { person: Person | null; historyCount: number; onNotes: (notes: string) => void; onGrade: (grade: number | null) => void }) {
  const grade = person?.grade ?? null;

  // Local while typed, flushed on blur; the server copy is followed during
  // render so a reconciled row does not leave the old text on screen.
  const saved = person?.notes ?? "";
  const [notes, setNotes] = useState(saved);
  const [seenNotes, setSeenNotes] = useState(saved);
  if (seenNotes !== saved) {
    setSeenNotes(saved);
    setNotes(saved);
  }

  return (
    <details className="panel person-private">
      <summary>
        <User /> Your notes and grade{grade !== null ? ` · ${grade}/5` : ""}
      </summary>

      <div className="person-private-body">
        <section className="person-grade">
          <p className="sub-title">Grade</p>
          <div className="person-grade-scale">
            {GRADES.map((value) => (
              <button
                key={value}
                className="person-grade-pip"
                data-on={grade === value}
                aria-pressed={grade === value}
                aria-label={`Grade ${value} of 5`}
                onClick={() => onGrade(value)}
              >
                {value}
              </button>
            ))}
            <button
              className="person-grade-clear"
              onClick={() => onGrade(null)}
              disabled={grade === null}
              title={grade === null ? "Not graded yet" : "Clear the grade"}
            >
              Clear
            </button>
          </div>
          <p className="person-hint">
            You set this. Nothing in the tracker ever writes it. {historyCount} finished for you so far.
          </p>
        </section>

        <section className="person-notes">
          <p className="sub-title">Notes</p>
          <textarea
            className="note-edit"
            value={notes}
            placeholder="Anything you want to remember about working with them…"
            onChange={(event) => setNotes(event.target.value)}
            onBlur={() => {
              if (notes !== saved) onNotes(notes);
            }}
          />
        </section>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------

/** How many of a person's newest entries this page lists; the rest are a click away. */
const LATEST_SHOWN = 5;

/**
 * The newest entries of a person's score history, and the way to all of them
 * (`/scores`). Nothing here changes an entry — nothing can; a mistake is
 * corrected on the history, beside the entry.
 */
function LatestPoints({ name, personKey, entries }: { name: string; personKey: string; entries: ScoreEntry[] }) {
  const zone = useTimeZone();
  const latest = [...entries].reverse().slice(0, LATEST_SHOWN);
  return (
    <section className="panel person-misses">
      <p className="sub-title">
        Score history <span className="skipped-count">{entries.length}</span>
      </p>
      {latest.length === 0 ? (
        <p className="empty">
          No points yet for {name}. They come from reviews: −1 for work approved late or disapproved, +0.5 for every 5
          approved on time.
        </p>
      ) : (
        <ul className="mine-list">
          {latest.map((entry) => (
            <li className="mine-item miss-item" key={entry.id}>
              <span className="mine-title">
                <span className="tc-title-text">
                  {entry.task_titles.length === 1 ? entry.task_titles[0] : `${entry.task_titles.length} tasks`}
                </span>
              </span>
              <span className="mine-meta">
                {reasonLabel(entry)} · {formatWhen(entry.decided_at, zone)}
                {entry.decided_by_name ? ` · ${entry.decided_by_name}` : ""}
              </span>
              <span className="mine-when">
                <span className="miss-cost" data-up={amountOf(entry) > 0}>
                  {formatScore(amountOf(entry))}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Link className="tc-all" href={`/scores?person=${encodeURIComponent(personKey)}`}>
        Every entry, by day, week or month →
      </Link>
    </section>
  );
}

// ---------------------------------------------------------------------------

type PersonTasksProps = {
  personKey: string;
  name: string;
  isSelf: boolean;
  tasks: Task[];
  viewer: Viewer;
  now: Date;
  onBack: () => void;
  onOpenPerson: () => void;
  onOpenTask: (id: string) => void;
};

/** Everything one person was given, as smaller cards: open first, then closed. */
export function PersonTasks({ personKey, name, isSelf, tasks, viewer, now, onBack, onOpenPerson, onOpenTask }: PersonTasksProps) {
  const zone = useTimeZone();
  const ordered = sortForCard(tasks, now, zone);
  const openCount = tasks.filter((task) => task.status === "open").length;

  return (
    <div className="person-view">
      <header className="panel person-view-head">
        <button className="btn btn-sm" onClick={onBack} title="Back to the board">
          <ArrowLeft /> Back
        </button>
        <span className="card-dot" style={{ background: personColor(personKey) }} />
        <div className="person-view-id">
          <h2 className="person-panel-name" tabIndex={-1}>
            {isSelf ? "Everything on you" : `Everything given to ${name}`}
          </h2>
          <span className="person-handle">
            {openCount} open of {tasks.length}
          </span>
        </div>
        <button className="btn btn-sm" onClick={onOpenPerson} title={`Open ${name}`}>
          <User /> {isSelf ? "You" : name}
        </button>
      </header>

      <section className="panel">
        {ordered.length > 0 ? (
          <div className="mini-grid wide">
            {ordered.map((task) => (
              <MiniCard key={task.id} task={task} viewer={viewer} now={now} onOpen={onOpenTask} />
            ))}
          </div>
        ) : (
          <p className="empty">
            Nothing yet. Tag your bot and @-mention {isSelf ? "yourself" : name} in the same message, and it lands here.
          </p>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** A small card: what it is and when it is due. Pressing it opens the task on the board. */
function MiniCard({ task, viewer, now, onOpen }: { task: Task; viewer: Viewer; now: Date; onOpen: (id: string) => void }) {
  const zone = useTimeZone();
  const closed = task.status !== "open";

  return (
    <button
      className="mini-card"
      data-closed={closed}
      onClick={() => onOpen(task.id)}
      title="Open this task on the board"
      style={{ ["--task-color" as string]: task.color }}
    >
      <span className="mini-title">
        <span className="swatch" />
        <span className="tc-title-text">{task.title}</span>
      </span>
      <span className="mini-when">
        {closed ? (
          <span className="tc-status" data-review={task.review_state === "pending"}>
            {closedLabel(task, isShared(task, viewer), "them")}
            {task.completed_at ? ` ${relativeTime(task.completed_at, now)}` : ""}
          </span>
        ) : task.deadline ? (
          <LiveCountdown deadline={task.deadline} urgency={urgencyOf(task, now, zone)} now={now} />
        ) : (
          <span className="tc-missing">No deadline</span>
        )}
        {isShared(task, viewer) ? <span className="tc-origin">{originLine(task, viewer)}</span> : null}
      </span>
    </button>
  );
}
