import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  type ClickUpTaskRaw,
  type ClickUpTeamRaw,
  clickUpMembersOf,
  linksByEmail,
  memberEmailsOf,
  newDevelopers,
  peopleWithOpenWork,
  sameTask,
  storedTask,
} from "@/lib/clickup";
import type { ClickUpMember, ClickUpTask } from "@/lib/types/database";

/**
 * Developers, fed by ClickUp — the network half (`lib/clickup.ts` is the pure
 * one). Lucky35's PO, 2026-10-12.
 *
 * One ClickUp token from the server's environment, scoped three ways so it
 * can never feed anything else:
 *
 *   CLICKUP_API_KEY            a personal token (`pk_…`) of someone in the
 *                              workspace — Naukhaiz's — read here and nowhere
 *                              else; it never reaches a browser
 *   CLICKUP_WORKSPACE_ID       the workspace it reads (LOOKUP MEDIA)
 *   CLICKUP_DEVELOPERS_OWNER   the tracker account whose Developers list it
 *                              feeds — Lucky35's — and no one else's
 *
 * Every minute the worker reads the workspace's tasks — ALL of them, finished
 * ones too (2026-10-12) — into `tt_clickup_tasks`, one row per task, written
 * only when it changed, so Realtime carries news, not noise. Every
 * `FULL_EVERY_MS` it reads every task and drops those gone from ClickUp; in
 * between, only what changed since the last read. Whoever has unfinished work
 * and no row on the list yet gets one, already linked ("why only Tom and
 * Leo?") — nobody is ever taken off by the sync; the keeper hides instead.
 *
 * The workspace's people are read every `MEMBERS_EVERY_MS`: their names, for
 * picking who a row is, and — in memory only, never stored — their emails, to
 * link a row to the Discord person who signs in as them when a VERIFIED
 * Discord email is exactly theirs (`linksByEmail`). How the last read went is
 * kept in `tt_clickup_state`, which the page shows — a failed read is never
 * silent.
 */

const API = "https://api.clickup.com/api/v2";

/** How often the workspace's people are read again. */
const MEMBERS_EVERY_MS = 10 * 60_000;

/** One page is 100 tasks; this many pages is a ceiling, not a target. */
const MAX_PAGES = 50;

/** How often every task is read again — and the ones gone from ClickUp dropped. */
const FULL_EVERY_MS = 10 * 60_000;

/** Read back this far before the last read, so a clock apart from ClickUp's misses nothing. */
const SINCE_MARGIN_MS = 5 * 60_000;

/** Rows written or dropped in one request. */
const CHUNK = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ClickUpConfig = { token: string; workspaceId: string; ownerId: string };

/** The link, when all three are set and look right; otherwise none at all. */
export function clickUpConfig(env: Record<string, string | undefined> = process.env): ClickUpConfig | null {
  const token = (env.CLICKUP_API_KEY ?? "").trim();
  const workspaceId = (env.CLICKUP_WORKSPACE_ID ?? "").trim();
  const ownerId = (env.CLICKUP_DEVELOPERS_OWNER ?? "").trim();
  if (!token || !/^[0-9]+$/.test(workspaceId) || !UUID.test(ownerId)) return null;
  return { token, workspaceId, ownerId };
}

