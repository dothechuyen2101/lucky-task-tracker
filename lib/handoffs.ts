/**
 * A task handed from one person to another — what the person it was taken
 * from is told, and what their board shows. Pure, so it is testable.
 *
 * Lucky35's PO, 2026-10-04: "Reassigning a task leaves it sitting on the old
 * dev's list with no sign it's stale." The database records every change of
 * assignee (`tt_task_handoffs`, by trigger), readable by the person it was
 * taken from. From that: their open board drops the task the moment it
 * happens (`dropHandedOff` — the task's own UPDATE never reaches someone who
 * can no longer read it), My tasks lists it under "Moved off you"
 * (`movedOffMe`), and the worker DMs them once (`handoffDecision`).
 *
 * Imported by client components: no network, no database, no clock.
 */

import { type Viewer, isShared } from "@/lib/board";
import type { Task, TaskHandoff } from "@/lib/types/database";

/** How long a task taken off someone stays on their My tasks, saying so. */
export const MOVED_OFF_DAYS = 14;

/**
 * Whether the person a task was taken from is DMed about it. Not when they
 * never heard it was theirs, when the giver moved their own work, when it is
 * closed or gone, or when it is back on them by now — `tellAssignees` tells
 * them that, and one "it's yours" is enough.
 */
export function handoffDecision(
  handoff: Pick<TaskHandoff, "from_discord_id" | "from_was_told" | "task_open">,
  ownerDiscordId: string | null,
  current: Pick<Task, "assignee_discord_id" | "status"> | null,
): "dm" | "quiet" {
  if (!handoff.from_was_told || !handoff.task_open) return "quiet";
  if (ownerDiscordId && handoff.from_discord_id === ownerDiscordId) return "quiet";
  if (!current || current.status !== "open") return "quiet";
  if (current.assignee_discord_id === handoff.from_discord_id) return "quiet";
  return "dm";
}

/** The DM to the person a task was taken from. */
export function handoffNotice(title: string, giverName: string | null, toName: string | null): string {
  const giver = giverName ? `**${giverName}**` : "Whoever gave it to you";
  const where = toName ? `moved **${title}** to ${toName}` : `took **${title}** off you`;
  return `↪️ ${giver} ${where} — it is no longer on you, and you will get no more reminders about it.`;
}

/**
 * My tasks' "Moved off you": what was taken off the viewer lately, newest
 * first, once per task — and not a task that is on them again.
 */
export function movedOffMe(handoffs: readonly TaskHandoff[], tasks: readonly Task[], viewer: Viewer, now: Date): TaskHandoff[] {
  if (viewer.selfId === "") return [];
  const since = now.getTime() - MOVED_OFF_DAYS * 86_400_000;
  const mineAgain = new Set(tasks.filter((task) => task.assignee_discord_id === viewer.selfId).map((task) => task.id));
  const newest = new Map<string, TaskHandoff>();
  for (const handoff of handoffs) {
    if (handoff.from_discord_id !== viewer.selfId || mineAgain.has(handoff.task_id)) continue;
    if (Date.parse(handoff.moved_at) < since) continue;
    const held = newest.get(handoff.task_id);
    if (!held || Date.parse(handoff.moved_at) > Date.parse(held.moved_at)) newest.set(handoff.task_id, handoff);
  }
  return [...newest.values()].sort((a, b) => Date.parse(b.moved_at) - Date.parse(a.moved_at));
}

/**
 * A handoff just arrived (Realtime): drop the task it moved off the viewer —
 * a row from someone else's account they can no longer read, whose own UPDATE
 * will never reach them. Their own rows are left to their own events, and a
 * task handed back TO the viewer stays.
 */
export function dropHandedOff(tasks: readonly Task[], handoff: TaskHandoff, viewer: Viewer): Task[] {
  if (viewer.selfId === "" || handoff.from_discord_id !== viewer.selfId) return tasks as Task[];
  if (handoff.to_discord_id === viewer.selfId) return tasks as Task[];
  const task = tasks.find((candidate) => candidate.id === handoff.task_id);
  if (!task || !isShared(task, viewer)) return tasks as Task[];
  // Still theirs to read: they asked for it (`askedByViewer`).
  if (task.requested_by_discord_id === viewer.selfId) return tasks as Task[];
  return tasks.filter((candidate) => candidate.id !== handoff.task_id);
}
