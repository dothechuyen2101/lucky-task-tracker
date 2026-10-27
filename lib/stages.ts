/**
 * The five progress stages, in order. `stage` on a task is an ordinal:
 * 0 means nothing started, N means stages 1..N are reached.
 *
 * Deliberately the same shape as `vdm-project-manager/lib/stages.ts` — Luka
 * reads both boards, and a rail that behaves differently in two tools is worse
 * than no rail. Same click-the-current-stage-to-step-back rule, same ordinal
 * semantics, same "the machine never guesses a stage" rule.
 */
export const STAGES = [
  { ordinal: 1, key: "started", label: "Started", short: "Started" },
  { ordinal: 2, key: "in_progress", label: "In progress", short: "Progress" },
  { ordinal: 3, key: "testing", label: "Testing", short: "Testing" },
  { ordinal: 4, key: "completed", label: "Completed", short: "Done" },
  { ordinal: 5, key: "closed", label: "Closed", short: "Closed" },
] as const;

export type Stage = (typeof STAGES)[number];
export type StageKey = Stage["key"];

export const MIN_STAGE = 0;
export const MAX_STAGE = STAGES.length;

/**
 * Reaching this stage means the work is finished, which must also stop the
 * reminders — a task that still pings after you marked it Completed is the
 * fastest way to make people stop trusting the tracker.
 *
 * This is the single place that mapping lives, so the rail and the `status`
 * column can never disagree about whether something is done.
 */
export const DONE_FROM_STAGE = 4;

/**
 * Someone is working on it. The assignee can move a task here themselves
 * ("I'm on it"), which is what the board's Team view reads as "working on"
 * (Lucky35, 2026-10-04); work sent back after review lands here too.
 */
export const IN_PROGRESS_STAGE = 2;

export function isDoneStage(stage: number): boolean {
  return stage >= DONE_FROM_STAGE;
}

export function stageByKey(key: string): Stage | undefined {
  return STAGES.find((s) => s.key === key);
}

export function stageLabel(stage: number): string {
  return STAGES.find((s) => s.ordinal === stage)?.label ?? "Not started";
}

/**
 * Resolve a stage supplied as either an ordinal (0..5) or a key ("in progress",
 * "testing", "closed"). Returns null when it means nothing — callers surface
 * that as an error rather than silently writing stage 0.
 */
export function resolveStage(value: number | string): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= MIN_STAGE && value <= MAX_STAGE ? value : null;
  }

  const raw = value.trim().toLowerCase();
  if (raw === "") return null;
  if (/^\d+$/.test(raw)) return resolveStage(Number(raw));
  if (raw === "none" || raw === "not started") return 0;

  const normalised = raw.replace(/[\s-]+/g, "_");
  const direct = STAGES.find((s) => s.key === normalised);
  if (direct) return direct.ordinal;

  const byLabel = STAGES.find(
    (s) =>
      s.label.toLowerCase() === raw ||
      s.short.toLowerCase() === raw ||
      s.label.toLowerCase().replace(/[\s-]+/g, "_") === normalised,
  );
  return byLabel ? byLabel.ordinal : null;
}

/** Percentage complete, for a group's progress bar. */
export function stagePercent(stage: number): number {
  return Math.round((Math.min(Math.max(stage, 0), MAX_STAGE) / MAX_STAGE) * 100);
}

/**
 * The stage_at map, trimmed to a new stage. Stepping back forgets the
 * timestamps of stages you undid, so the record never claims you reached
 * something you then reversed.
 */
export function stampStages(
  existing: Record<string, string> | null | undefined,
  nextStage: number,
  now: string,
): Record<string, string> {
  const stamped: Record<string, string> = {};

  for (const [key, value] of Object.entries(existing ?? {})) {
    if (Number(key) <= nextStage) stamped[key] = value;
  }
  for (let n = 1; n <= nextStage; n += 1) {
    if (!stamped[String(n)]) stamped[String(n)] = now;
  }

  return stamped;
}
