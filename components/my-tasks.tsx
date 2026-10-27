"use client";

import { useState } from "react";
import { ArrowLeft, Bell, BellOff, Check, ExternalLink, Play } from "lucide-react";

import { useTimeZone } from "@/components/clock";
import { LiveCountdown } from "@/components/countdown";
import { type ProofDraft, ProofForm } from "@/components/proof-form";
import type { AssigneeAction } from "@/lib/assignee";
import { type Viewer, formatWhen, groupMine, isShared, originOf, urgencyOf } from "@/lib/board";
import { isDmLink } from "@/lib/discord-links";
import { assigneeCapped, relativeTime } from "@/lib/reminders";
import { movedOffMe } from "@/lib/handoffs";
import { closedLabel } from "@/lib/review";
import { IN_PROGRESS_STAGE, stageLabel } from "@/lib/stages";
import type { Task, TaskHandoff } from "@/lib/types/database";

/**
 * My tasks — everything on the person looking, in one place.
 *
 * Lucky35, 2026-10-02: the people who work closely with Luka had to piece
 * together what was on them from DMs and server channels. This is the one
 * place: every task given to them by anyone using the tracker — tagged in a
 * channel or sent by DM, from any account — and what is on them in their own
 * account, grouped by how soon. Someone with no bot of their own lands here
 * when they sign in, and every DM the bot sends them links here.
 *
 * It writes nothing itself: "Start", "Report done" (with its proof — Lucky35's
 * PO, 2026-10-07) and "Stop reminding me"
 * are raised to `Tracker`, which sends a task somebody else gave through
 * `/api/tasks/assignee` and writes the viewer's own directly. Finished work
 * from someone else waits for their review; sent back, it is open here again
 * with what they said is missing (Lucky35, 2026-10-04).
 */

type MyTasksProps = {
  tasks: Task[];
  viewer: Viewer;
  now: Date;
  /** Task ids with a write in flight — their buttons are disabled. */
  busy: (taskId: string) => boolean;
  /** False for someone who only receives work: they are told how to give it too. */
  hasBot: boolean;
  onBack: () => void;
  onOpenTask: (id: string) => void;
  onDone: (task: Task) => void;
  /** Report a task somebody else gave the viewer done, with its proof; true when it went through. */
  onReport: (task: Task, proof: ProofDraft) => Promise<boolean>;
  /** "I'm on it": In progress. */
  onStart: (task: Task) => void;
  onAssigneeAction: (task: Task, action: AssigneeAction) => void;
  /** Recent changes of assignee readable by the viewer; the ones taken off them are listed. */
  handoffs: TaskHandoff[];
};

