/**
 * Developers, fed by ClickUp — pure, so it is testable.
 *
 * Lucky35's PO, 2026-10-12: the developers' work lives in ClickUp, where
 * Naukhaiz runs it. The worker reads EVERY task of the workspace — finished
 * ones too — into `tt_clickup_tasks` (`lib/clickup-sync.ts`), one row per
 * task, with ClickUp's own status names and colours: the team's words, not
 * ours. The managers (the list's owner and its keepers) read them all; each
 * developer reads their own (the database decides, `20261012_03`).
 *
 * ClickUp gives each status a kind: "custom" (being worked on: dev in
 * progress, code review, feedback in progress…), "unstarted" (blocked,
 * research phase, ready for dev…), "open" (to do), "done" (code merged, live)
 * and "closed" (complete). A developer's open work is shown first, being
 * worked on at the top; what is finished is under "Done", newest first.
 *
 * Imported by a client component: no network, no database, no clock.
 */

import type { ClickUpMember, ClickUpTask } from "./types/database";

/** A task as ClickUp's API returns it (`GET /team/{id}/task`), the parts read here. */
export type ClickUpTaskRaw = {
  id: string;
  name: string;
  url?: string | null;
  status?: { status?: string | null; color?: string | null; type?: string | null; orderindex?: number | string | null } | null;
  date_created?: string | number | null;
  date_updated?: string | number | null;
  date_done?: string | number | null;
  date_closed?: string | number | null;
  due_date?: string | number | null;
  list?: { id?: string | null; name?: string | null } | null;
  assignees?: Array<{ id?: number | string | null; username?: string | null }> | null;
};

/** A workspace as `GET /team` returns it, the parts read here. */
export type ClickUpTeamRaw = {
  id: string | number;
  name?: string | null;
  members?: Array<{ user?: { id?: number | string | null; username?: string | null; email?: string | null; initials?: string | null; color?: string | null } | null }> | null;
};

/** Finished, in ClickUp's own terms: under "Done", never as something they are on. */
export function isFinishedStatus(type: string | null | undefined): boolean {
  return type === "done" || type === "closed";
}

/** Being worked on, in ClickUp's own terms. */
export function isActiveStatus(type: string | null | undefined): boolean {
  return type === "custom";
}

const RANK: Record<string, number> = { custom: 0, unstarted: 1, open: 2, done: 3, closed: 4 };

function isoOf(ms: string | number | null | undefined): string | null {
  if (ms === null || ms === undefined || ms === "") return null;
  const value = typeof ms === "number" ? ms : Number(ms);
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}

/** A task as `tt_clickup_tasks` keeps it. `syncedAt` is when it was read. */
export function storedTask(raw: ClickUpTaskRaw, ownerId: string, syncedAt: string): ClickUpTask {
  const people = (raw.assignees ?? []).filter((person) => /^[0-9]+$/.test(String(person?.id ?? "")));
  const type = raw.status?.type ?? "";
  return {
    owner_id: ownerId,
    id: raw.id,
    name: raw.name,
    url: raw.url || `https://app.clickup.com/t/${raw.id}`,
    status: (raw.status?.status ?? "").trim().toLowerCase(),
    color: raw.status?.color ?? null,
    type,
    orderindex: Number(raw.status?.orderindex ?? 0) || 0,
    list: raw.list?.name ?? null,
    assignee_ids: people.map((person) => String(person.id)),
    assignee_names: people.map((person) => (person.username ?? "").trim() || `ClickUp ${person.id}`),
    created_at: isoOf(raw.date_created),
    updated_at: isoOf(raw.date_updated),
    done_at: isFinishedStatus(type) ? (isoOf(raw.date_done) ?? isoOf(raw.date_closed) ?? isoOf(raw.date_updated)) : null,
    due_at: isoOf(raw.due_date),
    synced_at: syncedAt,
  };
}

const CONTENT: ReadonlyArray<keyof ClickUpTask> = [
  "name", "url", "status", "color", "type", "orderindex", "list", "assignee_ids", "assignee_names", "created_at", "updated_at", "done_at", "due_at",
];

/** Whether the stored row already says this — the worker writes only a change, so Realtime carries only news. */
export function sameTask(stored: Partial<ClickUpTask> | null | undefined, next: ClickUpTask): boolean {
  if (!stored) return false;
  const time = (value: unknown) => (typeof value === "string" ? Date.parse(value) : value);
  return CONTENT.every((key) => {
    const a = stored[key];
    const b = next[key];
    if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
    if (key.endsWith("_at")) return (time(a) ?? null) === (time(b) ?? null);
    return (a ?? null) === (b ?? null);
  });
}

