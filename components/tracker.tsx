"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import {
  CalendarDays,
  Check,
  ExternalLink,
  Inbox,
  Laptop,
  LayoutGrid,
  MessageCircleQuestion,
  Plus,
  RotateCw,
  Settings,
  Trophy,
  Users,
} from "lucide-react";

import { AskPanel } from "@/components/ask-panel";
import { TimeZoneContext } from "@/components/clock";
import { MyTasks } from "@/components/my-tasks";
import { PersonTasks, PersonView } from "@/components/person-view";
import type { RemindResult } from "@/components/remind-now";
import { TaskDetail } from "@/components/task-detail";
import { TaskTrack } from "@/components/task-track";
import { TeamView } from "@/components/team-view";
import { type AssigneeAction, assigneeActionChanges } from "@/lib/assignee";
import {
  BOARD_FILTERS,
  type BoardView,
  CLOSED_TASKS_LOADED,
  DEFAULT_VIEW,
  PRIORITIES,
  SORT_OPTIONS,
  type BoardFilter,
  type Viewer,
  boardFigures,
  canReview,
  filterTasks,
  isPriority,
  parseView,
  viewIsDefault,
  focusAfterRemoval,
  isShared,
  knownPeople,
  nextDeadlineAfter,
  personKeyOf,
  resolveFocus,
  tasksOfPerson,
  toReview,
} from "@/lib/board";
import { colorForKey } from "@/lib/colors";
import { detectBrowserTimeZone } from "@/lib/deadlines";
import { botInviteUrl } from "@/lib/discord-links";
import { displayNameFor } from "@/lib/people";
import { nextAlertFor, relativeTime } from "@/lib/reminders";
import { stripMentions } from "@/lib/relevance";
import {
  PENDING_STAGE,
  type ReviewInput,
  awaitsReview,
  finishedByAssignee,
  reviewChanges,
  reviewedWork,
  settledByReview,
  undoChanges,
} from "@/lib/review";
import type { ProofDraft } from "@/components/proof-form";
import { DONE_FROM_STAGE, IN_PROGRESS_STAGE, isDoneStage, stampStages } from "@/lib/stages";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  NOT_FILED_COLUMNS,
  NOT_FILED_PAGE,
  SKIP_LABELS,
  likeContains,
  olderThanFilter,
  placeOf,
  taskFromMessage,
} from "@/lib/triage";
import { dropHandedOff } from "@/lib/handoffs";
import { cardsForEveryone, siblingsOf } from "@/lib/tagged";
import { dropLive, mergeLive } from "@/lib/team";
import type { Person, ScoreEntry, SkippedMessage, Task, TaskHandoff, TrackerData, TaskReview, Priority } from "@/lib/types/database";

/**
 * What the page is showing: the board — the track of cards and the task in
 * focus beside it — or one person, or everything one person was given, or the
 * team: who is working on what.
 */
type Screen =
  | { kind: "board" }
  | { kind: "mine" }
  | { kind: "team" }
  | { kind: "person"; key: string }
  | { kind: "tasks"; key: string };

/** Where the page opens, from `?task=`, `?person=`, `?tasks=`, `?mine` or `?team` — a reminder DM links to `?task=`. */
export type TrackerStart = {
  taskId: string | null;
  person: string | null;
  tasks: string | null;
  mine: boolean;
  team: boolean;
};

/** Whether the board is hearing changes as they happen (Supabase Realtime). */
export type LiveState = "connecting" | "live" | "off";

type Props = { data: TrackerData; start: TrackerStart };

/** How long the address bar waits for focus to settle before following it. */
const URL_SYNC_MS = 400;

/** Where the board keeps its filters and sort, in this browser. */
const VIEW_KEY = "tt.board.view";

/**
 * A second close — done, dismiss, delete — this soon after one on ANOTHER task
 * is the rest of a double-click landing on the card that slid into focus, and
 * is ignored (2026-09-30 audit: it closed a task nobody looked at).
 */
const DOUBLE_CLOSE_MS = 700;

/**
 * The board.
 *
 * The one place in the app that holds a Supabase client for ordinary writes,
 * and the one rollback path (`mutate`). Every component under it — the track,
 * the detail area, the person views — only shows, and raises what the person
 * did back up to here.
 */
