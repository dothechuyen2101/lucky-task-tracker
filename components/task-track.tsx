"use client";

import { useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight, Lock } from "lucide-react";

import { useTimeZone } from "@/components/clock";
import { LiveCountdown } from "@/components/countdown";
import {
  type Viewer,
  isShared,
  missingOf,
  originLine,
  priorityOf,
  personColor,
  personOnCard,
  stepFocus,
  urgencyOf,
} from "@/lib/board";
import { closedLabel, awaitsReview } from "@/lib/review";
import type { Task } from "@/lib/types/database";

/**
 * The track: one card per task, sliding left and right, with the card in focus
 * held in the middle. The detail area beside it always shows that card —
 * `Tracker` owns the focus and hands it to both, so the two cannot disagree.
 *
 * Focus moves four ways, and all four end in `onFocus`:
 *   - scrolling or swiping the track: whichever card settles nearest the middle;
 *   - the arrow buttons, and ← / → with the track focused;
 *   - clicking a card's title ("open this task");
 *   - from outside — a filter, a search, a `?task=` link — in which case the
 *     track scrolls itself to the new card.
 *
 * A card carries exactly three things you can press: the task, the person's
 * name, and "All tasks". Marking done, dismissing and editing all happen in the
 * detail area, on the one task that is in focus.
 *
 * It writes nothing. Every change is raised to `Tracker`, which holds the one
 * write path in this app.
 */

type TaskTrackProps = {
  tasks: Task[];
  focusId: string | null;
  viewer: Viewer;
  now: Date;
  /** The label for a person key — "You" for the viewer. Resolved by the caller. */
  nameOf: (key: string, task: Task) => string;
  onFocus: (id: string) => void;
  onOpenTask: (id: string) => void;
  onOpenPerson: (key: string) => void;
  onOpenPersonTasks: (key: string) => void;
  /** Shown in place of the track when there is nothing on it. Says what to do next. */
  empty: string;
};

/** How long the track must sit still before a programmatic scroll counts as finished. */
const SETTLE_MS = 140;

/**
 * The longest a programmatic scroll is waited for. A scroll that goes nowhere —
 * already there, or clamped at an end — fires no scroll event at all, and
 * without this the track would keep ignoring the person's next swipe.
 */
const HEADING_LIMIT_MS = 900;