export class ClickUpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(token: string, path: string, params?: URLSearchParams): Promise<T> {
  const response = await fetch(`${API}${path}${params ? `?${params}` : ""}`, {
    headers: { Authorization: token },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { err?: string; ECODE?: string };
    const why = body.err ? `${body.err}${body.ECODE ? ` (${body.ECODE})` : ""}` : response.statusText;
    throw new ClickUpError(`ClickUp ${response.status}: ${why}`, response.status);
  }
  return (await response.json()) as T;
}

/** The workspace, if the token can see it. A token that cannot is said so plainly. */
async function workspaceOf(config: ClickUpConfig): Promise<ClickUpTeamRaw> {
  const { teams } = await call<{ teams?: ClickUpTeamRaw[] }>(config.token, "/team");
  const team = (teams ?? []).find((t) => String(t.id) === config.workspaceId);
  if (!team) {
    throw new ClickUpError(
      `The ClickUp token cannot see workspace ${config.workspaceId}. Use a token of someone who is a full member of it.`,
      403,
    );
  }
  return team;
}

/**
 * Every task in the workspace, finished and closed ones too — or only those
 * changed since `since`. `complete` is false when the page ceiling cut it
 * short, so nothing is dropped on a partial read.
 */
async function readTasks(config: ClickUpConfig, since: number | null): Promise<{ tasks: ClickUpTaskRaw[]; complete: boolean }> {
  const tasks: ClickUpTaskRaw[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ page: String(page), include_closed: "true", subtasks: "true", order_by: "updated" });
    if (since !== null) params.set("date_updated_gt", String(since));
    const answer = await call<{ tasks?: ClickUpTaskRaw[]; last_page?: boolean }>(config.token, `/team/${config.workspaceId}/task`, params);
    const found = answer.tasks ?? [];
    tasks.push(...found);
    if (answer.last_page === true || found.length < 100) return { tasks, complete: true };
  }
  return { tasks, complete: false };
}

/** Every stored task of the list, page by page — Supabase stops at 1000 rows without a word (AGENTS.md). */
async function storedTasks(db: SupabaseClient, ownerId: string): Promise<ClickUpTask[]> {
  const rows: ClickUpTask[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("tt_clickup_tasks")
      .select("*")
      .eq("owner_id", ownerId)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`tasks: ${error.message}`);
    rows.push(...((data ?? []) as ClickUpTask[]));
    if ((data ?? []).length < 1000) return rows;
  }
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

type Summary = { errors: string[] };

type Row = { id: string; clickup_user_id: string | null; discord_user_id: string | null; hidden_at: string | null; sort_order: number };

type State = {
  workspace_id: string;
  members: ClickUpMember[] | null;
  members_at: string | null;
  tasks_full_at: string | null;
  tasks_synced_at: string | null;
};

/**
 * Link rows to the Discord person who signs in as them, by exact verified
 * email — only rows nobody linked yet, and never a Discord person already on
 * the list. A failure costs only the links: a manager can still link by hand.
 */
async function linkByEmail(db: SupabaseClient, summary: Summary, config: ClickUpConfig, team: ClickUpTeamRaw, rows: readonly Row[]): Promise<void> {
  const { data, error } = await db.rpc("tt_tracker_identities");
  if (error) {
    summary.errors.push(`clickup: matching sign-ins by email: ${error.message}`);
    return;
  }
  const taken = new Set(rows.map((row) => row.discord_user_id).filter(Boolean));
  const identities = (data ?? []) as Array<{ discord_id: string; email: string | null; name: string | null }>;
  for (const link of linksByEmail(memberEmailsOf(team), identities)) {
    const row = rows.find((candidate) => candidate.clickup_user_id === link.clickupId);
    if (!row || row.discord_user_id || taken.has(link.discordId)) continue;
    const { error: linkError } = await db
      .from("tt_developers")
      .update({ discord_user_id: link.discordId, discord_name: link.name })
      .eq("id", row.id)
      .is("discord_user_id", null);
    if (linkError) summary.errors.push(`clickup: linking ${row.id}: ${linkError.message}`);
    else taken.add(link.discordId);
  }
}

/**
 * One read of ClickUp for the list it feeds. Never throws: a failure is
 * written on `tt_clickup_state` for the page, and in the run's log.
 */