export function MyTasks({ tasks, viewer, now, busy, hasBot, onBack, onOpenTask, onDone, onReport, onStart, onAssigneeAction, handoffs }: MyTasksProps) {
  const zone = useTimeZone();
  const groups = groupMine(tasks, viewer, now, zone);
  // Taken off the viewer lately: said here, so a task leaving the list is
  // never a mystery (Lucky35's PO, 2026-10-04).
  const movedOff = movedOffMe(handoffs, tasks, viewer, now);
  const count = (key: string) => groups.find((g) => g.key === key)?.tasks.length ?? 0;
  const open = groups.filter((g) => g.key !== "done").reduce((n, g) => n + g.tasks.length, 0);

  return (
    <div className="person-view my-tasks">
      <header className="panel person-view-head">
        {hasBot ? (
          <button className="btn btn-sm" onClick={onBack} title="Back to the board">
            <ArrowLeft /> Board
          </button>
        ) : null}
        <div className="person-view-id">
          <h2 className="person-panel-name" tabIndex={-1}>
            My tasks
          </h2>
          <span className="person-handle">
            Everything given to you — by anyone using the tracker, in a channel or by DM.
          </span>
        </div>
      </header>

      <div className="person-figs figures">
        <div className="figure">
          <span className="v">{open}</span>
          <span className="k">Open</span>
        </div>
        <div className="figure">
          <span className={`v ${count("overdue") > 0 ? "attention" : ""}`}>{count("overdue")}</span>
          <span className="k">Overdue</span>
        </div>
        <div className="figure">
          <span className={`v ${count("today") > 0 ? "warn" : ""}`}>{count("today")}</span>
          <span className="k">Due today</span>
        </div>
        <div className="figure">
          <span className="v">{count("undated")}</span>
          <span className="k">No deadline</span>
        </div>
      </div>

      {groups.length === 0 ? (
        <section className="panel">
          <p className="empty">
            Nothing is on you right now. When someone tags their bot and @-mentions you — or sends it a DM naming you —
            it lands here, and their bot DMs you about it.
          </p>
        </section>
      ) : (
        groups.map((group) => (
          <section className="panel mine-group" key={group.key} aria-label={group.label}>
            <p className="sub-title">
              {group.label} <span className="skipped-count">{group.tasks.length}</span>
            </p>
            <ul className="mine-list">
              {group.tasks.map((task) => (
                <MineRow
                  key={task.id}
                  task={task}
                  viewer={viewer}
                  now={now}
                  zone={zone}
                  busy={busy(task.id)}
                  onOpenTask={onOpenTask}
                  onDone={onDone}
                  onReport={onReport}
                  onStart={onStart}
                  onAssigneeAction={onAssigneeAction}
                />
              ))}
            </ul>
          </section>
        ))
      )}

      {movedOff.length > 0 ? (
        <section className="panel mine-group" aria-label="Moved off you">
          <p className="sub-title">
            Moved off you <span className="skipped-count">{movedOff.length}</span>
          </p>
          <ul className="mine-list">
            {movedOff.map((handoff) => (
              <li className="mine-item moved-item" key={handoff.id}>
                <span className="mine-title">
                  <span className="tc-title-text">{handoff.task_title}</span>
                </span>
                <span className="mine-meta">
                  {handoff.owner_name ?? "Its giver"}{" "}
                  {handoff.to_discord_id ? `moved it to ${handoff.to_name ?? "someone else"}` : "took it off you"} ·{" "}
                  {relativeTime(handoff.moved_at, now)} — no longer yours, no more reminders
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="detail-hint mine-foot">
        You can also answer in Discord: reply <code>start</code> or <code>stop</code> to the bot&apos;s message about a
        task, or the proof that it is done — a screenshot, a file, a link or a few words — or DM it{" "}
        <code>my tasks</code>. Work you report done waits for its giver&apos;s review; if they reopen it or give you more
        time, it is open here again with the new deadline.
        {hasBot ? null : " To hand out tasks yourself, connect your own bot in Settings."}
      </p>
    </div>
  );
}

type MineRowProps = {
  task: Task;
  viewer: Viewer;
  now: Date;
  zone: string;
  busy: boolean;
  onOpenTask: (id: string) => void;
  onDone: (task: Task) => void;
  onReport: (task: Task, proof: ProofDraft) => Promise<boolean>;
  onStart: (task: Task) => void;
  onAssigneeAction: (task: Task, action: AssigneeAction) => void;
};

function MineRow({ task, viewer, now, zone, busy, onOpenTask, onDone, onReport, onStart, onAssigneeAction }: MineRowProps) {
  // The proof form, under the row, while the viewer reports it done.
  const [reporting, setReporting] = useState(false);
  const shared = isShared(task, viewer);
  const open = task.status === "open";
  // Only the two people in a DM can open a link into it: a task the giver sent
  // their bot by DM says so instead of offering a link that cannot work.
  const fromDm = isDmLink(task.source_url);
  const where = fromDm ? "by DM" : task.source_url ? "in Discord" : "by hand";

  return (
    <li className="mine-item" style={{ ["--task-color" as string]: task.color }}>
      <button className="mine-title" onClick={() => onOpenTask(task.id)} title="Open this task">
        <span className="swatch" />
        <span className="tc-title-text">{task.title}</span>
      </button>
      <span className="mine-meta">
        {originOf(task, viewer)} · {where}
        {open && task.stage > 0 ? ` · ${stageLabel(task.stage)}` : ""}
        {open && task.review_state === "rejected"
          ? ` · sent back${task.review_note ? `: “${task.review_note}”` : ""}`
          : ""}
      </span>
      <span className="mine-when">
        {!open ? (
          <span className="tc-status" data-review={task.review_state === "pending"}>
            {closedLabel(task, shared, "")}
            {task.completed_at ? ` ${relativeTime(task.completed_at, now)}` : ""}
          </span>
        ) : task.deadline ? (
          <span title={`Due ${formatWhen(task.deadline, zone)}`}>
            <LiveCountdown deadline={task.deadline} urgency={urgencyOf(task, now, zone)} now={now} />
          </span>
        ) : (
          <span className="tc-missing">No deadline</span>
        )}
      </span>
      <span className="mine-actions">
        {open && task.stage < IN_PROGRESS_STAGE ? (
          <button className="btn btn-sm" disabled={busy} onClick={() => onStart(task)} title="Say you are working on it">
            <Play /> Start
          </button>
        ) : null}
        {open ? (
          <button
            className="btn btn-sm btn-primary"
            disabled={busy || reporting}
            onClick={() => (shared ? setReporting(true) : onDone(task))}
          >
            <Check /> {shared ? "Report done…" : "Mark done"}
          </button>
        ) : null}
        {open && shared ? (
          task.assignee_muted_at ? (
            task.assignee_muted_by === "assignee" ? (
              <button className="btn btn-sm" disabled={busy} onClick={() => onAssigneeAction(task, "unmute")}>
                <Bell /> Remind me again
              </button>
            ) : null
          ) : assigneeCapped(task, now) ? null : (
            <button className="btn btn-sm" disabled={busy} onClick={() => onAssigneeAction(task, "mute")}>
              <BellOff /> Stop reminding me
            </button>
          )
        ) : null}
        {task.source_url && !(shared && fromDm) ? (
          <a className="btn btn-sm" href={task.source_url} target="_blank" rel="noreferrer" aria-label="Open in Discord">
            <ExternalLink />
          </a>
        ) : null}
      </span>
      {reporting && open && shared ? (
        <div className="mine-proof">
          <ProofForm
            taskId={task.id}
            title={task.title}
            reviewerName={task.requested_by_name ?? task.owner_name}
            busy={busy}
            onSubmit={async (proof) => {
              const ok = await onReport(task, proof);
              if (ok) setReporting(false);
              return ok;
            }}
            onCancel={() => setReporting(false)}
          />
        </div>
      ) : null}
    </li>
  );
}
