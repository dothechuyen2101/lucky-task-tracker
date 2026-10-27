import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft, ChevronRight, Inbox, Laptop, LayoutGrid, Settings } from "lucide-react";

import { CopySummary } from "@/components/copy-summary";
import { requireUser } from "@/lib/auth";
import { type Viewer, formatWhen, originOf } from "@/lib/board";
import { displayNameFor } from "@/lib/people";
import { durationText } from "@/lib/review";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  type SummaryGroup,
  compareMonths,
  dayLabel,
  monthBounds,
  monthLabel,
  monthOf,
  monthParam,
  parseMonth,
  shiftMonth,
  summarize,
  summaryText,
  timingOf,
} from "@/lib/summary";
import { tallyFor } from "@/lib/score-history";
import { readScoreAdmin, readScoreEntries } from "@/lib/score-entries";
import { formatScore, scoreBreakdown } from "@/lib/team";
import type { Person, Profile, Task } from "@/lib/types/database";

/**
 * The monthly summary — what was finished in one month, any month (Cenri,
 * 2026-10-05).
 *
 * Its own page rather than a screen of the board, because the board loads
 * only the most recently closed work (`CLOSED_TASKS_LOADED`) and a month of
 * last year is long past that. This reads exactly the month asked for, in the
 * person's own zone, through RLS like the board: their own rows and the ones
 * given to them. Every rule it applies is in `lib/summary.ts`.
 *
 * It writes nothing. A title opens the task on the board (`/?task=`), which
 * loads that row even when it is older than the closed tail.
 */

// The worker closes tasks between requests; this month's list is never cached.
export const dynamic = "force-dynamic";

/** PostgREST's row cap on Supabase: a month is read this many at a time. */
const PAGE = 1000;

/** The moment of this request — which month "this month" is. */
function requestTime(): Date {
  return new Date();
}

