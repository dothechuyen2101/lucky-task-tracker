"use client";

import Link from "next/link";
import { ArrowLeft, Inbox } from "lucide-react";

import type { LiveState } from "@/components/tracker";
import { useTimeZone } from "@/components/clock";
import { LiveCountdown } from "@/components/countdown";
import { type Viewer, formatWhen, personColor, urgencyOf } from "@/lib/board";
import { initialsFor } from "@/lib/people";
import { relativeTime } from "@/lib/reminders";
import { durationText } from "@/lib/review";
import { stageLabel } from "@/lib/stages";
import { monthBounds, monthOf } from "@/lib/summary";
import { ON_TIME_RUN, RECENT_MISS_DAYS, type TeamMember, formatScore, scoreBreakdown, stageSince, teamOf } from "@/lib/team";
import type { Person, ScoreEntry, Task } from "@/lib/types/database";

/**
 * The team — who is working on what, live.
 *
 * Lucky35, 2026-10-04: Luka could not tell at a glance which dev was on what.
 * One row per person the viewer hands work to (`teamOf`): what they are
 * working on now — In progress or Testing, which the assignee can set
 * themselves — what waits behind it, what they say is finished and waits for
 * review, and their score — the sum of their score history (`tt_score_entries`),
 * shown only to Lucky35: everyone else sees only their own (PO, 2026-10-09).
 *
 * Live because the board is: Supabase Realtime pushes every change into
 * `Tracker`'s state, and this only derives from it. It writes nothing.
 */

type TeamViewProps = {
  tasks: Task[];
  /** The score history the viewer may read (`20261009_01`). */
  scoreEntries: ScoreEntry[];
  /** Lucky35 sees everyone's score; anyone else sees none of other people's — not a misleading 0. */
  scoresVisible: boolean;
  people: Person[];
  viewer: Viewer;
  now: Date;
  live: LiveState;
  nameOf: (key: string) => string;
  avatarOf: (key: string) => string | null;
  onBack: () => void;
  onOpenTask: (id: string) => void;
  onOpenPerson: (key: string) => void;
  /** Open the board on its "To review" lens. */
  onReview: () => void;
};

const LIVE_LABEL: Record<LiveState, string> = {
  live: "Live",
  connecting: "Connecting…",
  off: "Not live — press Refresh",
};