/** Every person's tasks, by ClickUp id — a task with two people on it is on both. */
export function tasksByPerson(tasks: readonly ClickUpTask[]): Map<string, ClickUpTask[]> {
  const byPerson = new Map<string, ClickUpTask[]>();
  for (const task of tasks) {
    for (const id of task.assignee_ids) {
      const theirs = byPerson.get(id);
      if (theirs) theirs.push(task);
      else byPerson.set(id, [task]);
    }
  }
  return byPerson;
}

const time = (iso: string | null) => (iso ? Date.parse(iso) : 0);

/**
 * One person's tasks, split as the page shows them: what is open — being
 * worked on first, then further along before less far (the status's place in
 * its list), then the most recently touched — and what is done, newest first.
 */
export function splitTasks(tasks: readonly ClickUpTask[] | null | undefined): { open: ClickUpTask[]; done: ClickUpTask[] } {
  const seen = new Set<string>();
  const once = (tasks ?? []).filter((task) => !seen.has(task.id) && Boolean(seen.add(task.id)));
  const open = once
    .filter((task) => !isFinishedStatus(task.type))
    .sort(
      (a, b) =>
        (RANK[a.type] ?? 5) - (RANK[b.type] ?? 5) ||
        b.orderindex - a.orderindex ||
        time(b.updated_at) - time(a.updated_at) ||
        a.id.localeCompare(b.id),
    );
  const done = once
    .filter((task) => isFinishedStatus(task.type))
    .sort((a, b) => time(b.done_at ?? b.updated_at) - time(a.done_at ?? a.updated_at) || a.id.localeCompare(b.id));
  return { open, done };
}

/** When ClickUp last moved anything of theirs. */
export function lastClickUpChange(tasks: readonly ClickUpTask[] | null | undefined): string | null {
  let newest: string | null = null;
  for (const task of tasks ?? []) if (task.updated_at && (!newest || time(task.updated_at) > time(newest))) newest = task.updated_at;
  return newest;
}

/**
 * Who has unfinished work assigned in ClickUp — the developers the list finds
 * by itself (2026-10-12). Named as the workspace knows them, else as the task
 * does (a guest is not among the members, but can be given work).
 */