export function Tracker({ data, start }: Props) {
  const router = useRouter();
  const supabase = createSupabaseBrowserClient();

  const viewer: Viewer = useMemo(
    () => ({ ownerId: data.profile.id, selfId: (data.profile.discord_user_id ?? "").trim() }),
    [data.profile.id, data.profile.discord_user_id],
  );

  const [tasks, setTasks] = useState<Task[]>(data.tasks);
  const [people, setPeople] = useState<Person[]>(data.people);
  const [query, setQuery] = useState("");
  // A `?task=` link to something already closed opens on the closed filter, or
  // the task it names would be filtered off the track on arrival.
  const [filter, setFilter] = useState<BoardFilter>(() => {
    const linked = data.tasks.find((task) => task.id === start.taskId);
    if (linked && toReview(linked, viewer)) return "review";
    return linked && linked.status !== "open" ? "closed" : "all";
  });
  const [focusId, setFocusId] = useState<string | null>(start.taskId);
  // Someone with no bot of their own only receives work: unless a link says
  // otherwise, they land on My tasks — the one place their work is gathered.
  const [screen, setScreen] = useState<Screen>(() =>
    start.mine || (start.tasks !== null && start.tasks === viewer.selfId)
      ? { kind: "mine" }
      : start.team && data.connections?.discord_connected
        ? { kind: "team" }
        : start.person
          ? { kind: "person", key: start.person }
          : start.tasks
            ? { kind: "tasks", key: start.tasks }
            : !start.taskId && !data.connections?.discord_connected
              ? { kind: "mine" }
              : { kind: "board" },
  );
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  // What "Add a task by hand" files it at — medium unless the person says.
  const [newPriority, setNewPriority] = useState<Priority>("medium");
  // The "Ask" panel (Lucky35, 2026-10-12).
  const [askOpen, setAskOpen] = useState(false);

  // Priority and deadline filters and a sort, over every tab and the search
  // (Lucky35's PO, 2026-10-07). Kept in this browser, so it outlives a tab
  // change and a reload. Read after the first render: the server cannot see
  // it, and the first browser render must print what the server did.
  const [view, setView] = useState<BoardView>(DEFAULT_VIEW);
  const [viewReady, setViewReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const stored = window.localStorage.getItem(VIEW_KEY);
        if (stored) setView(parseView(JSON.parse(stored)));
      } catch {
        // No storage, or something unreadable in it: the default view.
      }
      setViewReady(true);
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!viewReady) return;
    try {
      window.localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {
      // Private mode: it lasts this visit only.
    }
  }, [view, viewReady]);

  // The worker adds tasks between renders, so the local copy has to follow the
  // server copy. Adjusted during render rather than in an effect — an effect
  // would paint the stale list first and re-render immediately after.
  // https://react.dev/learn/you-might-not-need-an-effect
  const [seen, setSeen] = useState(data.tasks);
  if (seen !== data.tasks) {
    setSeen(data.tasks);
    setTasks(data.tasks);
  }

  const [seenPeople, setSeenPeople] = useState(data.people);
  if (seenPeople !== data.people) {
    setSeenPeople(data.people);
    setPeople(data.people);
  }

  // The score history this viewer may read (`20261009_01`): their own, or
  // everyone's for Lucky35. Team, a person and Monthly add it up. Kept live —
  // entries only ever arrive; none is ever changed or removed.
  const [scoreEntries, setScoreEntries] = useState<ScoreEntry[]>(data.scoreEntries);
  const [seenEntries, setSeenEntries] = useState(data.scoreEntries);
  if (seenEntries !== data.scoreEntries) {
    setSeenEntries(data.scoreEntries);
    setScoreEntries(data.scoreEntries);
  }

  // Every verdict this viewer can read (`20261007_01`) — the task activity and
  // Undo. Kept live.
  const [reviews, setReviews] = useState<TaskReview[]>(data.reviews);
  const [seenReviews, setSeenReviews] = useState(data.reviews);
  if (seenReviews !== data.reviews) {
    setSeenReviews(data.reviews);
    setReviews(data.reviews);
  }

  // Tasks lately taken off the viewer — My tasks' "Moved off you".
  const [handoffs, setHandoffs] = useState<TaskHandoff[]>(data.handoffs);
  const [seenHandoffs, setSeenHandoffs] = useState(data.handoffs);
  if (seenHandoffs !== data.handoffs) {
    setSeenHandoffs(data.handoffs);
    setHandoffs(data.handoffs);
  }

  // Live (Lucky35, 2026-10-04: "see, in real time, which dev is working on
  // what"). Supabase Realtime pushes every change to a task or a miss this
  // viewer can read — RLS decides, as for any read — so a dev pressing Start
  // or Done, the worker filing a tag, or a deadline counted as missed shows
  // up without a Refresh. Merged row by row (`mergeLive`): newer wins, and a
  // write of the viewer's own still in flight is simply confirmed by it.
  const [live, setLive] = useState<LiveState>("connecting");
  useEffect(() => {
    const client = createSupabaseBrowserClient();
    // A fresh topic per subscription: re-running this effect (React's dev
    // double-run, a remount) must not be handed the old channel back, which
    // throws on `.on()` once it has subscribed.
    const channel = client
      .channel(`board:${data.profile.id}:${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "tt_tasks" }, (payload: RealtimePostgresChangesPayload<Task>) => {
        if (payload.eventType === "DELETE") {
          const id = (payload.old as { id?: string }).id;
          if (id) setTasks((current) => dropLive(current, id));
          return;
        }
        setTasks((current) => mergeLive(current, payload.new as Task));
      })
      // A verdict, anywhere it was given — this board, a reply on Discord, the
      // person who asked for it: the score follows at once.
      .on("postgres_changes", { event: "*", schema: "public", table: "tt_task_reviews" }, (payload: RealtimePostgresChangesPayload<TaskReview>) => {
        if (payload.eventType === "DELETE") {
          const id = (payload.old as { id?: string }).id;
          if (id) setReviews((current) => dropLive(current, id));
          return;
        }
        setReviews((current) => mergeLive(current, payload.new as TaskReview));
      })
      // A point, the moment it is written — RLS sends the viewer their own,
      // and Lucky35 everyone's. Only ever an INSERT: the history is permanent.
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "tt_score_entries" }, (payload: RealtimePostgresChangesPayload<ScoreEntry>) => {
        const entry = payload.new as ScoreEntry;
        setScoreEntries((current) => (current.some((e) => e.id === entry.id) ? current : [...current, entry]));
      })
      // A task taken off the viewer: its own UPDATE never reaches someone who
      // can no longer read it, so the handoff is what drops it from their
      // board — and says why (Lucky35's PO, 2026-10-04).
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "tt_task_handoffs" }, (payload: RealtimePostgresChangesPayload<TaskHandoff>) => {
        const handoff = payload.new as TaskHandoff;
        setHandoffs((current) => mergeLive(current, handoff));
        setTasks((current) => dropHandedOff(current, handoff, viewer));
      })
      .subscribe((status: string) => {
        setLive(status === "SUBSCRIBED" ? "live" : status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED" ? "off" : "connecting");
      });
    return () => {
      void client.removeChannel(channel);
    };
  }, [data.profile.id, viewer]);

  // Tagged messages the tracker read and did not file. Same server-follows
  // rule as the two lists above. `skippedTotal` counts all of them; the list
  // holds the newest hundred.
  const [skipped, setSkipped] = useState<SkippedMessage[]>(data.skipped);
  const [skippedTotal, setSkippedTotal] = useState(data.skippedTotal);
  const [olderLoading, setOlderLoading] = useState(false);
  // A search over every unreviewed row; `found` is null when not searching.
  const [findWords, setFindWords] = useState("");
  const [found, setFound] = useState<SkippedMessage[] | null>(null);
  const [seenSkipped, setSeenSkipped] = useState(data.skipped);
  if (seenSkipped !== data.skipped) {
    setSeenSkipped(data.skipped);
    setSkipped(data.skipped);
    setSkippedTotal(data.skippedTotal);
  }

  // Ordering, the counts and every "in 3 hours" label are relative to now, so
  // the page re-reads the clock every 30 seconds — AND at the exact instant the
  // next deadline passes. That second tick is what keeps the board honest:
  // "overdue" is decided from this one clock everywhere on the page, the live
  // countdowns included, so a card can never say "Overdue" while the count
  // beside it says otherwise (Lucky35, 2026-09-29). Seconds still live in
  // `components/clock.ts` and never reach the ordering.
  //
  // It STARTS at the moment the server rendered, so the first browser render
  // prints exactly what the server did, and moves to the real time right after.
  // It is also re-read when the tab is looked at again: a sleeping laptop's
  // timers do not run, and the board must not wake up half a minute behind.
  const [now, setNow] = useState(() => new Date(data.renderedAt));
  useEffect(() => {
    const read = () => setNow(new Date());
    const first = setTimeout(read, 0);
    const timer = setInterval(read, 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // The zone every time on the page is read in, and "today" ends in. The
  // profile's, until the browser's is captured below.
  const [timeZone, setTimeZone] = useState(data.profile.timezone || "UTC");

  const nextCrossing = useMemo(() => nextDeadlineAfter(tasks, now), [tasks, now]);
  useEffect(() => {
    if (nextCrossing === null) return;
    // A few ms late on purpose: the tick must land strictly AFTER the deadline,
    // or `isOverdue` (a strict <) would still say not yet. setTimeout also caps
    // at ~24.8 days; anything that far out is picked up by the interval.
    const delay = nextCrossing - Date.now() + 5;
    if (delay > 2_147_483_000) return;
    const timer = setTimeout(() => setNow(new Date()), Math.max(0, delay));
    return () => clearTimeout(timer);
  }, [nextCrossing]);

  /**
   * Fill in the time zone, once, from the browser.
   *
   * `tt_profiles.timezone` is `not null default 'UTC'`, and the classifier
   * resolves "Tuesday" in it. This is the only automatic writer, and it is
   * deliberately timid: it writes ONLY when the stored value is exactly "UTC",
   * so a zone chosen in Settings is never clobbered; it latches on a ref so a
   * re-render can never turn it into a write loop; it does not go through
   * `mutate()`, which carries task state only; and it fails silently.
   */
  const timezoneCaptured = useRef(false);
  useEffect(() => {
    if (timezoneCaptured.current) return;
    if (data.profile.timezone !== "UTC") return;

    const detected = detectBrowserTimeZone();
    if (detected === "UTC") return;

    timezoneCaptured.current = true;
    // A query builder sends nothing until it is awaited or `.then()`-ed: `void`
    // on the bare builder never fired this request, which is why every profile
    // stayed on UTC. A failure is swallowed — failing silently is the rule —
    // but a success is used at once: "Make it a task" reads a message's
    // "tomorrow" in this zone, and so do the times on the page.
    supabase
      .from("tt_profiles")
      .update({ timezone: detected })
      .eq("id", data.profile.id)
      .then(
        ({ error: saveError }: { error: unknown }) => {
          if (!saveError) setTimeZone(detected);
        },
        () => undefined,
      );
    // `supabase` is a fresh browser client per render and is deliberately not a
    // dependency: including it would re-run this effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.profile.id, data.profile.timezone]);

  // --- what is on the track -------------------------------------------------

  // The name the board shows for each person, where only `tt_people` has one,
  // so a search for what a card says finds the card.
  const names = useMemo(
    () => new Map(people.filter((p) => p.display_name.trim()).map((p) => [p.discord_user_id, p.display_name])),
    [people],
  );

  const visible = useMemo(
    () => filterTasks(tasks, { filter, query, viewer, now, timeZone, names, view }),
    [tasks, filter, query, viewer, now, timeZone, names, view],
  );
  const focus = resolveFocus(
    visible.map((task) => task.id),
    focusId,
  );
  const focused = visible.find((task) => task.id === focus) ?? null;

  const figures = useMemo(() => boardFigures(tasks, viewer, now, timeZone), [tasks, viewer, now, timeZone]);
  // Tasks the board holds: an answer to "Ask" opens these in place, any other through its link.
  const knownIds = useMemo(() => new Set(tasks.map((task) => task.id)), [tasks]);
  const known = useMemo(() => knownPeople(tasks, people, viewer), [tasks, people, viewer]);

  /** The label for a person key: "You" for the viewer, else the best name any row has. */
  function nameOf(key: string, task?: Task): string {
    if (viewer.selfId !== "" && key === viewer.selfId) return "You";
    const row = people.find((person) => person.discord_user_id === key) ?? null;
    const named =
      (task && personKeyOf(task) === key && task.assignee_name ? task : null) ??
      tasks.find((candidate) => personKeyOf(candidate) === key && candidate.assignee_name) ??
      null;
    return displayNameFor(row, named, key);
  }

  /**
   * A Discord id in a message, as a name: who the message tagged, the bot,
   * the viewer, or anyone the board knows by name. Null when nothing names it
   * — the message then reads "@someone", never a raw snowflake.
   */
  function mentionName(id: string, task: Task): string | null {
    const tagged = task.source_mentions?.find((person) => person.id === id)?.name;
    if (tagged) return tagged;
    if (data.connections?.discord_bot_user_id && id === data.connections.discord_bot_user_id) {
      return data.connections.discord_bot_username ?? "bot";
    }
    if (viewer.selfId !== "" && id === viewer.selfId) return data.profile.discord_username ?? "you";
    const known = nameOf(id);
    return known.startsWith("@") ? null : known;
  }

  // --- the address bar follows what is on screen ------------------------------
  //
  // So a reload, or a link copied out of the address bar, opens the same card.
  // Debounced: swiping along the track moves focus several times a second, and
  // browsers throttle history writes that come faster than that.
  useEffect(() => {
    const timer = setTimeout(() => {
      const params = new URLSearchParams();
      if (screen.kind === "mine") params.set("mine", "");
      else if (screen.kind === "team") params.set("team", "");
      else if (screen.kind === "person") params.set("person", screen.key);
      else if (screen.kind === "tasks") params.set("tasks", screen.key);
      else if (focus) params.set("task", focus);

      const next = params.toString();
      if (next !== window.location.search.replace(/^\?/, "")) {
        window.history.replaceState(null, "", next ? `?${next}` : window.location.pathname);
      }
    }, URL_SYNC_MS);
    return () => clearTimeout(timer);
  }, [screen, focus]);

  // On a phone the detail sits under the track, so opening a task from its
  // card has to bring the detail into view or nothing visibly happens.
  const detailRef = useRef<HTMLElement | null>(null);
  const revealDetail = useRef(false);
  useEffect(() => {
    if (!revealDetail.current) return;
    revealDetail.current = false;
    if (!window.matchMedia("(max-width: 1000px)").matches) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    detailRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, [focus, screen]);

  // Where keyboard focus goes when what it was on disappears: into the detail
  // of the card that took the closed one's place, or onto the heading of the
  // person screen just opened — never dropped on <body>.
  const focusDetail = useRef(false);
  useEffect(() => {
    if (!focusDetail.current) return;
    focusDetail.current = false;
    detailRef.current?.querySelector<HTMLElement>(".detail")?.focus({ preventScroll: true });
  }, [focus]);
  useEffect(() => {
    if (screen.kind === "board") return;
    document.querySelector<HTMLElement>(".person-panel-name")?.focus({ preventScroll: true });
  }, [screen]);

  // --- navigation ---------------------------------------------------------------

  /** Open one task: back to the board, on a filter that shows it, with it in focus. */
  function openTask(id: string) {
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task) return;

    const onTrack = filterTasks(tasks, { filter, query, viewer, now, timeZone, view }).some((candidate) => candidate.id === id);
    if (!onTrack) {
      setQuery("");
      setFilter(task.status === "open" ? "all" : "closed");
      // Opened on purpose: the filters step aside; the sort stays.
      setView((current) => ({ ...current, priorities: [], from: null, to: null }));
    }

    setScreen({ kind: "board" });
    setFocusId(id);
    revealDetail.current = true;
  }

  function openPerson(key: string) {
    if (key.trim() === "") return;
    setScreen({ kind: "person", key: key.trim() });
    window.scrollTo({ top: 0 });
  }

  function openPersonTasks(key: string) {
    if (key.trim() === "") return;
    // Everything on the viewer is My tasks.
    setScreen(viewer.selfId !== "" && key.trim() === viewer.selfId ? { kind: "mine" } : { kind: "tasks", key: key.trim() });
    window.scrollTo({ top: 0 });
  }

  function openMine() {
    setScreen({ kind: "mine" });
    window.scrollTo({ top: 0 });
  }

  function openTeam() {
    setScreen({ kind: "team" });
    window.scrollTo({ top: 0 });
  }

  // --- the one write path ---------------------------------------------------------

  /**
   * Apply a change locally first, then persist. On failure, put back the rows
   * THIS change touched — only those: a whole-list snapshot also undid every
   * other edit that succeeded meanwhile, and anything a Refresh brought in.
   */
  async function mutate(
    key: string,
    optimistic: (current: Task[]) => Task[],
    persist: () => Promise<{ error: { message: string } | null }>,
  ) {
    const after = new Set(optimistic(tasks));
    const touched = new Map(tasks.filter((t) => !after.has(t)).map((t) => [t.id, t]));
    setTasks(optimistic);
    setBusy((b) => ({ ...b, [key]: true }));
    setError(null);

    const { error: writeError } = await persist();

    setBusy((b) => {
      const next = { ...b };
      delete next[key];
      return next;
    });

    if (writeError) {
      setTasks((current) => {
        const present = new Set(current.map((t) => t.id));
        const restored = current.map((t) => touched.get(t.id) ?? t);
        for (const [id, row] of touched) if (!present.has(id)) restored.push(row);
        return restored;
      });
      setError(writeError.message);
    }
  }

  /**
   * The same shape as `mutate()` — snapshot, apply locally, persist, put it back
   * on failure — over `Person[]`. A sibling rather than a widening of
   * `mutate()`, which every task write depends on and nothing tests.
   *
   * A person who has never been noted or graded has no `tt_people` row at all,
   * so the optimistic entry carries a placeholder id until the upsert returns
   * the real one.
   */
  async function mutatePerson(
    key: string,
    optimistic: (current: Person[]) => Person[],
    persist: () => Promise<{ data: Person | null; error: { message: string } | null }>,
  ) {
    const snapshot = people;
    const busyKey = `person:${key}`;

    setPeople(optimistic);
    setBusy((b) => ({ ...b, [busyKey]: true }));
    setError(null);

    const { data: written, error: writeError } = await persist();

    setBusy((b) => {
      const next = { ...b };
      delete next[busyKey];
      return next;
    });

    if (writeError) {
      setPeople(snapshot);
      setError(writeError.message);
      return;
    }

    if (written) {
      setPeople((current) => [
        ...current.filter((row) => row.discord_user_id !== written.discord_user_id),
        written,
      ]);
    }
  }

  /**
   * Write one field of a person's row, creating the row if this is the first
   * thing ever said about them. An upsert on the plain `unique (user_id,
   * discord_user_id)` constraint (AGENTS.md:94-100); only the field being edited
   * is sent, so saving a note cannot flatten a grade set a moment earlier.
   * `user_id` is supplied by the client: PostgREST does not fill it in, and
   * omitting it fails as a not-null violation that reads like an RLS problem.
   */
  async function savePerson(key: string, label: string, changes: { notes?: string; grade?: number | null }) {
    const stamp = new Date().toISOString();

    await mutatePerson(
      key,
      (current) => {
        if (current.some((row) => row.discord_user_id === key)) {
          return current.map((row) =>
            row.discord_user_id === key ? { ...row, ...changes, display_name: label, updated_at: stamp } : row,
          );
        }
        return [
          ...current,
          {
            id: `pending:${key}`,
            user_id: data.profile.id,
            discord_user_id: key,
            display_name: label,
            avatar_url: null,
            notes: "",
            grade: null,
            created_at: stamp,
            updated_at: stamp,
            ...changes,
          },
        ];
      },
      async () => {
        const { data: written, error: writeError } = await supabase
          .from("tt_people")
          .upsert(
            { user_id: data.profile.id, discord_user_id: key, display_name: label, ...changes },
            { onConflict: "user_id,discord_user_id" },
          )
          .select("*")
          // Never `.single()`: it throws on zero rows (AGENTS.md:37-38).
          .maybeSingle();

        return { data: (written as Person | null) ?? null, error: writeError };
      },
    );
  }

  function patch(taskId: string, apply: (task: Task) => Task) {
    return (current: Task[]) => current.map((t) => (t.id === taskId ? apply(t) : t));
  }

  /**
   * Every write that can change when a reminder is due goes through here, so
   * `next_alert_at` can never drift out of step with the deadline, the cadence
   * and the status. The same pure function runs in the worker.
   */
  function withSchedule(task: Task, changes: Partial<Task>): Partial<Task> {
    const merged = { ...task, ...changes };
    // Both streams: the giver's cadence, and the assignee's own reminders,
    // which go on when the giver chose "No reminder" (lib/reminders.ts).
    const next = nextAlertFor(merged, new Date(), viewer.selfId || null);
    // A moved deadline is a new clock for the assignee as well: the overdue
    // cap counts reminders after the deadline they are actually late for.
    const movedDeadline = "deadline" in changes && changes.deadline !== task.deadline;
    return {
      ...changes,
      ...(movedDeadline ? { assignee_overdue_alerts: 0 } : {}),
      next_alert_at: next ? next.toISOString() : null,
    };
  }

  /**
   * Change a task. `scheduled` is for changes that can move its reminder —
   * deadline, cadence, status. A title, a note, a colour or an assignee cannot,
   * and recomputing the schedule for them would push a never-sent first
   * reminder one interval further out on every keystroke-and-blur.
   *
   * A task somebody else gave the viewer is theirs to change, not the viewer's:
   * the database would refuse, so nothing is attempted.
   */
  async function update(task: Task, changes: Partial<Task>, scheduled = true) {
    if (isShared(task, viewer)) return;
    const payload = scheduled ? withSchedule(task, changes) : changes;
    keepPlace(task, payload);
    await mutate(
      `${task.id}:${Object.keys(changes).join(",")}`,
      patch(task.id, (t) => ({ ...t, ...payload })),
      async () => await supabase.from("tt_tasks").update(payload).eq("id", task.id),
    );
  }

  /**
   * Move a task along the rail. Clicking the stage a task is already on steps
   * it BACK — that is the undo. Reaching Completed or Closed also marks the
   * task done, which stops the reminders.
   */
  /**
   * When a change is about to take the card in focus off the track — done or
   * dismissed under "All", reopened under "Done & dismissed" — focus moves to
   * its neighbour now, not to the first card afterwards, and keyboard focus
   * follows into the detail.
   */
  function keepPlace(task: Task, changes: Partial<Task>) {
    if (task.id !== focus) return;
    const stays = filterTasks([{ ...task, ...changes }], { filter, query, viewer, now, timeZone, names, view }).length > 0;
    if (stays) return;
    setFocusId(focusAfterRemoval(visible.map((t) => t.id), task.id));
    focusDetail.current = true;
  }

  // The last close, for `DOUBLE_CLOSE_MS`.
  const lastClose = useRef<{ id: string; at: number } | null>(null);

  /** False for the second half of a double-click that landed on the next task. */
  function closeAllowed(task: Task): boolean {
    const previous = lastClose.current;
    const at = Date.now();
    if (previous && previous.id !== task.id && at - previous.at < DOUBLE_CLOSE_MS) return false;
    lastClose.current = { id: task.id, at };
    return true;
  }

  async function setStage(task: Task, ordinal: number) {
    const nextStage = task.stage === ordinal ? ordinal - 1 : ordinal;
    const stamp = new Date().toISOString();
    const shouldBeDone = isDoneStage(nextStage);

    // Reported, approved or failed work moves only by a verdict (the review
    // panel), and work given to someone else is finished only by approving it
    // — which is scored (Lucky35's PO, 2026-10-07).
    if (awaitsReview(task) || finishedByAssignee(task) || settledByReview(task)) return;
    if (shouldBeDone && task.status === "open" && reviewedWork(task, viewer.selfId || null)) return;

    const changes: Partial<Task> = {
      stage: nextStage,
      stage_at: stampStages(task.stage_at, nextStage, stamp),
    };

    // Only touch status when the rail actually crosses the done line, so a
    // task dismissed by hand is not silently reopened by a stage click.
    if (shouldBeDone && task.status === "open") {
      if (!closeAllowed(task)) return;
      changes.status = "done";
      changes.completed_at = stamp;
      changes.completed_by = "owner";
      // Closed by the giver themselves: nothing is left to review.
      changes.review_state = null;
    } else if (!shouldBeDone && task.status === "done") {
      changes.status = "open";
      changes.completed_at = null;
      changes.completed_by = null;
    }

    await update(task, changes);
  }

  /**
   * Done, dismissed or open again — with the rail kept in step: done reaches
   * Completed at least, and reopening steps back off the done stages, so an
   * open task never sits on "Completed" (2026-09-30 audit).
   */
  async function setStatus(task: Task, status: Task["status"]) {
    // Reopening work its assignee reported is a verdict — disapprove or extend,
    // which tells them — never a silent reopen; approved or failed work is
    // final; and closing work given to someone else is approving it.
    if (status === "open" && (finishedByAssignee(task) || settledByReview(task))) return;
    if (status === "done" && reviewedWork(task, viewer.selfId || null)) return;
    if (status !== "open" && !closeAllowed(task)) return;
    const stamp = new Date().toISOString();
    const stage =
      status === "done"
        ? Math.max(task.stage, DONE_FROM_STAGE)
        : status === "open" && isDoneStage(task.stage)
          ? DONE_FROM_STAGE - 1
          : task.stage;

    await update(task, {
      status,
      completed_at: status === "open" ? null : stamp,
      completed_by: status === "done" ? "owner" : null,
      ...(status === "done" ? { review_state: null } : {}),
      ...(stage !== task.stage ? { stage, stage_at: stampStages(task.stage_at, stage, stamp) } : {}),
    });
  }

  /**
   * The assignee's answer on a task somebody else gave them: done, stop
   * reminding me, remind me again. Not a table write — the row is the giver's,
   * and the giver is DMed about it — so it goes to `/api/tasks/assignee`, with
   * the same apply-locally-then-put-it-back shape as `mutate()`.
   */
  async function assigneeAct(task: Task, action: AssigneeAction, opts: { stage?: number } = {}) {
    if (action === "done") {
      if (!closeAllowed(task)) return;
      keepPlace(task, { status: "done" });
    }
    // Moving their own stage, or taking a report back: the same pure rules
    // the server applies (`assigneeActionChanges`), so a refusal is said here.
    const computed = action === "stage" || action === "withdraw" ? assigneeActionChanges(task, action, new Date(), null, opts) : null;
    if (computed && !computed.ok) {
      setError(computed.error);
      return;
    }
    const stamp = new Date().toISOString();
    const started = Math.max(task.stage, IN_PROGRESS_STAGE);
    const optimistic: Partial<Task> = computed?.ok
      ? computed.changes
      : action === "start"
        ? { stage: started, stage_at: stampStages(task.stage_at, started, stamp) }
        : action === "done"
          ? { status: "done", completed_at: stamp, completed_by: "assignee", review_state: "pending", next_alert_at: null }
          : action === "mute"
            ? { assignee_muted_at: stamp, assignee_muted_by: "assignee" }
            : { assignee_muted_at: null, assignee_muted_by: null };

    await mutate(
      `${task.id}:assignee:${action}`,
      patch(task.id, (t) => ({ ...t, ...optimistic })),
      async () => {
        const response = await fetch("/api/tasks/assignee", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId: task.id, action, ...(opts.stage !== undefined ? { stage: opts.stage } : {}) }),
        });
        const payload = (await response.json().catch(() => ({}))) as { task?: Task; error?: string };
        if (!response.ok || !payload.task) {
          return { error: { message: payload.error ?? `${response.status} ${response.statusText}` } };
        }
        // What the server actually wrote wins over the guess above.
        const written = payload.task;
        setTasks((current) => current.map((t) => (t.id === written.id ? written : t)));
        return { error: null };
      },
    );
  }

  /**
   * "I'm on it": In progress. The assignee's own word on a task somebody else
   * gave them goes through `/api/tasks/assignee`; on the viewer's own task it
   * is the rail. Never steps a task back.
   */
  async function startTask(task: Task) {
    if (task.status !== "open" || task.stage >= IN_PROGRESS_STAGE) return;
    if (isShared(task, viewer)) await assigneeAct(task, "start");
    else await setStage(task, IN_PROGRESS_STAGE);
  }

  /**
   * A verdict on work reported done — or on open work given to someone else:
   * approve on time / late, disapprove (close, reopen), extend (Lucky35's PO,
   * 2026-10-07). Always through `/api/tasks/review`: it is the score, the
   * assignee is DMed through the owner's bot, and the reviewer may not own the
   * row (they asked for it). Applied at once, put back if refused.
   */
  /**
   * Take its person off a card they were only copied in on (Cenri,
   * 2026-10-20: "@jfabbs … share it with @umer" gave umer a card) — the
   * board's owner, or whoever asked for it. Closed, nothing counts for or
   * against them, and they are told (`/api/tasks/not-for`).
   */
  async function notForThem(task: Task) {
    const who = nameOf(personKeyOf(task), task);
    const ok = window.confirm(
      `Take ${who} off "${task.title}"?\n\nFor someone who was only copied in. Their card is closed: nothing counts for or against them, their reminders stop, and they get a DM saying so.`,
    );
    if (!ok) return;
    keepPlace(task, { status: "dismissed" });
    await mutate(
      `${task.id}:not-for`,
      patch(task.id, (t) => ({ ...t, status: "dismissed", dismiss_reason: "only_cc", next_alert_at: null })),
      async () => {
        const response = await fetch("/api/tasks/not-for", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId: task.id }),
        });
        const payload = (await response.json().catch(() => ({}))) as { task?: Task; error?: string | null };
        if (!response.ok || !payload.task) return { error: { message: payload.error ?? `${response.status} ${response.statusText}` } };
        const written = payload.task;
        setTasks((current) => current.map((t) => (t.id === written.id ? written : t)));
        return { error: null };
      },
    );
  }

  /** Its person says a card is not theirs: whoever reviews it is told; nothing on it changes. An error, or null. */
  async function notMine(task: Task): Promise<string | null> {
    try {
      const response = await fetch("/api/tasks/not-mine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: task.id }),
      });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; told?: boolean; error?: string | null };
      if (!response.ok || !payload.ok) return payload.error ?? `${response.status} ${response.statusText}`;
      return null;
    } catch (caught) {
      return caught instanceof Error ? caught.message : String(caught);
    }
  }

  async function decideTask(task: Task, input: ReviewInput) {
    if (!canReview(task, viewer)) return;
    if (!closeAllowed(task)) return;
    const result = reviewChanges(task, input, new Date(), isShared(task, viewer) ? null : viewer.selfId || null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    keepPlace(task, result.changes);
    const who = nameOf(personKeyOf(task), task);
    await mutate(
      `${task.id}:review`,
      patch(task.id, (t) => ({ ...t, ...result.changes })),
      async () => {
        const response = await fetch("/api/tasks/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId: task.id, decision: input.decision, note: input.note ?? null, deadline: input.deadline ?? null }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          task?: Task;
          review?: TaskReview;
          told?: boolean;
          error?: string | null;
        };
        if (!response.ok || !payload.task) {
          return { error: { message: payload.error ?? `${response.status} ${response.statusText}` } };
        }
        const written = payload.task;
        setTasks((current) => current.map((t) => (t.id === written.id ? written : t)));
        // The score moves now, not when Realtime gets round to it.
        const recorded = payload.review;
        if (recorded && recorded.user_id === data.profile.id) setReviews((current) => mergeLive(current, recorded));
        // Saved either way; a DM that did not go is said, never swallowed.
        if (!payload.told) {
          setError(`Saved, but the DM to ${who} did not go through${payload.error ? ` (${payload.error})` : ""}. Tell them yourself.`);
        }
        return { error: null };
      },
    );
  }

  /**
   * Take a verdict back (Lucky35's PO, 2026-10-07: "clicked Completed by
   * mistake and did not know how to undo it"). The task goes back exactly as
   * it was — reported and waiting, or open — the verdict stays listed but
   * counts nothing, and the assignee is told. Only while nothing has happened
   * since (`undoChanges`).
   */
  async function undoTask(task: Task, review: TaskReview) {
    if (!canReview(task, viewer)) return;
    const result = undoChanges(task, review, new Date(), isShared(task, viewer) ? null : viewer.selfId || null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const who = nameOf(personKeyOf(task), task);
    await mutate(
      `${task.id}:review`,
      patch(task.id, (t) => ({ ...t, ...result.changes })),
      async () => {
        const response = await fetch("/api/tasks/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId: task.id, undo: review.id }),
        });
        const payload = (await response.json().catch(() => ({}))) as { task?: Task; review?: TaskReview; told?: boolean; error?: string | null };
        if (!response.ok || !payload.task) {
          return { error: { message: payload.error ?? `${response.status} ${response.statusText}` } };
        }
        const written = payload.task;
        setTasks((current) => current.map((t) => (t.id === written.id ? written : t)));
        const marked = payload.review;
        if (marked) setReviews((current) => mergeLive(current, marked));
        if (!payload.told) {
          setError(`Taken back, but the DM to ${who} did not go through${payload.error ? ` (${payload.error})` : ""}. Tell them yourself.`);
        }
        return { error: null };
      },
    );
  }

  /**
   * "Remind now" (PO, 2026-10-07, task 5): DM the assignee at once — the
   * reviewer's own words, or the usual reminder when `message` is empty. The
   * server counts it in "Sent so far"; the count is shown here before
   * Realtime brings the row back.
   */
  async function remindTask(task: Task, message: string): Promise<RemindResult> {
    try {
      const response = await fetch("/api/tasks/remind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: task.id, message }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        sentAt?: string;
        by?: string;
        counts?: Partial<Task>;
      };
      if (!response.ok || !payload.sentAt) return { error: payload.error ?? `${response.status} ${response.statusText}` };
      const counts = payload.counts;
      if (counts) setTasks((current) => current.map((t) => (t.id === task.id ? { ...t, ...counts } : t)));
      return { error: null, sentAt: payload.sentAt, by: payload.by ?? null };
    } catch (caught) {
      return { error: caught instanceof Error ? caught.message : String(caught) };
    }
  }

  /**
   * The assignee reports it done, with its proof (required — task.md). The
   * files were already uploaded by the form; the server checks they landed,
   * keeps the proof, and DMs whoever reviews it. True when it went through.
   */
  async function reportTask(task: Task, proof: ProofDraft): Promise<boolean> {
    if (!closeAllowed(task)) return false;
    keepPlace(task, { status: "done" });
    const stamp = new Date().toISOString();
    let sent = false;
    await mutate(
      `${task.id}:assignee:done`,
      patch(task.id, (t) => ({
        ...t,
        status: "done",
        completed_at: stamp,
        completed_by: "assignee",
        review_state: "pending",
        stage: PENDING_STAGE,
        next_alert_at: null,
      })),
      async () => {
        const response = await fetch("/api/tasks/assignee", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId: task.id, action: "done", proof }),
        });
        const payload = (await response.json().catch(() => ({}))) as { task?: Task; error?: string };
        if (!response.ok || !payload.task) {
          return { error: { message: payload.error ?? `${response.status} ${response.statusText}` } };
        }
        const written = payload.task;
        setTasks((current) => current.map((t) => (t.id === written.id ? written : t)));
        sent = true;
        return { error: null };
      },
    );
    return sent;
  }

  /**
   * "Make it a task" on something the tracker read and did not file. Built the
   * way the worker would have built it (`taskFromMessage`), then the message is
   * marked filed so it leaves the list. `tt_tasks_one_per_message` makes a
   * double press harmless: the second insert conflicts rather than duplicating.
   */
  async function fileSkipped(message: SkippedMessage) {
    setError(null);
    const now = new Date();
    const draft = taskFromMessage(message, { userId: data.profile.id, timezone: timeZone, now, ownerDiscordId: viewer.selfId || null });
    // A card for everyone the message tagged, as the worker files them.
    const rows = cardsForEveryone(draft, message.direction === "received" ? [] : message.mentions, {
      // Anyone tagged only in a "cc" list is copied in, not given a card.
      content: message.content,
      messageId: message.id,
      viaDm: message.via_dm,
      now,
      ownerDiscordId: viewer.selfId || null,
    });

    const { data: inserted, error: insertError } = await supabase.from("tt_tasks").insert(rows).select("*");
    if (insertError || !inserted || inserted.length === 0) {
      setError(insertError?.message ?? "The task was not saved.");
      return;
    }

    setSkipped((current) => current.filter((m) => m.id !== message.id));
    setFound((current) => (current ? current.filter((m) => m.id !== message.id) : current));
    setSkippedTotal((total) => Math.max(0, total - 1));
    showNew((inserted as Task[]).sort((a, b) => (a.message_part ?? 0) - (b.message_part ?? 0)));

    // Best effort: the card exists either way, and a message still marked
    // unfiled only means it shows in this list again after a reload.
    await supabase.from("tt_messages").update({ is_task: true }).eq("id", message.id).then(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * A person agrees the tracker was right: these are not tasks. The only way a
   * row leaves "Not filed" other than becoming a card — nothing ages off the
   * list on its own, because it is the one trace a misjudged message leaves.
   * Applied locally first and put back if the write fails.
   */
  async function reviewSkipped(messages: SkippedMessage[]) {
    if (messages.length === 0) return;
    const ids = new Set(messages.map((m) => m.id));
    const before = skipped;
    const beforeFound = found;
    const beforeTotal = skippedTotal;

    setError(null);
    setSkipped((current) => current.filter((m) => !ids.has(m.id)));
    setFound((current) => (current ? current.filter((m) => !ids.has(m.id)) : current));
    setSkippedTotal((total) => Math.max(0, total - ids.size));

    const { error: writeError } = await supabase
      .from("tt_messages")
      .update({ skip_reviewed_at: new Date().toISOString() })
      .in("id", [...ids]);

    if (writeError) {
      setSkipped(before);
      setFound(beforeFound);
      setSkippedTotal(beforeTotal);
      setError(writeError.message);
    }
  }

  function clearSkipped() {
    const rows = found ?? skipped;
    const question = found
      ? `Mark these ${rows.length} matches as not tasks? They leave this list for good.`
      : skippedTotal > rows.length
        ? `Mark these ${rows.length} as not tasks? The ${skippedTotal - rows.length} older ones stay on the list.`
        : `Mark all ${rows.length} as not tasks? They leave this list for good.`;
    if (window.confirm(question)) void reviewSkipped(rows);
  }

  /** The unreviewed "Not filed" rows, newest first — one query shape for paging and search. */
  function notFiledQuery() {
    return supabase
      .from("tt_messages")
      .select(NOT_FILED_COLUMNS)
      .not("skip_category", "is", null)
      .eq("is_task", false)
      .is("skip_reviewed_at", null);
  }

  /**
   * The next page back. Every unreviewed row is reachable this way, however
   * old — the list is the only trace a misjudged message leaves, so a row past
   * the first hundred must be one press away, not only a number (Lucky35,
   * 2026-09-30). Paged by row, not offset (`olderThanFilter`).
   */
  async function showOlder() {
    // With every loaded row reviewed there is no row to page from: start again
    // from the newest, which is now the next unreviewed one.
    const last = skipped[skipped.length - 1];
    setOlderLoading(true);
    const base = notFiledQuery();
    const { data: page, error: readError } = await (last ? base.or(olderThanFilter(last)) : base)
      .order("sent_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(NOT_FILED_PAGE);
    setOlderLoading(false);

    if (readError) {
      setError(readError.message);
      return;
    }
    setSkipped((current) => {
      const seen = new Set(current.map((m) => m.id));
      return [...current, ...((page ?? []) as SkippedMessage[]).filter((m) => !seen.has(m.id))];
    });
  }

  function findSkipped(words: string) {
    setFindWords(words);
    if (!likeContains(words)) setFound(null);
  }

  // Search every unreviewed row on the server, not just the pages loaded — the
  // message someone is looking for is exactly the one they cannot scroll to.
  useEffect(() => {
    const pattern = likeContains(findWords);
    if (!pattern) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const { data: matches, error: readError } = await notFiledQuery()
        .ilike("content", pattern)
        .order("sent_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(NOT_FILED_PAGE);
      if (cancelled) return;
      if (readError) setError(readError.message);
      else setFound((matches ?? []) as SkippedMessage[]);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `notFiledQuery` reads the cached browser client; only the words matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findWords]);

  async function remove(task: Task) {
    if (isShared(task, viewer)) return;
    if (!window.confirm(`Delete "${task.title}"? This cannot be undone — Dismiss keeps it.`)) return;
    // Recorded after the confirm, so a stray click that follows it onto the
    // next card is caught — and a cancelled delete blocks nothing.
    if (!closeAllowed(task)) return;
    if (task.id === focus) {
      setFocusId(focusAfterRemoval(visible.map((t) => t.id), task.id));
      focusDetail.current = true;
    }
    await mutate(
      `del:${task.id}`,
      (current) => current.filter((t) => t.id !== task.id),
      async () => await supabase.from("tt_tasks").delete().eq("id", task.id),
    );
  }

  /**
   * Add a task by hand. It lands on the track in focus, with its missing
   * assignee and deadline showing, so the next thing the person does is fill
   * them in beside it.
   */
  async function addTask() {
    const title = newTitle.trim();
    if (!title) return;

    setNewTitle("");
    setError(null);

    const { data: inserted, error: insertError } = await supabase
      .from("tt_tasks")
      .insert({
        user_id: data.profile.id,
        title,
        color: colorForKey(title + Date.now()),
        direction: "given",
        priority: newPriority,
      })
      .select("*")
      .single();

    if (insertError || !inserted) {
      setError(insertError?.message ?? "The task was not saved.");
      setNewTitle(title);
      return;
    }

    showNew([inserted as Task]);
  }

  /**
   * A card just made — by hand, or from "Not filed" — lands on the track in
   * focus: the search is cleared and the filter changed only if it would hide
   * the card (a received task is not "I asked for"), and on a phone the detail
   * is brought into view.
   */
  function showNew(cards: Task[]) {
    const [task] = cards;
    if (!task) return;
    const ids = new Set(cards.map((card) => card.id));
    // Realtime may have brought them in already.
    setTasks((current) => [...cards, ...current.filter((other) => !ids.has(other.id))]);
    setQuery("");
    if (filterTasks([task], { filter, query: "", viewer, now, timeZone }).length === 0) setFilter("all");
    // A card just made is never hidden by the filters.
    if (filterTasks([task], { filter: "all", query: "", viewer, now, timeZone, view }).length === 0) {
      setView((current) => ({ ...current, priorities: [], from: null, to: null }));
    }
    setFocusId(task.id);
    revealDetail.current = true;
  }

  async function refresh() {
    setRefreshing(true);
    router.refresh();
    // The refresh resolves through the router, not this promise; the spinner is
    // released on a short timer so the button cannot latch on forever.
    setTimeout(() => setRefreshing(false), 700);
  }

  // --- the page -------------------------------------------------------------------

  const discordReady = data.connections?.discord_connected ?? false;
  const claudeReady = data.connections?.anthropic_connected ?? false;
  // "Did I already give someone a task about X?" (Lucky35, 2026-10-12): on the owner's own Claude.
  const askable = discordReady && claudeReady;
  const watching = data.watchedChannels > 0;
  const botName = data.connections?.discord_bot_username ?? "YourBot";

  // One re-invite per server fixes every blocked channel in it.
  const blockedGuilds = Array.from(
    new Map(data.reactionBlocked.map((channel) => [channel.guild_id, channel.guild_name ?? "that server"])),
    ([id, name]) => ({ id, name }),
  );

  const closedNote =
    filter === "closed" && data.closedShown >= CLOSED_TASKS_LOADED
      ? `The ${CLOSED_TASKS_LOADED} most recently closed tasks are loaded; older ones stay in the database.`
      : null;

  const emptyTrack = query.trim()
    ? "Nothing matches that search."
    : view.priorities.length > 0 || view.from || view.to
      ? "Nothing on this tab matches the priority or deadline filters — Clear shows everything."
      : filter === "closed"
      ? "Nothing done or dismissed yet."
      : filter === "mine"
        ? "Nothing is on you right now."
        : filter === "asked"
          ? `You have not handed anything out yet. Tag @${botName} and @-mention who it is for.`
          : `Nothing tracked yet. In a watched channel, tag your bot and @-mention who it is for — “@${botName} @name redo the thumbnail, deadline is 24 hours” — and it lands here as a card with a countdown.`;

  const screenKey = screen.kind === "person" || screen.kind === "tasks" ? screen.key : null;
  const screenIsSelf = screenKey !== null && viewer.selfId !== "" && screenKey === viewer.selfId;
  const screenTasks = useMemo(
    () => (screenKey === null ? [] : tasksOfPerson(tasks, screenKey, viewer)),
    [tasks, screenKey, viewer],
  );
  const screenRow = screenKey === null ? null : (people.find((p) => p.discord_user_id === screenKey) ?? null);
  const screenName = screenKey === null ? "" : screenIsSelf ? (data.profile.discord_username ?? "You") : nameOf(screenKey);
  const screenUsername = screenIsSelf
    ? data.profile.discord_username
    : (screenTasks.find((task) => task.assignee_name?.trim())?.assignee_name?.trim() ?? null);

  return (
    <TimeZoneContext.Provider value={timeZone}>
      <main className="main">
        <div className="page-head">
          <h1 className="mark">
            Task Tracker
            <span>{data.profile.discord_username ?? "LookUp Media"}</span>
          </h1>

          <div className="head-actions">
            {data.profile.avatar_url ? (
              <span className="who">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={data.profile.avatar_url} alt="" />
              </span>
            ) : null}
            {screen.kind !== "board" && discordReady ? (
              <button className="btn btn-sm" onClick={() => setScreen({ kind: "board" })}>
                <LayoutGrid /> Board
              </button>
            ) : null}
            {screen.kind !== "team" && discordReady ? (
              <button className="btn btn-sm" onClick={openTeam} title="Who is working on what, live">
                <Users /> Team
              </button>
            ) : null}
            {askable ? (
              <button
                className="btn btn-sm"
                onClick={() => setAskOpen((open) => !open)}
                aria-expanded={askOpen}
                title="Ask whether you already gave someone a task about something"
              >
                <MessageCircleQuestion /> Ask
              </button>
            ) : null}
            {/* Its own page: who may open whose history is the point (PO, 2026-10-09). */}
            <Link
              className="btn btn-sm"
              href="/scores"
              title={data.scoreAdmin ? "Everyone's points, and every entry behind them" : "Your points, and every entry behind them"}
            >
              <Trophy /> Scores
            </Link>
            {screen.kind !== "mine" ? (
              <button className="btn btn-sm" onClick={openMine} title="Everything given to you, from everyone">
                <Inbox /> My tasks{figures.assignedToMe > 0 ? ` (${figures.assignedToMe})` : ""}
              </button>
            ) : null}
            {/* Its own page: a past month is older than the closed work loaded here. */}
            <Link className="btn btn-sm" href="/summary" title="What was finished, month by month">
              <CalendarDays /> Monthly
            </Link>
            {/* The owner's list, one somebody named the viewer to keep, or their own ClickUp tasks. */}
            {discordReady || data.devListsKept > 0 || (data.clickupTasks ?? 0) > 0 ? (
              <Link className="btn btn-sm" href="/developers" title="Which developer is on what, live">
                <Laptop /> Developers
              </Link>
            ) : null}
            <button className="btn btn-sm" onClick={refresh} disabled={refreshing}>
              <RotateCw /> {refreshing ? "Refreshing" : "Refresh"}
            </button>
            <Link className="btn btn-sm" href="/settings">
              <Settings /> Settings
            </Link>
            <form action="/auth/signout" method="post">
              <button className="btn btn-sm" type="submit">
                Sign out
              </button>
            </form>
          </div>
        </div>

        {askOpen && askable ? (
          <AskPanel
            zone={timeZone}
            knownIds={knownIds}
            onOpenTask={(id) => {
              openTask(id);
              setAskOpen(false);
            }}
            onClose={() => setAskOpen(false)}
          />
        ) : null}

        {(!discordReady || !claudeReady || !watching) && screen.kind !== "mine" ? (
          <div className="notice">
            <strong>Not tracking yet</strong>
            <p style={{ margin: "0 0 10px" }}>
              {[
                !discordReady && "connect your Discord bot",
                !claudeReady && "add your Anthropic key",
                discordReady && !watching && "choose which channels to watch",
              ]
                .filter(Boolean)
                .join(", ")
                .replace(/, ([^,]*)$/, " and $1")}
              {" — "}until then nothing of yours is read. Tasks other people give you still show up here.
            </p>
            <Link className="btn btn-sm btn-primary" href="/settings">
              Open settings
            </Link>
          </div>
        ) : null}

        {/* The bot could not react in these channels. Their tags are still
            read and filed — so here, and only here, a missing ✅ does NOT mean
            unread. Said at the top of the board because the alternative is
            people tagging again and filing every task twice (Lucky35,
            2026-09-29). One re-invite per server fixes it. */}
        {blockedGuilds.length > 0 ? (
          <div className="notice">
            <strong>The bot cannot react everywhere</strong>
            <p style={{ margin: "0 0 10px" }}>
              In{" "}
              {data.reactionBlocked
                .map((channel) => `#${channel.channel_name ?? channel.channel_id}`)
                .join(", ")}{" "}
              your bot is not allowed to add ✅ or 👀. Tags there are still read and filed — no reaction
              there does not mean it was missed, so do not tag again; check the board. Invite the bot again
              to give it the permission:
            </p>
            <div className="notice-actions">
              {blockedGuilds.map((guild) =>
                data.connections?.discord_bot_user_id ? (
                  <a
                    key={guild.id}
                    className="btn btn-sm btn-primary"
                    href={botInviteUrl(data.connections.discord_bot_user_id, guild.id)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Invite again to {guild.name}
                  </a>
                ) : null,
              )}
            </div>
          </div>
        ) : null}

        {/* The board's own figures; My tasks shows the viewer's. */}
        {screen.kind !== "mine" && screen.kind !== "team" ? (
          <div className="figures">
            <div className="figure">
              <span className="v">{figures.open}</span>
              <span className="k">Open</span>
            </div>
            <div className="figure">
              <span className={`v ${figures.overdue > 0 ? "attention" : ""}`}>{figures.overdue}</span>
              <span className="k">Overdue</span>
            </div>
            <div className="figure">
              <span className={`v ${figures.today > 0 ? "warn" : ""}`}>{figures.today}</span>
              <span className="k">Due today</span>
            </div>
            <div className="figure">
              <span className="v">{figures.undated}</span>
              <span className="k">Need a deadline</span>
            </div>
            <div className="figure">
              <span className="v">{figures.unassigned}</span>
              <span className="k">Need an assignee</span>
            </div>
            <div className="figure">
              <span className="v">{figures.assignedToMe}</span>
              <span className="k">On you</span>
            </div>
            <div className="figure">
              <span className={`v ${figures.toReview > 0 ? "warn" : ""}`}>{figures.toReview}</span>
              <span className="k">To review</span>
            </div>
            <div className="figure">
              <span className="v">{data.messagesTracked}</span>
              <span className="k">Messages read</span>
            </div>
            <div className="figure">
              <span className="v">{data.watchedChannels}</span>
              <span className="k">Channels watched</span>
            </div>
          </div>
        ) : null}

        {error ? <p className="err">{error}</p> : null}

        {screen.kind === "board" ? (
          <>
            <div className="toolbar">
              <input
                className="field"
                placeholder="Search tasks and names…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="lens" role="group" aria-label="Which tasks">
                {BOARD_FILTERS.map((option) => (
                  <button
                    key={option.key}
                    data-on={filter === option.key}
                    aria-pressed={filter === option.key}
                    onClick={() => setFilter(option.key)}
                    title={option.title}
                  >
                    {option.label}
                    {option.key === "review" && figures.toReview > 0 ? ` (${figures.toReview})` : ""}
                  </button>
                ))}
              </div>
            </div>

            {/* Sort and filter, over whichever tab is open and the search —
                kept in this browser (Lucky35's PO, 2026-10-07). */}
            <div className="view-bar" role="group" aria-label="Sort and filter">
              <label className="view-field">
                <span>Sort</span>
                <select
                  className="field view-sort"
                  value={`${view.sort}:${view.dir}`}
                  onChange={(event) => {
                    const [sort, dir] = event.target.value.split(":");
                    setView((current) => parseView({ ...current, sort, dir }));
                  }}
                  aria-label="Sort by"
                >
                  {SORT_OPTIONS.map((option) => (
                    <option key={`${option.sort}:${option.dir}`} value={`${option.sort}:${option.dir}`}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="lens view-priority" role="group" aria-label="Priority">
                {PRIORITIES.map((option) => {
                  const on = view.priorities.includes(option.key);
                  return (
                    <button
                      key={option.key}
                      data-on={on}
                      aria-pressed={on}
                      data-priority={option.key}
                      title={on ? `Stop filtering to ${option.label}` : `Only ${option.label.toLowerCase()} priority`}
                      onClick={() =>
                        setView((current) => ({
                          ...current,
                          priorities: on ? current.priorities.filter((p) => p !== option.key) : [...current.priorities, option.key],
                        }))
                      }
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              <label className="view-field view-dates">
                <span>Due</span>
                <input
                  className="field view-date"
                  type="date"
                  value={view.from ?? ""}
                  onChange={(event) => setView((current) => parseView({ ...current, from: event.target.value || null }))}
                  aria-label={`Deadline from, in ${timeZone}`}
                />
                <span aria-hidden="true">–</span>
                <input
                  className="field view-date"
                  type="date"
                  value={view.to ?? ""}
                  onChange={(event) => setView((current) => parseView({ ...current, to: event.target.value || null }))}
                  aria-label={`Deadline to, in ${timeZone}`}
                />
              </label>
              {viewIsDefault(view) ? null : (
                <button className="btn btn-sm" onClick={() => setView(DEFAULT_VIEW)} title="Back to most urgent first, every task">
                  Clear
                </button>
              )}
            </div>

            <div className="board-split">
              <div className="board-main">
                <TaskTrack
                  tasks={visible}
                  focusId={focus}
                  viewer={viewer}
                  now={now}
                  nameOf={nameOf}
                  onFocus={setFocusId}
                  onOpenTask={openTask}
                  onOpenPerson={openPerson}
                  onOpenPersonTasks={openPersonTasks}
                  empty={emptyTrack}
                />
                {closedNote ? <p className="detail-hint closed-note">{closedNote}</p> : null}

                <section className="panel add-panel">
                  <div className="add-row">
                    <input
                      className="field"
                      placeholder="Add a task by hand…"
                      value={newTitle}
                      onChange={(event) => setNewTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void addTask();
                      }}
                    />
                    <select
                      className="field add-priority"
                      value={newPriority}
                      onChange={(event) => {
                        if (isPriority(event.target.value)) setNewPriority(event.target.value);
                      }}
                      aria-label="Priority of the new task"
                      title="Priority"
                    >
                      {PRIORITIES.map((option) => (
                        <option key={option.key} value={option.key}>
                          {option.label} priority
                        </option>
                      ))}
                    </select>
                    <button className="btn btn-primary btn-sm" onClick={addTask} disabled={!newTitle.trim()}>
                      <Plus /> Add
                    </button>
                  </div>
                </section>

                {/* Tagged, read, and deliberately not filed — thanks, chatter, a
                    question, a command the bot could not apply. Each got 👀 on
                    Discord. Folded, because it is the exception; one click turns
                    any of them into a card if the tracker got it wrong. */}
                {skippedTotal > 0 || skipped.length > 0 ? (
                  <details className="panel skipped">
                    <summary>
                      Not filed <span className="skipped-count">{skippedTotal}</span>
                      <span className="skipped-hint">
                        tagged and read, but not filed — each stays here until you file it or agree it is not a task
                      </span>
                    </summary>

                    {/* Search every unreviewed row on the server — the one
                        someone is hunting for may be far past the loaded pages. */}
                    <div className="skipped-find">
                      <input
                        className="field"
                        placeholder={`Find a message among all ${skippedTotal}…`}
                        value={findWords}
                        onChange={(event) => findSkipped(event.target.value)}
                        aria-label="Find a message that was not filed"
                      />
                    </div>

                    <ul className="skipped-list">
                      {(found ?? skipped).map((message) => (
                        <li className="skipped-item" key={message.id}>
                          <div className="skipped-body">
                            <p className="skipped-text">{stripMentions(message.content) || message.content}</p>
                            <p className="skipped-meta">
                              {message.author_name ?? "someone"} in {placeOf(message)} ·{" "}
                              {relativeTime(message.sent_at, now)} · {SKIP_LABELS[message.skip_category]}
                            </p>
                          </div>
                          <div className="skipped-actions">
                            <button className="btn btn-sm" onClick={() => fileSkipped(message)}>
                              <Plus /> {message.skip_category === "duplicate" ? "File it anyway" : "Make it a task"}
                            </button>
                            <button
                              className="btn btn-sm"
                              onClick={() => reviewSkipped([message])}
                              title="The tracker was right — take it off this list"
                            >
                              <Check /> Not a task
                            </button>
                            {message.jump_url ? (
                              <a
                                className="btn btn-sm"
                                href={message.jump_url}
                                target="_blank"
                                rel="noreferrer"
                                aria-label="Open in Discord"
                              >
                                <ExternalLink />
                              </a>
                            ) : null}
                          </div>
                        </li>
                      ))}
                      {found && found.length === 0 ? (
                        <li className="skipped-item">
                          <p className="skipped-meta">No message on this list has those words.</p>
                        </li>
                      ) : null}
                    </ul>

                    <div className="skipped-foot">
                      <span>
                        {found
                          ? found.length === NOT_FILED_PAGE
                            ? `The newest ${found.length} matches — add words to narrow it.`
                            : `${found.length} ${found.length === 1 ? "match" : "matches"} among all ${skippedTotal}.`
                          : skippedTotal > skipped.length
                            ? `Showing the newest ${skipped.length} of ${skippedTotal}.`
                            : `All ${skippedTotal} shown. Nothing leaves this list on its own.`}
                      </span>
                      <span className="skipped-foot-actions">
                        {!found && skippedTotal > skipped.length ? (
                          <button className="btn btn-sm" onClick={showOlder} disabled={olderLoading}>
                            {olderLoading ? "Loading…" : `Show older (${skippedTotal - skipped.length} more)`}
                          </button>
                        ) : null}
                        {(found ?? skipped).length > 0 ? (
                          <button className="btn btn-sm" onClick={clearSkipped}>
                            <Check /> {found ? "These matches are not tasks" : "None of these are tasks"}
                          </button>
                        ) : null}
                      </span>
                    </div>
                  </details>
                ) : null}
              </div>

              <aside className="board-detail" ref={detailRef}>
                {focused ? (
                  <TaskDetail
                    key={focused.id}
                    task={focused}
                    viewer={viewer}
                    now={now}
                    busy={Object.keys(busy).some((k) => k.includes(focused.id))}
                    known={known}
                    selfName={data.profile.discord_username}
                    nameOf={nameOf}
                    onUpdate={update}
                    onStatus={setStatus}
                    onStage={setStage}
                    onDelete={remove}
                    onAssigneeAction={assigneeAct}
                    onNotForThem={notForThem}
                    onNotMine={notMine}
                    reviews={reviews}
                    onUndo={undoTask}
                    scoreAdmin={data.scoreAdmin}
                    onRemind={remindTask}
                    onStart={startTask}
                    onDecide={decideTask}
                    onReport={reportTask}
                    onOpenPerson={openPerson}
                    onOpenPersonTasks={openPersonTasks}
                    siblings={siblingsOf(focused, tasks)}
                    onOpenTask={openTask}
                    mentionName={mentionName}
                  />
                ) : (
                  <div className="detail">
                    <p className="empty">The task in focus on the track opens here, in full.</p>
                  </div>
                )}
              </aside>
            </div>
          </>
        ) : screen.kind === "mine" ? (
          <MyTasks
            tasks={tasks}
            viewer={viewer}
            now={now}
            busy={(id) => Object.keys(busy).some((k) => k.includes(id))}
            hasBot={discordReady}
            onBack={() => setScreen({ kind: "board" })}
            onOpenTask={openTask}
            onDone={(task) => setStatus(task, "done")}
            onReport={reportTask}
            onStart={startTask}
            onAssigneeAction={assigneeAct}
            handoffs={handoffs}
          />
        ) : screen.kind === "team" ? (
          <TeamView
            tasks={tasks}
            scoreEntries={scoreEntries}
            scoresVisible={data.scoreAdmin}
            people={people}
            viewer={viewer}
            now={now}
            live={live}
            nameOf={(key) => nameOf(key)}
            avatarOf={(key) => people.find((p) => p.discord_user_id === key)?.avatar_url ?? null}
            onBack={() => setScreen({ kind: "board" })}
            onOpenTask={openTask}
            onOpenPerson={openPerson}
            onReview={() => {
              setQuery("");
              setFilter("review");
              setScreen({ kind: "board" });
            }}
          />
        ) : screen.kind === "person" ? (
          <PersonView
            key={screen.key}
            personKey={screen.key}
            name={screenName}
            handle={screenUsername ? `@${screenUsername}` : null}
            isSelf={screenIsSelf}
            avatarUrl={screenIsSelf ? data.profile.avatar_url : (screenRow?.avatar_url ?? null)}
            person={screenRow}
            tasks={screenTasks}
            scoreEntries={scoreEntries}
            scoresVisible={data.scoreAdmin || screenIsSelf}
            viewer={viewer}
            now={now}
            busy={Boolean(busy[`person:${screen.key}`])}
            onBack={() => setScreen({ kind: "board" })}
            onOpenTask={openTask}
            onOpenAllTasks={() => openPersonTasks(screen.key)}
            onNotes={(notes) => savePerson(screen.key, screenName.startsWith("@") ? "" : screenName, { notes })}
            onGrade={(grade) => savePerson(screen.key, screenName.startsWith("@") ? "" : screenName, { grade })}
          />
        ) : (
          <PersonTasks
            personKey={screen.key}
            name={screenName}
            isSelf={screenIsSelf}
            tasks={screenTasks}
            viewer={viewer}
            now={now}
            onBack={() => setScreen({ kind: "board" })}
            onOpenPerson={() => openPerson(screen.key)}
            onOpenTask={openTask}
          />
        )}
      </main>
    </TimeZoneContext.Provider>
  );
}