export function TeamView({ tasks, scoreEntries, scoresVisible, people, viewer, now, live, nameOf, avatarOf, onBack, onOpenTask, onOpenPerson, onReview }: TeamViewProps) {
  const zone = useTimeZone();
  const members = teamOf(tasks, people, viewer, now, nameOf, zone, {
    entries: scoresVisible ? scoreEntries : [],
    month: monthBounds(monthOf(now, zone), zone),
  });

  const working = members.filter((m) => m.working.length > 0).length;
  const free = members.filter((m) => m.working.length === 0 && m.queued.length === 0).length;
  const toReview = members.reduce((n, m) => n + m.review.length, 0);
  const lostLately = Math.round(members.reduce((n, m) => n + m.lostLately, 0) * 10) / 10;

  return (
    <div className="person-view team-view">
      <header className="panel person-view-head">
        <button className="btn btn-sm" onClick={onBack} title="Back to the board">
          <ArrowLeft /> Board
        </button>
        <div className="person-view-id">
          <h2 className="person-panel-name" tabIndex={-1}>
            Team
          </h2>
          <span className="person-handle">Who is working on what — it changes here the moment it changes.</span>
        </div>
        <span
          className="status-pill"
          data-on={live === "live"}
          data-error={live === "off"}
          title={
            live === "off"
              ? "The live connection to the database is down; what you see is from the last load."
              : "Changes arrive as they happen."
          }
        >
          {LIVE_LABEL[live]}
        </span>
      </header>

      <div className="person-figs figures team-figs">
        <div className="figure">
          <span className="v">{working}</span>
          <span className="k">Working</span>
        </div>
        <div className="figure">
          <span className="v">{free}</span>
          <span className="k">Free</span>
        </div>
        <div className="figure">
          <span className={`v ${toReview > 0 ? "warn" : ""}`}>{toReview}</span>
          <span className="k">To review</span>
        </div>
        {scoresVisible ? (
          <div className="figure">
            <span className={`v ${lostLately < 0 ? "attention" : ""}`}>{formatScore(lostLately)}</span>
            <span className="k">Lost, {RECENT_MISS_DAYS} days</span>
          </div>
        ) : null}
      </div>

      {members.length === 0 ? (
        <section className="panel">
          <p className="empty">
            Nobody yet. Tag your bot and @-mention who a task is for — everyone you give work to shows here, with what
            they are on.
          </p>
        </section>
      ) : (
        members.map((member) => (
          <MemberRow
            key={member.key}
            member={member}
            name={nameOf(member.key)}
            avatarUrl={avatarOf(member.key)}
            now={now}
            zone={zone}
            scoresVisible={scoresVisible}
            onOpenTask={onOpenTask}
            onOpenPerson={onOpenPerson}
            onReview={onReview}
          />
        ))
      )}

      <p className="detail-hint mine-foot">
        <b>Working</b> means In progress or Testing — set on the rail, or by the person themselves (Start on their My
        tasks, or <code>start</code> in reply to the bot).{" "}
        {scoresVisible ? (
          <>
            The <b>score</b> is each person&apos;s score history added up: approved late −1, disapproved −1, and +0.5
            for every {ON_TIME_RUN} approved on time (counted up, not a streak). Shown for this month and in all; every
            entry, and its corrections, is in <Link href="/scores">Scores</Link>.
          </>
        ) : (
          <>Each person sees their own score in <Link href="/scores">Scores</Link>; only Lucky35 sees everyone&apos;s.</>
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

type MemberRowProps = {
  member: TeamMember;
  name: string;
  avatarUrl: string | null;
  now: Date;
  zone: string;
  scoresVisible: boolean;
  onOpenTask: (id: string) => void;
  onOpenPerson: (key: string) => void;
  onReview: () => void;
};

function MemberRow({ member, name, avatarUrl, now, zone, scoresVisible, onOpenTask, onOpenPerson, onReview }: MemberRowProps) {
  const open = member.working.length + member.queued.length;
  const facts = [
    `${open} open`,
    member.overdue > 0 ? `${member.overdue} overdue` : null,
    member.lastMove ? `last moved ${relativeTime(member.lastMove, now)}` : null,
  ].filter(Boolean);

  return (
    <section className="panel team-member" aria-label={name}>
      <header className="team-head">
        <span className="person-avatar team-avatar" style={{ boxShadow: `0 0 0 3px ${personColor(member.key)}33` }}>
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="" />
          ) : (
            <span className="person-avatar-initials">{initialsFor(name, member.key)}</span>
          )}
        </span>
        <div className="team-id">
          <button className="team-name" onClick={() => onOpenPerson(member.key)} title={`Open ${name}`}>
            {name}
          </button>
          <span className="team-facts">{facts.join(" · ")}</span>
        </div>
        {scoresVisible ? (
          <Link className="team-scores" href={`/scores?person=${encodeURIComponent(member.key)}`} title="Every entry behind these">
            <span className="team-score" data-down={member.month.score < 0} title={`This month: ${scoreBreakdown(member.month)}`}>
              <span className="team-score-k">Month</span>
              {formatScore(member.month.score)}
            </span>
            <span
              className="team-score"
              data-down={member.score < 0}
              title={`In all: ${scoreBreakdown(member.total)} — ${formatScore(member.lostLately)} in the last ${RECENT_MISS_DAYS} days`}
            >
              <span className="team-score-k">All</span>
              {formatScore(member.score)}
            </span>
          </Link>
        ) : null}
      </header>

      {member.working.length > 0 ? (
        <ul className="mine-list">
          {member.working.map((task) => (
            <TeamTask key={task.id} task={task} now={now} zone={zone} onOpenTask={onOpenTask} />
          ))}
        </ul>
      ) : (
        <p className="team-idle">
          {member.queued.length > 0
            ? `Not on anything yet — ${member.queued.length} waiting to start.`
            : "Free — nothing open on them."}
        </p>
      )}

      {member.queued.length > 0 ? (
        <details className="team-queued">
          <summary>
            Up next <span className="skipped-count">{member.queued.length}</span>
          </summary>
          <ul className="mine-list">
            {member.queued.map((task) => (
              <TeamTask key={task.id} task={task} now={now} zone={zone} onOpenTask={onOpenTask} />
            ))}
          </ul>
        </details>
      ) : null}

      {member.review.length > 0 ? (
        <div className="team-review">
          <span>
            {member.review.length === 1
              ? `Says “${member.review[0].title}” is finished`
              : `Says ${member.review.length} tasks are finished`}{" "}
            — waiting for your review
            {/* The longest wait first (`teamOf`): how long the oldest has sat. */}
            {member.review[0].completed_at ? ` for ${durationText(now.getTime() - Date.parse(member.review[0].completed_at))}` : ""}.
          </span>
          <button className="btn btn-sm" onClick={onReview}>
            <Inbox /> Review
          </button>
        </div>
      ) : null}
    </section>
  );
}

function TeamTask({ task, now, zone, onOpenTask }: { task: Task; now: Date; zone: string; onOpenTask: (id: string) => void }) {
  const since = stageSince(task);
  return (
    <li className="mine-item" style={{ ["--task-color" as string]: task.color }}>
      <button className="mine-title" onClick={() => onOpenTask(task.id)} title="Open this task">
        <span className="swatch" />
        <span className="tc-title-text">{task.title}</span>
      </button>
      <span className="mine-meta">
        {stageLabel(task.stage)}
        {since ? ` · since ${relativeTime(since, now)}` : ""}
        {task.review_state === "rejected" ? ` · reopened${task.review_rejections > 1 ? ` ${task.review_rejections}×` : ""}` : ""}
        {task.review_state === "extended" ? " · more time" : ""}
      </span>
      <span className="mine-when">
        {task.deadline ? (
          <span title={`Due ${formatWhen(task.deadline, zone)}`}>
            <LiveCountdown deadline={task.deadline} urgency={urgencyOf(task, now, zone)} now={now} />
          </span>
        ) : (
          <span className="tc-missing">No deadline</span>
        )}
      </span>
    </li>
  );
}