// One line, like every other component in this repo: a wrapped destructure
// closes with a `}` in column 0, which ends this function as far as any
// line-range tool is concerned and hides the body from it.
export function TaskTrack({ tasks, focusId, viewer, now, nameOf, onFocus, onOpenTask, onOpenPerson, onOpenPersonTasks, empty }: TaskTrackProps) {
  const scroller = useRef<HTMLDivElement | null>(null);
  // The card a programmatic scroll is heading for. While it is set, scroll
  // events are the animation passing over other cards, not the person choosing
  // them, so they must not move focus.
  const heading = useRef<string | null>(null);
  // The cards focus moved to BECAUSE of a scroll, oldest first. Scrolling the
  // track to one again would fight the person's own swipe mid-momentum. A
  // queue, not one slot: two frames of a fast swipe can both move focus before
  // the effect for the first runs, and a single slot then read the first as
  // "from elsewhere" and dragged the track back to it (2026-09-30 audit).
  const fromScroll = useRef<string[]>([]);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef<number>(0);
  // Set when focus was moved from the keyboard inside a card: the new card's
  // title takes DOM focus too, so Enter acts on the card that is in focus.
  const keyboardTo = useRef<string | null>(null);

  const ids = tasks.map((task) => task.id);
  const index = focusId === null ? -1 : ids.indexOf(focusId);
  // The order of the cards, as a value. The effect below keys on this rather
  // than on `tasks`, which is a new array every time the 30-second clock
  // re-sorts — re-centring on that would yank the track out from under a swipe.
  const order = ids.join(",");

  // The latest focus and callback, for timers set in an earlier render.
  const latest = useRef({ focusId, onFocus });
  useEffect(() => {
    latest.current = { focusId, onFocus };
  });

  /** Focus whichever card sits nearest the middle, if that is not the one in focus already. */
  function followScroll() {
    const box = scroller.current;
    if (!box) return;

    const middle = box.scrollLeft + box.clientWidth / 2;
    let nearest: string | null = null;
    let distance = Infinity;
    for (const card of box.querySelectorAll<HTMLElement>("[data-task-id]")) {
      const gap = Math.abs(card.offsetLeft + card.offsetWidth / 2 - middle);
      if (gap < distance) {
        distance = gap;
        nearest = card.dataset.taskId ?? null;
      }
    }

    if (nearest !== null && nearest !== latest.current.focusId) {
      fromScroll.current.push(nearest);
      latest.current.onFocus(nearest);
    }
  }

  /**
   * A programmatic scroll has finished — or given up. If the person swiped
   * somewhere else meanwhile, that swipe wins now instead of being swallowed.
   */
  function arrived() {
    heading.current = null;
    followScroll();
  }

  // Bring the focused card to the middle whenever focus changes from anywhere
  // but the scroll itself, or the cards around it change.
  useEffect(() => {
    const box = scroller.current;
    if (!box || focusId === null) return;

    const card = box.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(focusId)}"]`);
    if (keyboardTo.current === focusId) {
      keyboardTo.current = null;
      card?.querySelector<HTMLElement>(".tc-title")?.focus({ preventScroll: true });
    }

    const queued = fromScroll.current.indexOf(focusId);
    if (queued !== -1) {
      fromScroll.current = fromScroll.current.slice(queued + 1);
      return;
    }
    if (!card) return;

    // Clamped to what the track can actually scroll to; `.track` is
    // `position: relative`, so offsetLeft is measured from it.
    const max = box.scrollWidth - box.clientWidth;
    const left = Math.min(max, Math.max(0, card.offsetLeft + card.offsetWidth / 2 - box.clientWidth / 2));
    if (Math.abs(box.scrollLeft - left) < 2) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    heading.current = focusId;
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(arrived, HEADING_LIMIT_MS);
    box.scrollTo({ left, behavior: reduce ? "auto" : "smooth" });
    // `arrived` reads only refs and the latest props through them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, order]);

  useEffect(
    () => () => {
      if (settle.current) clearTimeout(settle.current);
      cancelAnimationFrame(frame.current);
    },
    [],
  );

  function onScroll() {
    if (heading.current !== null) {
      // Still travelling to the card focus was moved to. Wait for the track to
      // go quiet, then let the person's own scrolling take over again.
      if (settle.current) clearTimeout(settle.current);
      settle.current = setTimeout(arrived, SETTLE_MS);
      return;
    }

    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(followScroll);
  }

  function step(delta: number) {
    const next = stepFocus(ids, focusId, delta);
    if (next !== null) onFocus(next);
  }

  if (tasks.length === 0) {
    return (
      <section className="track-panel">
        <p className="empty">{empty}</p>
      </section>
    );
  }

  return (
    <section className="track-panel" aria-label="Tasks">
      <header className="track-head">
        <button className="track-step" onClick={() => step(-1)} disabled={index <= 0} aria-label="Previous task">
          <ChevronLeft />
        </button>
        <span className="track-count">
          {index + 1} / {tasks.length}
        </span>
        <button
          className="track-step"
          onClick={() => step(1)}
          disabled={index === -1 || index >= tasks.length - 1}
          aria-label="Next task"
        >
          <ChevronRight />
        </button>
      </header>

      <div
        className="track"
        ref={scroller}
        onScroll={onScroll}
        role="list"
        tabIndex={0}
        aria-label="Task cards — use the left and right arrow keys to move between them"
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
          event.preventDefault();
          const next = stepFocus(ids, focusId, event.key === "ArrowRight" ? 1 : -1);
          if (next === null) return;
          // From a button inside a card, DOM focus follows to the new card.
          if (event.target !== event.currentTarget) keyboardTo.current = next;
          onFocus(next);
        }}
      >
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            focused={task.id === focusId}
            viewer={viewer}
            now={now}
            nameOf={nameOf}
            onOpenTask={onOpenTask}
            onOpenPerson={onOpenPerson}
            onOpenPersonTasks={onOpenPersonTasks}
          />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

type TaskCardProps = {
  task: Task;
  focused: boolean;
  viewer: Viewer;
  now: Date;
  nameOf: (key: string, task: Task) => string;
  onOpenTask: (id: string) => void;
  onOpenPerson: (key: string) => void;
  onOpenPersonTasks: (key: string) => void;
};

/**
 * One task: the countdown, what it is, and who has it.
 *
 * What is missing is said on the card in the place the data would be — "No
 * deadline" where the countdown goes, "No assignee" where the name goes — so a
 * task that arrived incomplete is found by looking, not by opening it.
 */
function TaskCard({ task, focused, viewer, now, nameOf, onOpenTask, onOpenPerson, onOpenPersonTasks }: TaskCardProps) {
  const zone = useTimeZone();
  const shared = isShared(task, viewer);
  const missing = missingOf(task, viewer);
  const personKey = personOnCard(task, viewer);
  const closed = task.status !== "open";
  const origin = originLine(task, viewer);

  return (
    <article
      className="task-card"
      role="listitem"
      data-task-id={task.id}
      data-focused={focused}
      // Waiting for review is not finished: it is not dimmed as done.
      data-closed={closed && !awaitsReview(task)}
      aria-current={focused ? "true" : undefined}
      style={{ ["--task-color" as string]: task.color }}
    >
      <div className="tc-when">
        {closed ? (
          // A countdown on finished work is noise; say how it ended instead.
          <span className="tc-status" data-review={task.review_state === "pending"}>
            {closedLabel(task, shared, nameOf(personKey, task))}
          </span>
        ) : task.deadline ? (
          <LiveCountdown deadline={task.deadline} urgency={urgencyOf(task, now, zone)} now={now} />
        ) : (
          <span className="tc-missing">{missing.deadline ? "No deadline" : "No deadline set"}</span>
        )}
        {/* Medium says nothing: only a priority someone set stands out. */}
        {priorityOf(task) === "medium" ? null : (
          <span className="priority-pill" data-priority={priorityOf(task)} title={`${priorityOf(task) === "high" ? "High" : "Low"} priority`}>
            {priorityOf(task) === "high" ? "High" : "Low"}
          </span>
        )}
        {shared ? (
          <span
            className="tc-lock"
            role="img"
            aria-label={`On ${task.owner_name ?? "someone else"}'s board — only they can change it`}
            title={`On ${task.owner_name ?? "someone else"}'s board — only they can change it`}
          >
            <Lock aria-hidden="true" />
          </span>
        ) : null}
      </div>

      <button className="tc-title" onClick={() => onOpenTask(task.id)} title="Open this task">
        <span className="swatch" />
        <span className="tc-title-text">{task.title}</span>
      </button>

      <div className="tc-person">
        {shared && task.direction === "received" ? (
          // Asked by the viewer OF another board's owner: the owner has it.
          <>
            <span className="card-dot" style={{ background: personColor(task.user_id) }} />
            <span className="tc-name">{task.owner_name ?? "Its owner"}</span>
          </>
        ) : personKey !== "" ? (
          <>
            <span className="card-dot" style={{ background: personColor(personKey) }} />
            <button
              className="tc-name"
              onClick={() => onOpenPerson(personKey)}
              title={`Open ${nameOf(personKey, task)}`}
            >
              {nameOf(personKey, task)}
            </button>
            <button
              className="tc-all"
              onClick={() => onOpenPersonTasks(personKey)}
              title={`Everything given to ${nameOf(personKey, task)}`}
            >
              All tasks
            </button>
          </>
        ) : (
          <span className="tc-missing">No assignee</span>
        )}
      </div>

      {origin ? <p className="tc-origin">{origin}</p> : null}
    </article>
  );
}
