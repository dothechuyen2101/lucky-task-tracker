/**
 * Developers — which dev is on what, kept by hand. Pure, so it is testable.
 *
 * Lucky35's PO, 2026-10-05: one place that shows, live, what each developer
 * is working on and how it is going. The work itself lives in ClickUp; until
 * that is wired in, the board's owner and the people they name (Naukhaiz)
 * keep a row per developer here (`20261005_03_developers.sql`), and every
 * viewer sees each change the moment it is saved.
 *
 * Imported by client components: no network, no database, no clock.
 */

import type { DevEditor, Developer, DeveloperStatus } from "./types/database";

export const DEVELOPER_STATUSES: ReadonlyArray<{ key: DeveloperStatus; label: string; hint: string }> = [
  { key: "working", label: "Working", hint: "On it now" },
  { key: "blocked", label: "Blocked", hint: "Waiting on something or someone" },
  { key: "review", label: "In review", hint: "Done on their side, being checked" },
  { key: "idle", label: "Idle", hint: "Free for the next thing" },
  { key: "off", label: "Off", hint: "Not working today" },
];

export function statusLabel(status: DeveloperStatus): string {
  return DEVELOPER_STATUSES.find((s) => s.key === status)?.label ?? status;
}

/** The longest "working on" the database keeps. */
export const WORKING_ON_MAX = 500;

/** One owner's list, as the page shows it. */
export type DevList = {
  ownerId: string;
  /** "Your developers", or whose list it is. */
  title: string;
  /** The viewer's own list: they decide who else keeps it. */
  mine: boolean;
  developers: Developer[];
  /** Who else keeps it — the owner's own list only. */
  editors: DevEditor[];
};

/** In the order the owner set, then by name. */
export function sortDevelopers(rows: readonly Developer[]): Developer[] {
  return [...rows].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
}

/**
 * The lists the viewer sees: their own first — when they have a bot to hand
 * out work with, or have already started one — then each list somebody else
 * named them to keep, by owner name.
 */
export function devListsFor(
  viewerId: string,
  developers: readonly Developer[],
  editors: readonly DevEditor[],
  options: { ownListAnyway: boolean },
): DevList[] {
  const lists: DevList[] = [];
  const own = developers.filter((d) => d.owner_id === viewerId);
  const ownEditors = editors.filter((e) => e.owner_id === viewerId);
  if (options.ownListAnyway || own.length > 0 || ownEditors.length > 0) {
    lists.push({ ownerId: viewerId, title: "Your developers", mine: true, developers: sortDevelopers(own), editors: ownEditors });
  }

  const kept = new Map<string, string | null>();
  for (const editor of editors) if (editor.owner_id !== viewerId && !kept.has(editor.owner_id)) kept.set(editor.owner_id, editor.owner_name);
  const others = [...kept].map(([ownerId, ownerName]) => ({
    ownerId,
    title: `${ownerName ?? "Someone"}'s developers`,
    mine: false,
    developers: sortDevelopers(developers.filter((d) => d.owner_id === ownerId)),
    editors: [],
  }));
  return [...lists, ...others.sort((a, b) => a.title.localeCompare(b.title))];
}

/** On the list, and hidden from it (2026-10-12: someone ClickUp keeps finding is hidden, never deleted). */
export function shownDevelopers(rows: readonly Developer[]): Developer[] {
  return rows.filter((row) => !row.hidden_at);
}

export function hiddenDevelopers(rows: readonly Developer[]): Developer[] {
  return rows.filter((row) => Boolean(row.hidden_at));
}

/** How many on a list are in each state — the figures above it. */
export function statusCounts(rows: readonly Developer[]): Record<DeveloperStatus, number> {
  const counts: Record<DeveloperStatus, number> = { working: 0, blocked: 0, review: 0, idle: 0, off: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/** Where a new row goes: after the last one. */
export function nextSortOrder(rows: readonly Developer[]): number {
  return rows.reduce((max, row) => Math.max(max, row.sort_order), -1) + 1;
}
