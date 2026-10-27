import Link from "next/link";
import { redirect } from "next/navigation";

import { Tracker, type TrackerStart } from "@/components/tracker";
import { requireUser } from "@/lib/auth";
import { CLOSED_TASKS_LOADED } from "@/lib/board";
import { MOVED_OFF_DAYS } from "@/lib/handoffs";
import { readScoreAdmin, readScoreEntries } from "@/lib/score-entries";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NOT_FILED_COLUMNS, NOT_FILED_PAGE } from "@/lib/triage";
import type {
  BlockedChannel,
  ConnectionStatus,
  Person,
  Profile,
  SkippedMessage,
  Task,
  TaskHandoff,
  TaskReview,
} from "@/lib/types/database";

// The worker changes this table between requests, so it is never cached.
export const dynamic = "force-dynamic";

function SetupNotice() {
  return (
    <main className="main">
      <div className="page-head">
        <h1 className="mark">
          Task Tracker
          <span>LookUp Media</span>
        </h1>
      </div>
      <div className="notice">
        <strong>Not connected</strong>
        <p style={{ margin: "0 0 8px" }}>
          Supabase credentials are missing. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>, then apply{" "}
          <code>supabase/migrations/</code>.
        </p>
        <p style={{ margin: 0, color: "var(--muted)" }}>
          Local: put them in <code>.env.local</code> (README §3 lists every variable). On Vercel: add them under
          Project Settings → Environment Variables and redeploy.
        </p>
      </div>
    </main>
  );
}

/** PostgREST's row cap on Supabase: a page of open tasks is read this many at a time. */
const PAGE = 1000;

/** The moment this page was rendered — the board's clock starts from it (`TrackerData.renderedAt`). */
function renderTime(): string {
  return new Date().toISOString();
}

/** How far back "Moved off you" reaches. */
function movedOffSince(): string {
  return new Date(Date.now() - MOVED_OFF_DAYS * 86_400_000).toISOString();
}

