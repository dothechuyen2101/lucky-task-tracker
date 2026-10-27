"use client";

import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { CalendarDays, Inbox, LayoutGrid, Plus, Settings, X } from "lucide-react";

import { PersonPicker } from "@/components/person-picker";
import type { LiveState } from "@/components/tracker";
import { formatWhen } from "@/lib/board";
import {
  DEFAULT_DEV_VIEW,
  type DevView,
  clickUpStatusCounts,
  isActiveStatus,
  lastClickUpChange,
  parseDevView,
  splitTasks,
  statusMeaning,
  tasksByPerson,
  tasksInStatuses,
} from "@/lib/clickup";
import {
  DEVELOPER_STATUSES,
  type DevList,
  WORKING_ON_MAX,
  devListsFor,
  hiddenDevelopers,
  nextSortOrder,
  shownDevelopers,
  statusCounts,
} from "@/lib/developers";
import { displayNameOf } from "@/lib/members";
import { relativeTime } from "@/lib/reminders";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { dropLive, mergeLive } from "@/lib/team";
import type { ClickUpState, ClickUpTask, DevEditor, Developer, DeveloperStatus, Profile } from "@/lib/types/database";

/**
 * Developers — which dev is on what, kept by hand, seen live (Lucky35's PO,
 * 2026-10-05). One row per developer: what they are working on and how it is
 * going. The owner and the people they name keep it; every change reaches
 * everyone looking within a second (Supabase Realtime), with no reload.
 *
 * Writes go straight from here through RLS — the owner's list, or one the
 * viewer was named to keep — applied at once and put back if the database
 * refuses. Who changed a row, and when, is written by the database.
 *
 * A list ClickUp feeds (PO, 2026-10-12; `tt_clickup_state`) also shows, on
 * each row linked to a ClickUp person, what is open on them there — ClickUp's
 * own status names and colours, read by the worker every minute. The hand-kept
 * "working on" and status stay beside it, still theirs to edit.
 */

/** What a person may change on a row: never what ClickUp says. */
type DevChanges = Partial<Pick<Developer, "working_on" | "status" | "name" | "clickup_user_id" | "hidden_at" | "discord_user_id" | "discord_name">>;

type Props = {
  profile: Profile;
  /** The viewer hands out work: they have a list of their own even before it has anyone on it. */
  ownListAnyway: boolean;
  developers: Developer[];
  editors: DevEditor[];
  renderedAt: string;
  /** The tables are not there yet (`20261005_03` not applied). */
  setupError: string | null;
  /** The lists ClickUp feeds, among those the viewer keeps — or is on. */
  clickup: ClickUpState[];
  /** Every ClickUp task the viewer may read (`20261012_03`): a manager's all, a developer's own. */
  clickupTasks: ClickUpTask[];
};

/** The page's filter and legend, kept in this browser (`parseDevView`). */
const VIEW_KEY = "tt.devs.view";

const LIVE_LABEL: Record<LiveState, string> = {
  live: "Live",
  connecting: "Connecting…",
  off: "Not live — reload the page",
};