type Supabase = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export default async function SummaryPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (!isSupabaseConfigured) redirect("/");

  const params = await searchParams;
  const asked = typeof params.month === "string" ? params.month : null;
  const user = await requireUser(asked ? `/summary?month=${encodeURIComponent(asked)}` : "/summary");
  const supabase = await createSupabaseServerClient();

  const { data: profileRow } = await supabase.from("tt_profiles").select("*").eq("id", user.id).maybeSingle();
  // No profile: the board says why, and what to do about it.
  if (!profileRow) redirect("/");
  const profile = profileRow as Profile;
  const zone = profile.timezone || "UTC";
  const viewer: Viewer = { ownerId: profile.id, selfId: (profile.discord_user_id ?? "").trim() };

  const now = requestTime();
  const month = parseMonth(asked, now, zone);
  const bounds = monthBounds(month, zone);
  const current = monthOf(now, zone);
  const isCurrent = compareMonths(month, current) === 0;
  const label = monthLabel(month);
  const previous = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);

  const [finishedResult, peopleResult, addedResult, stillOpenResult, scoreResult, admin] = await Promise.all([
    finishedIn(supabase, bounds),
    supabase.from("tt_people").select("*"),
    // Work that came in this month — dismissed rows were never work.
    supabase
      .from("tt_tasks")
      .select("id", { count: "exact", head: true })
      .neq("status", "dismissed")
      .gte("created_at", bounds.start)
      .lt("created_at", bounds.end),
    supabase
      .from("tt_tasks")
      .select("id", { count: "exact", head: true })
      .eq("status", "open")
      .gte("created_at", bounds.start)
      .lt("created_at", bounds.end),
    // The score history this user may read (RLS): their own, everyone's for
    // Lucky35 (`20261009_01`). Empty on an error rather than no page.
    readScoreEntries(supabase),
    readScoreAdmin(supabase),
  ]);

  const people = (peopleResult.data ?? []) as Person[];
  const summary = summarize(finishedResult.data, viewer, bounds);
  const entries = scoreResult.data;

  /**
   * The month's score of a person the viewer gave work to — their history's
   * entries decided this month. Only where the viewer may read that history
   * (Lucky35, or their own): anyone else's would read as a clean 0.
   */
  function scoreOfGroup(group: SummaryGroup): number | null {
    if (group.who !== "person" || !(admin || group.key === viewer.selfId)) return null;
    return tallyFor(entries, group.key, bounds).score;
  }

  function nameOf(group: SummaryGroup): string {
    if (group.who === "you") return "You";
    if (group.who === "nobody") return "Not given to anyone";
    const row = people.find((person) => person.discord_user_id === group.key) ?? null;
    const named = group.tasks.find((task) => task.assignee_name?.trim()) ?? null;
    return displayNameFor(row, named, group.key);
  }

  // Pasted somewhere else, "You" would mean the reader.
  const text = summaryText(summary, month, {
    timeZone: zone,
    nameOf: (group) => (group.who === "you" ? (profile.discord_username ?? "Me") : nameOf(group)),
    scoreOf: (group) => {
      const score = scoreOfGroup(group);
      return score === null ? null : formatScore(score);
    },
  });

  return (
    <main className="main">
      <div className="page-head">
        <h1 className="mark">
          Task Tracker
          <span>{profile.discord_username ?? "LookUp Media"}</span>
        </h1>
        <div className="head-actions">
          <Link className="btn btn-sm" href="/">
            <LayoutGrid /> Board
          </Link>
          <Link className="btn btn-sm" href="/?mine">
            <Inbox /> My tasks
          </Link>
          <Link className="btn btn-sm" href="/developers">
            <Laptop /> Developers
          </Link>
          <Link className="btn btn-sm" href="/settings">
            <Settings /> Settings
          </Link>
        </div>
      </div>

      <div className="person-view summary-view">
        <header className="panel person-view-head">
          <div className="person-view-id">
            <h2 className="person-panel-name">Monthly summary</h2>
            <span className="person-handle">
              What was finished in {label} — on your board, and given to you. In {zone}.
            </span>
          </div>
          <nav className="month-nav" aria-label="Choose a month">
            <Link className="btn btn-sm" href={`/summary?month=${monthParam(previous)}`} aria-label={monthLabel(previous)} title={monthLabel(previous)}>
              <ChevronLeft />
            </Link>
            <span className="month-nav-label" aria-current="page">
              {label}
            </span>
            {isCurrent ? (
              <button className="btn btn-sm" disabled aria-label="No later month yet">
                <ChevronRight />
              </button>
            ) : (
              <Link className="btn btn-sm" href={`/summary?month=${monthParam(next)}`} aria-label={monthLabel(next)} title={monthLabel(next)}>
                <ChevronRight />
              </Link>
            )}
            {isCurrent ? null : (
              <Link className="btn btn-sm" href="/summary">
                This month
              </Link>
            )}
            <CopySummary text={text} />
          </nav>
        </header>

        {finishedResult.error ? (
          <div className="notice">
            <strong>Query failed</strong>
            {finishedResult.error.message}
          </div>
        ) : null}

        <div className="figures summary-figs">
          <div className="figure">
            <span className="v">{summary.finished}</span>
            <span className="k">Finished</span>
          </div>
          <div className="figure">
            <span className="v">{summary.onTime}</span>
            <span className="k">On time</span>
          </div>
          <div className="figure">
            <span className={`v ${summary.late > 0 ? "attention" : ""}`}>{summary.late}</span>
            <span className="k">Late</span>
          </div>
          <div className="figure">
            <span className="v">{addedResult.count ?? "–"}</span>
            <span className="k">Added</span>
          </div>
          <div className="figure">
            <span className="v">{stillOpenResult.count ?? "–"}</span>
            <span className="k">Still open</span>
          </div>
        </div>

        {summary.groups.length === 0 ? (
          <section className="panel">
            <p className="empty">
              {isCurrent
                ? `Nothing finished yet in ${label}. Mark a task done on the board and it is counted here.`
                : `Nothing was finished in ${label}.`}
            </p>
          </section>
        ) : (
          summary.groups.map((group) => (
            <section className="panel mine-group" key={`${group.who}:${group.key}`} aria-label={nameOf(group)}>
              <p className="sub-title summary-group-head">
                <span>
                  {nameOf(group)} <span className="skipped-count">{group.tasks.length}</span>
                </span>
                {scoreOfGroup(group) !== null ? (
                  <Link
                    href={`/scores?person=${encodeURIComponent(group.key)}&period=month&day=${monthParam(month)}-01`}
                    className="team-score"
                    data-down={(scoreOfGroup(group) ?? 0) < 0}
                    title={scoreBreakdown(tallyFor(entries, group.key, bounds))}
                  >
                    <span className="team-score-k">Score</span>
                    {formatScore(scoreOfGroup(group) ?? 0)}
                  </Link>
                ) : null}
              </p>
              <ul className="mine-list">
                {group.tasks.map((task) => (
                  <SummaryRow key={task.id} task={task} group={group} viewer={viewer} zone={zone} />
                ))}
              </ul>
            </section>
          ))
        )}

        <p className="detail-hint mine-foot">
          A task counts in the month it was marked done, by your calendar. <b>Late</b> means it was finished after its
          deadline; work its assignee marked finished is counted at once, and says when it still waits for review.{" "}
          <b>Added</b> is the work that came in that month, dismissed messages aside, and <b>Still open</b> how much
          of it is not finished yet. Each person&apos;s <b>score</b> for the month adds up the entries of their score
          history decided in it — open it for every one of them. <b>Copy as text</b> gives the list ready to paste into
          Discord.
        </p>
      </div>
    </main>
  );
}