/** One query-string value, or null. A repeated key is not a thing this page accepts. */
function one(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (!isSupabaseConfigured) return <SetupNotice />;

  // Where the board opens. A reminder DM links to `?task=<id>`, and every DM
  // to an assignee to `?mine` — everything on them; the board keeps the
  // address bar in step so a reload lands on the same view. Read before the
  // sign-in check, so a signed-out click on a link lands there once signed in.
  const params = await searchParams;
  // Scores were a screen of the board; they are their own page now, with a
  // link of their own (`/scores`, PO 2026-10-09). Old links still land.
  if (params.scores !== undefined) redirect("/scores");
  const start: TrackerStart = {
    taskId: one(params.task),
    person: one(params.person),
    tasks: one(params.tasks),
    mine: params.mine !== undefined,
    team: params.team !== undefined,
  };
  const here = new URLSearchParams(
    Object.entries({ task: start.taskId, person: start.person, tasks: start.tasks }).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  ).toString();
  const back = start.mine ? "/?mine" : start.team ? "/?team" : here ? `/?${here}` : "/";

  const user = await requireUser(back);
  const supabase = await createSupabaseServerClient();

  // All eight are RLS-scoped to this user; there is no filter to forget. (The
  // profile query's `.eq("id", …)` is a primary-key lookup, not a tenancy
  // filter — it is not the pattern to copy onto the others.)
  //
  // `tt_tasks` returns the user's own rows AND every row somebody else gave
  // them (`20260928_01_assignee_reads_their_tasks.sql`). The board tells the
  // two apart by `user_id`, and offers no write on the second kind.
  const [
    profileResult,
    connectionResult,
    tasksResult,
    closedResult,
    messagesResult,
    channelsResult,
    peopleResult,
    skippedResult,
    blockedResult,
    scoreResult,
    adminResult,
    reviewResult,
    handoffsResult,
    linkedResult,
    reviewsResult,
    keptResult,
    clickupResult,
  ] = await Promise.all([
    supabase.from("tt_profiles").select("*").eq("id", user.id).single(),
    supabase.from("tt_connection_status").select("*").maybeSingle(),
    // Every open task. Supabase caps a response at 1000 rows and says nothing
    // when it does, so a busy board silently lost the tail of its work —
    // counts included (2026-09-30 audit). Paged until a short page.
    openTasks(supabase),
    supabase
      .from("tt_tasks")
      .select("*")
      .neq("status", "open")
      .order("completed_at", { ascending: false, nullsFirst: false })
      .order("updated_at", { ascending: false })
      .limit(CLOSED_TASKS_LOADED),
    supabase
      .from("tt_messages")
      .select("sent_at", { count: "exact", head: false })
      .order("sent_at", { ascending: false })
      .limit(1),
    supabase
      .from("tt_channels")
      .select("id", { count: "exact", head: true })
      .eq("watching", true),
    // Notes and grades for the people work is handed to. No user filter:
    // the `own people` policy already scopes it, same as tt_tasks above.
    // An empty array is the normal first state, not an error.
    supabase.from("tt_people").select("*"),
    // Tagged messages the tracker read and did not file (thanks, chatter, a
    // question, a command it could not apply, a repeat) — the board's "Not
    // filed" list. NO age limit: a row stays until a person files it or agrees
    // it is not a task. This list is the only trace a misjudged message leaves,
    // so it must never quietly shed rows (Lucky35, 2026-09-29). This is the
    // first page; the board pages back through the rest and searches all of
    // them on the server, so every row stays reachable (2026-09-30).
    supabase
      .from("tt_messages")
      .select(NOT_FILED_COLUMNS, { count: "exact" })
      .not("skip_category", "is", null)
      .eq("is_task", false)
      .is("skip_reviewed_at", null)
      // id breaks ties so "Show older" can page by row (`olderThanFilter`).
      .order("sent_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(NOT_FILED_PAGE),
    // Where the bot could not put ✅ / 👀 on a tag. The board says so, because
    // there a missing reaction does not mean the tag went unread.
    supabase
      .from("tt_channels")
      .select("channel_id, channel_name, guild_id, guild_name, react_error")
      .eq("watching", true)
      .not("react_error", "is", null),
    // The score history this user may read (RLS): their own entries, or
    // everyone's for Lucky35 — the scores on Team, a person and Monthly.
    readScoreEntries(supabase),
    readScoreAdmin(supabase),
    awaitingReview(supabase),
    // Tasks lately taken off this user — RLS serves the ones moved off them
    // (and the ones moved on their own board). My tasks says so.
    supabase
      .from("tt_task_handoffs")
      .select("*")
      .gte("moved_at", movedOffSince())
      .order("moved_at", { ascending: false })
      .limit(PAGE),
    linkedTask(supabase, start.taskId),
    // Every verdict this user can read — the task activity and Undo. Paged:
    // it only ever grows.
    allReviews(supabase),
    // Developers lists somebody else named this user to keep (RLS serves the
    // rows naming them). An error (`20261005_03` not applied) is none.
    supabase.from("tt_dev_editors").select("id", { count: "exact", head: true }).neq("owner_id", user.id),
    // ClickUp tasks this user may read (`20261012_03`): a developer's own, a
    // manager's all. Any is a reason to show Developers. An error is none.
    supabase.from("tt_clickup_tasks").select("id", { count: "exact", head: true }),
  ]);

  const tasksError = tasksResult.error ?? closedResult.error;
  if (tasksError) {
    return (
      <main className="main">
        <div className="page-head">
          <h1 className="mark">
            Task Tracker
            <span>LookUp Media</span>
          </h1>
        </div>
        <div className="notice">
          <strong>Query failed</strong>
          {tasksError.message}
          <p style={{ margin: "8px 0 0", color: "var(--muted)" }}>
            If the tables do not exist yet, apply{" "}
            <code>supabase/migrations/20260902_01_task_tracker_core.sql</code>.
          </p>
        </div>
      </main>
    );
  }

  const profile = profileResult.data as Profile | null;

  if (!profile) {
    return (
      <main className="main">
        <div className="page-head">
          <h1 className="mark">
            Task Tracker
            <span>LookUp Media</span>
          </h1>
        </div>
        <div className="notice">
          <strong>No profile</strong>
          Your account exists but has no profile row, which means the sign-up trigger did not run.
          Sign out and in again, or apply the core migration.
          <p style={{ margin: "10px 0 0" }}>
            <Link href="/settings" className="btn btn-sm">
              Settings
            </Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <Tracker
      start={start}
      data={{
        profile,
        connections: (connectionResult.data as ConnectionStatus | null) ?? null,
        // Work waiting for review is closed AND loaded with the open work, so
        // it is never past the closed tail; so is the task a link names. Each
        // row once.
        tasks: uniqueById([
          ...tasksResult.data,
          ...reviewResult.data,
          ...((closedResult.data ?? []) as Task[]),
          ...linkedResult.data,
        ]),
        closedShown: closedResult.data?.length ?? 0,
        renderedAt: renderTime(),
        people: (peopleResult.data ?? []) as Person[],
        reviews: reviewsResult.data,
        // An error here (`20261009_01` not applied yet) shows no scores
        // rather than taking the board down.
        scoreEntries: scoreResult.data,
        scoreAdmin: adminResult,
        devListsKept: keptResult.error ? 0 : (keptResult.count ?? 0),
        clickupTasks: clickupResult.error ? 0 : (clickupResult.count ?? 0),
        // Empty on an error (`20261004_02` not applied yet).
        handoffs: (handoffsResult.data ?? []) as TaskHandoff[],
        // An error here (the 20260929_01 column not applied yet) leaves the
        // list empty rather than taking the whole board down.
        skipped: (skippedResult.data ?? []) as SkippedMessage[],
        skippedTotal: skippedResult.count ?? skippedResult.data?.length ?? 0,
        reactionBlocked: (blockedResult.data ?? []) as BlockedChannel[],
        watchedChannels: channelsResult.count ?? 0,
        messagesTracked: messagesResult.count ?? 0,
        lastMessageAt: messagesResult.data?.[0]?.sent_at ?? null,
      }}
    />
  );
}

/** Every open task the signed-in user can read, a page at a time. */
async function openTasks(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
): Promise<{ data: Task[]; error: { message: string } | null }> {
  return pagedTasks(supabase, "open");
}

/**
 * Every task waiting for the user's review — closed by its assignee, not yet
 * accepted — however long ago, so it never falls past the closed tail. Empty
 * on an error (`20261004_01` not applied yet) rather than taking the board down.
 */
async function awaitingReview(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
): Promise<{ data: Task[] }> {
  const result = await pagedTasks(supabase, "review");
  return { data: result.error ? [] : result.data };
}

async function pagedTasks(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  which: "open" | "review",
): Promise<{ data: Task[]; error: { message: string } | null }> {
  const rows: Task[] = [];
  for (let from = 0; ; from += PAGE) {
    const base = supabase.from("tt_tasks").select("*");
    const scoped = which === "open" ? base.eq("status", "open") : base.eq("status", "done").eq("review_state", "pending");
    const { data, error } = await scoped
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { data: rows, error };
    rows.push(...((data ?? []) as Task[]));
    if (!data || data.length < PAGE) return { data: rows, error: null };
  }
}

/**
 * The task a `?task=` link names, read on its own, so finished work older than
 * the closed tail — opened from the monthly summary, or an old reminder —
 * still opens on its card. RLS-scoped like the rest; empty on an error or an
 * id that is not one.
 */
async function linkedTask(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  id: string | null,
): Promise<{ data: Task[] }> {
  if (!id) return { data: [] };
  const { data, error } = await supabase.from("tt_tasks").select("*").eq("id", id).maybeSingle();
  return { data: error || !data ? [] : [data as Task] };
}

/**
 * Every review verdict this user can read, a page at a time (`20261007_01`).
 * Empty on any error (the migration not applied yet).
 */
async function allReviews(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
): Promise<{ data: TaskReview[] }> {
  const rows: TaskReview[] = [];
  for (let from = 0; ; from += PAGE) {
    // Every verdict this user can read (RLS): on their own board, and about
    // them or by them on another board — verdicts they gave as the person
    // who asked, which they may take back.
    const { data, error } = await supabase
      .from("tt_task_reviews")
      .select("*")
      .order("decided_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { data: [] };
    rows.push(...((data ?? []) as TaskReview[]));
    if (!data || data.length < PAGE) return { data: rows };
  }
}

function uniqueById(tasks: Task[]): Task[] {
  const seen = new Set<string>();
  return tasks.filter((task) => (seen.has(task.id) ? false : (seen.add(task.id), true)));
}