export async function syncClickUp(db: SupabaseClient, summary: Summary, now: Date, config = clickUpConfig()): Promise<void> {
  if (!config) return;
  const stamp = now.toISOString();
  try {
    const { data: state, error: stateError } = await db
      .from("tt_clickup_state")
      .select("workspace_id, members, members_at, tasks_full_at, tasks_synced_at")
      .eq("owner_id", config.ownerId)
      .maybeSingle();
    if (stateError) throw new Error(`state: ${stateError.message}`);
    const known = state as State | null;
    const sameWorkspace = known?.workspace_id === config.workspaceId;

    const { data: rows, error: rowsError } = await db
      .from("tt_developers")
      .select("id, clickup_user_id, discord_user_id, hidden_at, sort_order")
      .eq("owner_id", config.ownerId);
    if (rowsError) throw new Error(`developers: ${rowsError.message}`);
    const list = (rows ?? []) as Row[];

    // The workspace's people: names kept, emails used here and dropped.
    let members = known?.members ?? [];
    const membersDue = !known || !sameWorkspace || !known.members_at || now.getTime() - Date.parse(known.members_at) >= MEMBERS_EVERY_MS;
    if (membersDue) {
      const team = await workspaceOf(config);
      members = clickUpMembersOf(team);
      const { error } = await db.from("tt_clickup_state").upsert(
        { owner_id: config.ownerId, workspace_id: config.workspaceId, workspace_name: team.name ?? null, members, members_at: stamp },
        { onConflict: "owner_id" },
      );
      if (error) throw new Error(`state: ${error.message}`);
      await linkByEmail(db, summary, config, team, list);
    }

    // Every task now and then, otherwise what changed since the last read.
    const full = !sameWorkspace || !known?.tasks_full_at || !known.tasks_synced_at || now.getTime() - Date.parse(known.tasks_full_at) >= FULL_EVERY_MS;
    const since = full ? null : Date.parse(known!.tasks_synced_at!) - SINCE_MARGIN_MS;
    const read = await readTasks(config, since);
    const fresh = read.tasks.map((raw) => storedTask(raw, config.ownerId, stamp));

    const stored = await storedTasks(db, config.ownerId);
    const byId = new Map(stored.map((task) => [task.id, task]));
    const changed = fresh.filter((task) => !sameTask(byId.get(task.id), task));
    for (const part of chunks(changed)) {
      const { error } = await db.from("tt_clickup_tasks").upsert(part, { onConflict: "owner_id,id" });
      if (error) throw new Error(`writing tasks: ${error.message}`);
    }
    // Gone from ClickUp (deleted, archived, moved out): dropped — only after a
    // whole read, never on a partial one.
    if (full && read.complete) {
      const seen = new Set(fresh.map((task) => task.id));
      const gone = stored.filter((task) => !seen.has(task.id)).map((task) => task.id);
      for (const part of chunks(gone)) {
        const { error } = await db.from("tt_clickup_tasks").delete().eq("owner_id", config.ownerId).in("id", part);
        if (error) throw new Error(`dropping tasks: ${error.message}`);
      }
    }

    // Whoever has unfinished work and no row yet — a hidden row counts, so a
    // hidden person stays hidden. The index on (owner, ClickUp person) makes a
    // row the keeper added meanwhile win; nothing is added twice.
    const current = new Map(stored.map((task) => [task.id, task]));
    for (const task of fresh) current.set(task.id, task);
    const missing = newDevelopers(peopleWithOpenWork([...current.values()], members), list.map((row) => row.clickup_user_id));
    if (missing.length > 0) {
      let order = list.reduce((max, row) => Math.max(max, row.sort_order), -1);
      const { error } = await db.from("tt_developers").upsert(
        missing.map((person) => ({
          owner_id: config.ownerId,
          name: person.name.slice(0, 80),
          clickup_user_id: person.id,
          added_from: "clickup",
          sort_order: (order += 1),
        })),
        { onConflict: "owner_id,clickup_user_id", ignoreDuplicates: true },
      );
      if (error) throw new Error(`adding developers: ${error.message}`);
    }

    await db
      .from("tt_clickup_state")
      .update({
        synced_at: stamp,
        tasks_synced_at: stamp,
        ...(full && read.complete ? { tasks_full_at: stamp } : {}),
        error: null,
        error_at: null,
      })
      .eq("owner_id", config.ownerId);
  } catch (caught) {
    const why = caught instanceof Error ? caught.message : String(caught);
    summary.errors.push(`clickup: ${why}`);
    // Said where the list is shown; a state row is made if there was none yet.
    await db
      .from("tt_clickup_state")
      .upsert({ owner_id: config.ownerId, workspace_id: config.workspaceId, error: why, error_at: stamp }, { onConflict: "owner_id" })
      .then(
        () => undefined,
        () => undefined,
      );
  }
}