export function DevelopersView({
  profile,
  ownListAnyway,
  developers,
  editors: editorRows,
  renderedAt,
  setupError,
  clickup: clickupRows,
  clickupTasks,
}: Props) {
  const router = useRouter();
  const supabase = createSupabaseBrowserClient();
  const zone = profile.timezone || "UTC";
  const selfId = (profile.discord_user_id ?? "").trim();

  const [rows, setRows] = useState<Developer[]>(developers);
  const [seenRows, setSeenRows] = useState(developers);
  if (seenRows !== developers) {
    setSeenRows(developers);
    setRows(developers);
  }
  const [editors, setEditors] = useState<DevEditor[]>(editorRows);
  const [seenEditors, setSeenEditors] = useState(editorRows);
  if (seenEditors !== editorRows) {
    setSeenEditors(editorRows);
    setEditors(editorRows);
  }
  const [clickup, setClickup] = useState<ClickUpState[]>(clickupRows);
  const [seenClickup, setSeenClickup] = useState(clickupRows);
  if (seenClickup !== clickupRows) {
    setSeenClickup(clickupRows);
    setClickup(clickupRows);
  }
  const [tasks, setTasks] = useState<ClickUpTask[]>(clickupTasks);
  const [seenTasks, setSeenTasks] = useState(clickupTasks);
  if (seenTasks !== clickupTasks) {
    setSeenTasks(clickupTasks);
    setTasks(clickupTasks);
  }
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState>("connecting");

  // "Updated 3 minutes ago" moves on by itself; starts at the server's moment
  // so the first browser render prints what the server did.
  const [now, setNow] = useState(() => new Date(renderedAt));
  useEffect(() => {
    const read = () => setNow(new Date());
    const first = setTimeout(read, 0);
    const timer = setInterval(read, 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  // Live. RLS decides what each viewer hears, as for any read. A change to who
  // keeps which list changes which rows this viewer may see at all, so that
  // reloads the page's data rather than guessing.
  useEffect(() => {
    if (setupError) return;
    const client = createSupabaseBrowserClient();
    const channel = client
      .channel(`developers:${profile.id}:${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "tt_developers" }, (payload: RealtimePostgresChangesPayload<Developer>) => {
        if (payload.eventType === "DELETE") {
          const id = (payload.old as { id?: string }).id;
          if (id) setRows((current) => dropLive(current, id));
          return;
        }
        setRows((current) => mergeLive(current, payload.new as Developer));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "tt_dev_editors" }, () => {
        router.refresh();
      })
      // Every ClickUp task, as the worker writes it — RLS decides who hears which.
      .on("postgres_changes", { event: "*", schema: "public", table: "tt_clickup_tasks" }, (payload: RealtimePostgresChangesPayload<ClickUpTask>) => {
        if (payload.eventType === "DELETE") {
          const id = (payload.old as { id?: string }).id;
          if (id) setTasks((current) => current.filter((task) => task.id !== id));
          return;
        }
        setTasks((current) => mergeLive(current, payload.new as ClickUpTask));
      })
      // How the last ClickUp read went. An update may leave out a long column
      // it did not change (the members), so it is spread over what is held.
      .on("postgres_changes", { event: "*", schema: "public", table: "tt_clickup_state" }, (payload: RealtimePostgresChangesPayload<ClickUpState>) => {
        if (payload.eventType === "DELETE") return;
        const next = payload.new as ClickUpState;
        setClickup((current) => [
          ...current.filter((state) => state.owner_id !== next.owner_id),
          { ...current.find((state) => state.owner_id === next.owner_id), ...next },
        ]);
      })
      .subscribe((status: string) => {
        setLive(status === "SUBSCRIBED" ? "live" : status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED" ? "off" : "connecting");
      });
    return () => {
      void client.removeChannel(channel);
    };
  }, [profile.id, router, setupError]);

  const lists = devListsFor(profile.id, rows, editors, { ownListAnyway });
  const byPerson = tasksByPerson(tasks);
  // A developer's own ClickUp tasks, on a list they do not keep (2026-10-12).
  const kept = new Set(lists.map((list) => list.ownerId));
  const ownTasks = tasks.filter((task) => !kept.has(task.owner_id));

  // --- writes: applied at once, put back if refused --------------------------

  async function addDeveloper(list: DevList, name: string, discordId: string | null, clickupId: string | null = null) {
    const clean = name.trim().slice(0, 80);
    if (!clean) return;
    setError(null);
    const { data, error: insertError } = await supabase
      .from("tt_developers")
      .insert({
        owner_id: list.ownerId,
        name: clean,
        discord_user_id: discordId,
        clickup_user_id: clickupId,
        sort_order: nextSortOrder(list.developers),
      })
      .select("*")
      .single();
    if (insertError || !data) {
      setError(insertError?.message ?? "The developer was not added.");
      return;
    }
    setRows((current) => mergeLive(current, data as Developer));
  }

  async function updateDeveloper(row: Developer, changes: DevChanges) {
    setError(null);
    setRows((current) => current.map((r) => (r.id === row.id ? { ...r, ...changes } : r)));
    const { data, error: updateError } = await supabase.from("tt_developers").update(changes).eq("id", row.id).select("*").single();
    if (updateError || !data) {
      // Put back this row only: anything else that changed meanwhile stands.
      setRows((current) => current.map((r) => (r.id === row.id ? row : r)));
      setError(updateError?.message ?? "The change was not saved.");
      return;
    }
    setRows((current) => current.map((r) => (r.id === row.id ? (data as Developer) : r)));
  }

  async function removeDeveloper(row: Developer) {
    setError(null);
    setRows((current) => current.filter((r) => r.id !== row.id));
    const { error: deleteError } = await supabase.from("tt_developers").delete().eq("id", row.id);
    if (deleteError) {
      setRows((current) => mergeLive(current, row));
      setError(deleteError.message);
    }
  }

  async function addEditor(discordId: string, name: string | null) {
    if (editors.some((e) => e.owner_id === profile.id && e.discord_user_id === discordId)) return;
    setError(null);
    const { data, error: insertError } = await supabase
      .from("tt_dev_editors")
      .insert({ owner_id: profile.id, discord_user_id: discordId, name })
      .select("*")
      .single();
    if (insertError || !data) {
      setError(insertError?.message ?? "They were not added.");
      return;
    }
    setEditors((current) => mergeLive(current, data as DevEditor));
  }

  async function removeEditor(editor: DevEditor) {
    setError(null);
    setEditors((current) => current.filter((e) => e.id !== editor.id));
    const { error: deleteError } = await supabase.from("tt_dev_editors").delete().eq("id", editor.id);
    if (deleteError) {
      setEditors((current) => mergeLive(current, editor));
      setError(deleteError.message);
    }
  }

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
          <Link className="btn btn-sm" href="/summary">
            <CalendarDays /> Monthly
          </Link>
          <Link className="btn btn-sm" href="/settings">
            <Settings /> Settings
          </Link>
        </div>
      </div>

      <div className="person-view dev-view">
        <header className="panel person-view-head">
          <div className="person-view-id">
            <h2 className="person-panel-name">Developers</h2>
            <span className="person-handle">What each developer is on, and how it is going — it changes here the moment it changes.</span>
          </div>
          {setupError ? null : (
            <span className="status-pill" data-on={live === "live"} data-error={live === "off"}>
              {LIVE_LABEL[live]}
            </span>
          )}
        </header>

        {setupError ? (
          <div className="notice">
            <strong>Not set up yet</strong>
            The Developers tables are not in the database: apply <code>supabase/migrations/20261005_03_developers.sql</code>.
            <p style={{ margin: "8px 0 0", color: "var(--muted)" }}>{setupError}</p>
          </div>
        ) : null}

        {error ? <p className="err">{error}</p> : null}

        {ownTasks.length > 0 ? (
          <OwnClickUpTasks tasks={ownTasks} states={clickup} now={now} zone={zone} />
        ) : null}
        {!setupError && lists.length === 0 && ownTasks.length === 0 ? (
          <section className="panel">
            <p className="empty">
              Nobody has named you to keep a Developers list yet. Whoever runs the board adds you under &ldquo;Who keeps
              this list&rdquo; on theirs; it shows here as soon as they do.
            </p>
          </section>
        ) : null}

        {lists.map((list) => (
          <DevListPanel
            key={list.ownerId}
            list={list}
            now={now}
            zone={zone}
            selfId={selfId}
            selfName={profile.discord_username}
            onAdd={addDeveloper}
            onUpdate={updateDeveloper}
            onRemove={removeDeveloper}
            onAddEditor={addEditor}
            onRemoveEditor={removeEditor}
            clickup={clickup.find((state) => state.owner_id === list.ownerId) ?? null}
            byPerson={byPerson}
          />
        ))}

        <p className="detail-hint mine-foot">
          {clickup.length > 0
            ? "Tasks marked with their ClickUp status are read from ClickUp every minute; the typed line and the status menu are kept by hand. "
            : "Kept by hand — ClickUp can feed it once it is connected. "}
          <b>Working</b> is on it now, <b>Blocked</b> waits on something
          or someone, <b>In review</b> is done on their side and being checked. Each row says who changed it last, and
          when.
        </p>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------

type DevListPanelProps = {
  list: DevList;
  now: Date;
  zone: string;
  selfId: string;
  selfName: string | null;
  onAdd: (list: DevList, name: string, discordId: string | null, clickupId?: string | null) => void;
  onUpdate: (row: Developer, changes: DevChanges) => void;
  onRemove: (row: Developer) => void;
  onAddEditor: (discordId: string, name: string | null) => void;
  onRemoveEditor: (editor: DevEditor) => void;
  /** The ClickUp workspace feeding this list, if one does. */
  clickup: ClickUpState | null;
  /** Every ClickUp task the viewer reads, by person (`tasksByPerson`). */
  byPerson: ReadonlyMap<string, ClickUpTask[]>;
};

function DevListPanel({
  list,
  now,
  zone,
  selfId,
  selfName,
  onAdd,
  onUpdate,
  onRemove,
  onAddEditor,
  onRemoveEditor,
  clickup,
  byPerson,
}: DevListPanelProps) {
  const [newName, setNewName] = useState("");
  // Someone ClickUp keeps finding is hidden, never deleted: a deleted row
  // would be added again the next minute.
  const shown = shownDevelopers(list.developers);
  const hidden = hiddenDevelopers(list.developers);
  const [showHidden, setShowHidden] = useState(false);
  const counts = statusCounts(shown);

  // Filter by ClickUp status, and the legend (PO, 2026-10-12). Kept in this
  // browser and read after the first render, so it outlives a reload and the
  // first render still prints what the server did.
  const [view, setView] = useState<DevView>(DEFAULT_DEV_VIEW);
  const [viewReady, setViewReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const stored = window.localStorage.getItem(VIEW_KEY);
        if (stored) setView(parseDevView(JSON.parse(stored)));
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

  const tasksOf = (row: Developer) => (row.clickup_user_id ? (byPerson.get(row.clickup_user_id) ?? []) : []);
  const statuses = clickup ? clickUpStatusCounts(shown.flatMap(tasksOf)) : [];
  const picked = clickup ? view.statuses : [];
  // A picked status nobody is in any more still shows, so it can be unpicked.
  const chips = [
    ...statuses,
    ...picked.filter((p) => !statuses.some((s) => s.status === p)).map((status) => ({ status, color: null, type: "", count: 0 })),
  ];
  const listed = picked.length === 0 ? shown : shown.filter((row) => tasksInStatuses(tasksOf(row), picked).length > 0);
  const toggle = (status: string) =>
    setView((current) => ({
      ...current,
      statuses: current.statuses.includes(status) ? current.statuses.filter((s) => s !== status) : [...current.statuses, status],
    }));
  const facts = DEVELOPER_STATUSES.filter((s) => counts[s.key] > 0).map((s) => `${counts[s.key]} ${s.label.toLowerCase()}`);
  // ClickUp people not on the list yet: one pick adds them, already linked.
  const linked = new Set(list.developers.map((row) => row.clickup_user_id).filter(Boolean));
  const notYet = (clickup?.members ?? []).filter((member) => !linked.has(member.id));

  return (
    <section className="panel dev-list" aria-label={list.title}>
      <header className="dev-list-head">
        <h3>{list.title}</h3>
        <span className="team-facts">{facts.length > 0 ? facts.join(" · ") : "Nobody on it yet"}</span>
      </header>
      {clickup ? <ClickUpLine state={clickup} now={now} zone={zone} /> : null}

      {chips.length > 0 ? (
        <div className="cu-filter" role="group" aria-label="Show only these ClickUp statuses">
          {chips.map((chip) => (
            <button
              key={chip.status}
              className="cu-chip"
              aria-pressed={picked.includes(chip.status)}
              title={statusMeaning(chip.status, chip.type)}
              style={{ "--cu": chip.color ?? "#8d8d8d" } as CSSProperties}
              onClick={() => toggle(chip.status)}
            >
              {chip.status} · {chip.count}
            </button>
          ))}
          {picked.length > 0 ? (
            <button className="tc-all" onClick={() => setView((current) => ({ ...current, statuses: [] }))}>
              Show everyone
            </button>
          ) : null}
        </div>
      ) : null}

      {statuses.length > 0 ? (
        <details
          className="cu-legend"
          open={view.legend}
          onToggle={(event) => {
            const open = (event.currentTarget as HTMLDetailsElement).open;
            if (open !== view.legend) setView((current) => ({ ...current, legend: open }));
          }}
        >
          <summary>What these statuses mean</summary>
          <dl>
            {statuses.map((s) => (
              <div key={s.status} className="cu-legend-row">
                <dt>
                  <span className="cu-status" style={{ "--cu": s.color ?? "#8d8d8d" } as CSSProperties}>
                    {s.status}
                  </span>
                </dt>
                <dd>{statusMeaning(s.status, s.type)}</dd>
              </div>
            ))}
          </dl>
          <p className="detail-hint">Statuses are ClickUp&apos;s own, read every minute. Finished work is under each person&apos;s &ldquo;Done&rdquo;.</p>
        </details>
      ) : null}

      {picked.length > 0 ? (
        <p className="detail-hint dev-filter-note">
          Showing {listed.length} of {shown.length} developers — only their tasks in {picked.join(", ")}.
        </p>
      ) : null}

      {listed.length > 0 ? (
        <ul className="dev-rows">
          {listed.map((row) => (
            <DevRow
              key={row.id}
              row={row}
              now={now}
              zone={zone}
              onUpdate={onUpdate}
              onRemove={onRemove}
              clickup={clickup}
              picked={picked}
              tasks={tasksOf(row)}
              list={list}
              selfId={selfId}
              selfName={selfName}
            />
          ))}
        </ul>
      ) : picked.length > 0 ? (
        <p className="empty">Nobody has a task in {picked.join(", ")} right now.</p>
      ) : null}

      {hidden.length > 0 ? (
        <div className="dev-hidden">
          <button className="tc-all" onClick={() => setShowHidden((open) => !open)} aria-expanded={showHidden}>
            {showHidden ? "Hide the hidden" : `Hidden (${hidden.length})`}
          </button>
          {showHidden ? (
            <ul className="dev-hidden-list">
              {hidden.map((row) => (
                <li key={row.id}>
                  <span>{row.name}</span>
                  <button className="btn btn-sm" onClick={() => onUpdate(row, { hidden_at: null })}>
                    Show again
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="dev-add">
        <input
          className="field"
          value={newName}
          maxLength={80}
          placeholder="Add a developer by name…"
          aria-label="New developer's name"
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && newName.trim()) {
              onAdd(list, newName, null);
              setNewName("");
            }
          }}
        />
        <button
          className="btn btn-sm btn-primary"
          disabled={!newName.trim()}
          onClick={() => {
            onAdd(list, newName, null);
            setNewName("");
          }}
        >
          <Plus /> Add
        </button>
        {/* Picking from the server reads members with the owner's own bot —
            for a keeper too, who has none of their own (`/api/members?owner`). */}
        <div className="dev-add-pick">
          <PersonPicker
            value=""
            valueLabel={list.mine ? "…or pick from your server" : "…or pick from their server"}
            selfId={selfId}
            selfName={selfName}
            known={[]}
            ariaLabel="Pick a developer from the server"
            membersOf={list.mine ? null : list.ownerId}
            onPick={(id, _name, label) => onAdd(list, displayNameOf(label), id)}
          />
        </div>
        {/* Or straight from ClickUp, already linked to their person there. */}
        {notYet.length > 0 ? (
          <select
            className="field dev-add-clickup"
            value=""
            aria-label="Add a developer from ClickUp"
            onChange={(event) => {
              const member = notYet.find((m) => m.id === event.target.value);
              if (member) onAdd(list, member.name, null, member.id);
            }}
          >
            <option value="">…or add from ClickUp</option>
            {notYet.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {list.mine ? (
        <div className="dev-editors">
          <p className="sub-title">Who keeps this list</p>
          <p className="detail-hint">
            They sign in here with their own Discord and can change this list — adding developers by name or from your
            servers. They see nothing else of yours.
          </p>
          {list.editors.length > 0 ? (
            <div className="dev-editor-chips">
              {list.editors.map((editor) => (
                <span className="dev-chip" key={editor.id}>
                  {editor.name ?? `@${editor.discord_user_id}`}
                  <button onClick={() => onRemoveEditor(editor)} aria-label={`Stop ${editor.name ?? "them"} keeping this list`} title="Stop them keeping this list">
                    <X />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <PersonPicker
            value=""
            valueLabel="Let someone keep it…"
            selfId={selfId}
            selfName={selfName}
            known={[]}
            ariaLabel="Let someone keep this list"
            onPick={(id, _name, label) => onAddEditor(id, displayNameOf(label))}
          />
        </div>
      ) : null}
    </section>
  );
}

type DevRowProps = {
  row: Developer;
  now: Date;
  zone: string;
  onUpdate: (row: Developer, changes: DevChanges) => void;
  onRemove: (row: Developer) => void;
  clickup: ClickUpState | null;
  /** ClickUp statuses picked in the filter; none is all. */
  picked: readonly string[];
  /** Their ClickUp tasks, done ones too. */
  tasks: readonly ClickUpTask[];
  list: DevList;
  selfId: string;
  selfName: string | null;
};

function DevRow({ row, now, zone, onUpdate, onRemove, clickup, picked, tasks, list, selfId, selfName }: DevRowProps) {
  const [draft, setDraft] = useState(row.working_on);
  const [confirming, setConfirming] = useState(false);
  // Someone else saved meanwhile: the field follows, unless this was the value
  // already being typed.
  const [seen, setSeen] = useState(row.working_on);
  if (seen !== row.working_on) {
    setSeen(row.working_on);
    setDraft(row.working_on);
  }

  function commit() {
    const next = draft.trim().slice(0, WORKING_ON_MAX);
    if (next === row.working_on) return;
    onUpdate(row, { working_on: next });
  }

  return (
    <li className="dev-row" data-status={row.status}>
      <div className="dev-who">
        <span className="dev-name">{row.name}</span>
        <select
          className="dev-status"
          data-status={row.status}
          value={row.status}
          aria-label={`${row.name}'s status`}
          onChange={(event) => onUpdate(row, { status: event.target.value as DeveloperStatus })}
        >
          {DEVELOPER_STATUSES.map((status) => (
            <option key={status.key} value={status.key} title={status.hint}>
              {status.label}
            </option>
          ))}
        </select>
      </div>
      {clickup ? (
        <ClickUpPart
          row={row}
          state={clickup}
          now={now}
          zone={zone}
          picked={picked}
          tasks={tasks}
          onLink={(id) => onUpdate(row, { clickup_user_id: id })}
          signsInAs={
            <PersonPicker
              value={row.discord_user_id ?? ""}
              valueLabel={row.discord_user_id ? `Signs in as ${row.discord_name ?? "their Discord"}` : "Signs in as…"}
              selfId={selfId}
              selfName={selfName}
              known={[]}
              allowNobody
              ariaLabel={`Who ${row.name} signs in to the tracker as`}
              membersOf={list.mine ? null : list.ownerId}
              onPick={(id, name, label) => onUpdate(row, { discord_user_id: id || null, discord_name: id ? (name ?? displayNameOf(label)) : null })}
            />
          }
        />
      ) : null}
      {/* A note by hand, on top of what ClickUp says (PO, 2026-10-12: "this thing I can type in?"). */}
      <label className="dev-note">
        <span className="dev-note-k">Note</span>
        <input
          className="field dev-working"
          value={draft}
          maxLength={WORKING_ON_MAX}
          placeholder={clickup ? "Add a note — what ClickUp doesn't say…" : "What are they working on?"}
          aria-label={`Note about ${row.name}`}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
            if (event.key === "Escape") setDraft(row.working_on);
          }}
        />
      </label>
      <div className="dev-meta">
        <span title={formatWhen(row.updated_at, zone)}>
          {!row.updated_by_name && row.added_from === "clickup" ? "Added from ClickUp" : "Updated"} {relativeTime(row.updated_at, now)}
          {row.updated_by_name ? ` by ${row.updated_by_name}` : ""}
        </span>
        {/* Linked to ClickUp: hidden, never deleted — the sync would add them back. */}
        {confirming ? (
          <span className="dev-confirm">
            {row.clickup_user_id ? `Hide ${row.name}? They stay hidden even while ClickUp gives them work.` : `Take ${row.name} off the list?`}
            <button
              className="btn btn-sm btn-danger"
              onClick={() => (row.clickup_user_id ? onUpdate(row, { hidden_at: new Date().toISOString() }) : onRemove(row))}
            >
              {row.clickup_user_id ? "Hide" : "Remove"}
            </button>
            <button className="btn btn-sm" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </span>
        ) : (
          <button className="tc-all" onClick={() => setConfirming(true)}>
            {row.clickup_user_id ? "Hide" : "Remove"}
          </button>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------

/** How the last ClickUp read went — a failed one says why, where the list is. */
function ClickUpLine({ state, now, zone }: { state: ClickUpState; now: Date; zone: string }) {
  if (state.error) {
    return (
      <p className="err dev-clickup-line">
        ClickUp could not be read: {state.error}
        {state.error_at ? <span title={formatWhen(state.error_at, zone)}> · {relativeTime(state.error_at, now)}</span> : null}
      </p>
    );
  }
  return (
    <p className="detail-hint dev-clickup-line">
      From ClickUp{state.workspace_name ? ` · ${state.workspace_name}` : ""} ·{" "}
      {state.synced_at ? <span title={formatWhen(state.synced_at, zone)}>read {relativeTime(state.synced_at, now)}</span> : "not read yet"}
    </p>
  );
}

type ClickUpPartProps = {
  row: Developer;
  state: ClickUpState;
  now: Date;
  zone: string;
  /** Statuses picked in the filter; none is all. */
  picked: readonly string[];
  /** Their ClickUp tasks, done ones too. */
  tasks: readonly ClickUpTask[];
  onLink: (clickupUserId: string | null) => void;
  /** Who they sign in to the tracker as, so they can see their own tasks (2026-10-12). */
  signsInAs: ReactNode;
};

/** Their ClickUp tasks, in ClickUp's own words and colours — open ones, then "Done" — and who they are there. */
function ClickUpPart({ row, state, now, zone, picked, tasks, onLink, signsInAs }: ClickUpPartProps) {
  const changed = lastClickUpChange(tasks);
  const members = state.members ?? [];
  const known = !row.clickup_user_id || members.some((member) => member.id === row.clickup_user_id);
  return (
    <div className="dev-clickup">
      <div className="dev-clickup-head">
        <span className="dev-clickup-k">ClickUp</span>
        <select
          className="dev-clickup-who"
          value={row.clickup_user_id ?? ""}
          aria-label={`Who ${row.name} is in ClickUp`}
          onChange={(event) => onLink(event.target.value || null)}
        >
          <option value="">Not linked</option>
          {known ? null : <option value={row.clickup_user_id ?? ""}>ClickUp {row.clickup_user_id}</option>}
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
        {changed ? (
          <span className="dev-clickup-when" title={formatWhen(changed, zone)}>
            changed {relativeTime(changed, now)}
          </span>
        ) : null}
      </div>
      {/* Who they sign in as — so they can open their own tasks here. Matched by email when certain. */}
      {row.clickup_user_id ? <div className="dev-signs-in">{signsInAs}</div> : null}
      {!row.clickup_user_id ? (
        <p className="detail-hint">Pick who they are in ClickUp to show their tasks there.</p>
      ) : (
        <ClickUpTaskList tasks={tasks} picked={picked} now={now} zone={zone} empty={state.synced_at ? "No tasks in ClickUp." : "Not read from ClickUp yet."} />
      )}
    </div>
  );
}

/**
 * A person's ClickUp tasks: what is open, being worked on first; then "Done",
 * folded, newest first. With statuses picked, only those tasks, in one list.
 */
function ClickUpTaskList({
  tasks,
  picked,
  now,
  zone,
  empty,
}: {
  tasks: readonly ClickUpTask[];
  picked: readonly string[];
  now: Date;
  zone: string;
  empty: string;
}) {
  const { open, done } = splitTasks(tasks);
  if (open.length === 0 && done.length === 0) return <p className="detail-hint">{empty}</p>;
  if (picked.length > 0) {
    return (
      <ul className="cu-tasks">
        {tasksInStatuses([...open, ...done], picked).map((task) => (
          <ClickUpTaskLine key={task.id} task={task} now={now} zone={zone} />
        ))}
      </ul>
    );
  }
  return (
    <>
      {open.length > 0 ? (
        <ul className="cu-tasks">
          {open.map((task) => (
            <ClickUpTaskLine key={task.id} task={task} now={now} zone={zone} />
          ))}
        </ul>
      ) : (
        <p className="detail-hint">Nothing open in ClickUp.</p>
      )}
      {done.length > 0 ? (
        <details className="cu-done">
          <summary>Done ({done.length})</summary>
          <ul className="cu-tasks">
            {done.map((task) => (
              <ClickUpTaskLine key={task.id} task={task} now={now} zone={zone} />
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

function ClickUpTaskLine({ task, now, zone }: { task: ClickUpTask; now: Date; zone: string }) {
  const when = task.done_at ?? task.updated_at;
  return (
    <li>
      <a className="cu-task" data-active={isActiveStatus(task.type)} href={task.url} target="_blank" rel="noreferrer">
        <span className="cu-status" title={statusMeaning(task.status, task.type)} style={{ "--cu": task.color ?? "#8d8d8d" } as CSSProperties}>
          {task.status}
        </span>
        <span className="cu-name">{task.name}</span>
        {task.list ? <span className="cu-list">{task.list}</span> : null}
        {task.done_at && when ? (
          <span className="cu-list" title={formatWhen(when, zone)}>
            · done {relativeTime(when, now)}
          </span>
        ) : null}
      </a>
    </li>
  );
}

/**
 * A developer's own ClickUp tasks (2026-10-12): every one assigned to them,
 * open and done, on a list they do not keep — read only. Nothing the managers
 * keep about them (the note, the hand-set status) is here: the database does
 * not give it to them.
 */
function OwnClickUpTasks({ tasks, states, now, zone }: { tasks: readonly ClickUpTask[]; states: readonly ClickUpState[]; now: Date; zone: string }) {
  const owners = [...new Set(tasks.map((task) => task.owner_id))];
  return (
    <>
      {owners.map((owner) => {
        const state = states.find((s) => s.owner_id === owner) ?? null;
        const theirs = tasks.filter((task) => task.owner_id === owner);
        return (
          <section key={owner} className="panel dev-list" aria-label="Your ClickUp tasks">
            <header className="dev-list-head">
              <h3>Your ClickUp tasks{state?.workspace_name ? ` — ${state.workspace_name}` : ""}</h3>
              <span className="team-facts">
                {splitTasks(theirs).open.length} open · {splitTasks(theirs).done.length} done
              </span>
            </header>
            {state ? <ClickUpLine state={state} now={now} zone={zone} /> : null}
            <div className="dev-row">
              <ClickUpTaskList tasks={theirs} picked={[]} now={now} zone={zone} empty="No tasks in ClickUp." />
            </div>
          </section>
        );
      })}
    </>
  );
}