function SummaryRow({ task, group, viewer, zone }: { task: Task; group: SummaryGroup; viewer: Viewer; zone: string }) {
  const timing = timingOf(task);
  const facts: ReactNode[] = [];
  // Where the viewer's own work came from; everyone else's is the viewer's.
  if (group.who === "you") facts.push(originOf(task, viewer));
  facts.push(
    timing.kind === "late" ? (
      <span className="summary-late">late by {durationText(timing.byMs)}</span>
    ) : timing.kind === "on_time" ? (
      "on time"
    ) : (
      "no deadline"
    ),
  );
  if (task.review_state === "pending") {
    facts.push(
      <span className="summary-review">
        {task.user_id === viewer.ownerId ? "waiting for your review" : `waiting for ${task.owner_name ?? "the giver"}'s review`}
      </span>,
    );
  }

  return (
    <li className="mine-item summary-item" style={{ ["--task-color" as string]: task.color }}>
      <Link className="mine-title" href={`/?task=${encodeURIComponent(task.id)}`} title="Open this task on the board">
        <span className="swatch" />
        <span className="tc-title-text">{task.title}</span>
      </Link>
      <span className="mine-meta">
        {facts.map((fact, index) => (
          <span key={index}>
            {index > 0 ? " · " : ""}
            {fact}
          </span>
        ))}
      </span>
      <span className="summary-day" title={`Finished ${formatWhen(task.completed_at, zone)}`}>
        {dayLabel(task.completed_at ?? "", zone)}
      </span>
    </li>
  );
}

/** Every task finished in the month that the user can read, a page at a time. */
async function finishedIn(
  supabase: Supabase,
  bounds: { start: string; end: string },
): Promise<{ data: Task[]; error: { message: string } | null }> {
  const rows: Task[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("tt_tasks")
      .select("*")
      .eq("status", "done")
      .gte("completed_at", bounds.start)
      .lt("completed_at", bounds.end)
      .order("completed_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { data: rows, error };
    rows.push(...((data ?? []) as Task[]));
    if (!data || data.length < PAGE) return { data: rows, error: null };
  }
}