export function peopleWithOpenWork(tasks: readonly ClickUpTask[], members: readonly ClickUpMember[]): ClickUpMember[] {
  const named = new Map(members.map((member) => [member.id, member]));
  const found = new Map<string, ClickUpMember>();
  for (const task of tasks) {
    if (isFinishedStatus(task.type)) continue;
    task.assignee_ids.forEach((id, index) => {
      if (found.has(id)) return;
      found.set(id, named.get(id) ?? { id, name: task.assignee_names[index] || `ClickUp ${id}`, initials: null, color: null });
    });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Those of them with no row on the list yet — a hidden row counts as a row: hidden stays hidden. */
export function newDevelopers(people: readonly ClickUpMember[], linked: Iterable<string | null | undefined>): ClickUpMember[] {
  const have = new Set([...linked].filter(Boolean));
  return people.filter((person) => !have.has(person.id));
}

// --- who a signed-in person is in ClickUp (2026-10-12) ----------------------

/** A ClickUp member's email, read in the worker only — never stored, never shown. */
export function memberEmailsOf(team: ClickUpTeamRaw): Array<{ id: string; email: string }> {
  const found: Array<{ id: string; email: string }> = [];
  for (const member of team.members ?? []) {
    const user = member?.user;
    const email = (user?.email ?? "").trim().toLowerCase();
    if (user && user.id !== null && user.id !== undefined && email) found.push({ id: String(user.id), email });
  }
  return found;
}

/**
 * Who signs in as whom, by EXACT email: a verified Discord email equal to the
 * ClickUp email of exactly one member, held by exactly one tracker identity.
 * Anything less certain is left for a manager to link by hand — a name that
 * only looks right is the wrong person (AGENTS.md).
 */
export function linksByEmail(
  members: ReadonlyArray<{ id: string; email: string }>,
  identities: ReadonlyArray<{ discord_id: string; email: string | null; name: string | null }>,
): Array<{ clickupId: string; discordId: string; name: string | null }> {
  const count = <T,>(items: readonly T[], key: (item: T) => string) => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
    return counts;
  };
  const clean = identities.filter((identity) => (identity.email ?? "").trim() !== "").map((identity) => ({ ...identity, email: identity.email!.trim().toLowerCase() }));
  const memberCount = count(members, (member) => member.email);
  const identityCount = count(clean, (identity) => identity.email);
  const links: Array<{ clickupId: string; discordId: string; name: string | null }> = [];
  for (const member of members) {
    if (memberCount.get(member.email) !== 1 || identityCount.get(member.email) !== 1) continue;
    const identity = clean.find((candidate) => candidate.email === member.email)!;
    links.push({ clickupId: member.id, discordId: identity.discord_id, name: identity.name });
  }
  return links;
}

// --- what the statuses mean, and filtering by them (PO, 2026-10-12) --------
//
// Lucky35 asked what "BLOCKED" and "CODE REVIEW" mean; Naukhaiz asked for a
// list to filter by. The statuses are the team's own (LOOKUP MEDIA's lists),
// in the order work moves through them; one not listed here is explained by
// its kind, so a status added in ClickUp tomorrow still says something true.

const STATUS_MEANINGS: ReadonlyArray<[string, string]> = [
  ["dev in progress", "Being coded now."],
  ["code review", "The code is finished and waiting for someone to check it."],
  ["code feedback", "The review asked for changes; they have not been started yet."],
  ["feedback in progress", "Making the changes the review or the client asked for."],
  ["code approved", "The review passed; waiting to be merged."],
  ["blocked", "Cannot move forward right now — waiting on something or someone."],
  ["research phase", "Working out how to do it, before any code is written."],
  ["ready for dev", "Planned and ready to start; coding has not begun."],
  ["to do", "Not started yet."],
  ["info card", "A reference card, not a piece of work."],
  ["code merged", "Done: merged into the main code, on its way live."],
  ["live", "Done: shipped and live."],
  ["complete", "Done and closed in ClickUp."],
];

const BY_KIND: Record<string, string> = {
  custom: "Being worked on.",
  unstarted: "Not started yet.",
  open: "Not started yet.",
  done: "Done.",
  closed: "Done and closed.",
};

const ORDER = new Map(STATUS_MEANINGS.map(([status], index) => [status, index]));

const normal = (status: string) => status.trim().toLowerCase();

/** What a ClickUp status means, in a sentence. */
export function statusMeaning(status: string, type: string): string {
  const known = STATUS_MEANINGS.find(([name]) => name === normal(status));
  return known ? known[1] : (BY_KIND[type] ?? "A status set in ClickUp.");
}

export type StatusCount = { status: string; color: string | null; type: string; count: number };

/** Every status among these tasks, with how many are in it — each task once, in the order work moves through them. */
export function clickUpStatusCounts(tasks: ReadonlyArray<Pick<ClickUpTask, "id" | "status" | "color" | "type">>): StatusCount[] {
  const seen = new Set<string>();
  const counts = new Map<string, StatusCount>();
  for (const task of tasks) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    const key = normal(task.status);
    if (!key) continue;
    const known = counts.get(key);
    if (known) known.count += 1;
    else counts.set(key, { status: key, color: task.color, type: task.type, count: 1 });
  }
  const rank = (s: StatusCount) => RANK[s.type] ?? 5;
  const place = (s: StatusCount) => ORDER.get(s.status) ?? Number.MAX_SAFE_INTEGER;
  return [...counts.values()].sort((a, b) => rank(a) - rank(b) || place(a) - place(b) || a.status.localeCompare(b.status));
}

/** The tasks in the picked statuses — all of them when none is picked. */
export function tasksInStatuses<T extends { status: string }>(tasks: readonly T[] | null | undefined, picked: readonly string[]): T[] {
  if (picked.length === 0) return [...(tasks ?? [])];
  const wanted = new Set(picked.map(normal));
  return (tasks ?? []).filter((task) => wanted.has(normal(task.status)));
}

/** The Developers page's own view, as kept in the browser — anything unreadable is the default. */
export type DevView = { statuses: string[]; legend: boolean };

export const DEFAULT_DEV_VIEW: DevView = { statuses: [], legend: true };

export function parseDevView(raw: unknown): DevView {
  if (!raw || typeof raw !== "object") return DEFAULT_DEV_VIEW;
  const value = raw as { statuses?: unknown; legend?: unknown };
  const statuses = Array.isArray(value.statuses)
    ? [...new Set(value.statuses.filter((s): s is string => typeof s === "string" && s.trim() !== "").map(normal))].slice(0, 20)
    : [];
  return { statuses, legend: typeof value.legend === "boolean" ? value.legend : true };
}

/** The people in a workspace, by name — never their email. */
export function clickUpMembersOf(team: ClickUpTeamRaw): ClickUpMember[] {
  const people: ClickUpMember[] = [];
  for (const member of team.members ?? []) {
    const user = member?.user;
    if (!user || user.id === null || user.id === undefined) continue;
    const name = (user.username ?? "").trim() || `ClickUp ${user.id}`;
    people.push({ id: String(user.id), name, initials: user.initials ?? null, color: user.color ?? null });
  }
  return people.sort((a, b) => a.name.localeCompare(b.name));
}
