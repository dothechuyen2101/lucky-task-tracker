"use client";

import { type ReactNode, useEffect, useState } from "react";
import { BellRing } from "lucide-react";

import { formatWhen } from "@/lib/board";
import { MANUAL_REMIND_MAX, relativeTime } from "@/lib/reminders";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Task } from "@/lib/types/database";

/**
 * "Remind now" (Lucky35's PO, 2026-10-07, task 5): ping the person the task
 * is on at once, without waiting for the schedule — beside "Stop reminding",
 * which arrives as `children`. An optional message: typed, the assignee gets
 * exactly those words; left empty, the usual reminder. Only ever the assignee
 * (`/api/tasks/remind` reads who from the row, never from here).
 *
 * Under it: when it was last done by hand, and by whom — read from the task's
 * activity (`tt_task_events`, kind 'reminded'), which everyone who can read
 * the task can read. Keyed on the task by its caller, so another task opens
 * with an empty box.
 */

export type RemindResult = { error: string } | { error: null; sentAt: string; by: string | null };

type Props = {
  task: Task;
  zone: string;
  now: Date;
  /** Who it is on, by name. */
  assigneeName: string;
  /** Null when the viewer may not remind anyone about it. */
  onRemind: ((message: string) => Promise<RemindResult>) | null;
  /** Shown instead of sending, on a button that cannot: nobody is on it yet. */
  blocked?: string | null;
  busy: boolean;
  /** "Stop reminding" / "Remind … again", beside it. */
  children?: ReactNode;
};

type Last = { at: string; by: string | null };

export function RemindNow({ task, zone, now, assigneeName, onRemind, blocked, busy, children }: Props) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [last, setLast] = useState<Last | null>(null);
  const can = Boolean(onRemind) && !blocked;

  useEffect(() => {
    if (!can) return;
    let live = true;
    createSupabaseBrowserClient()
      .from("tt_task_events")
      .select("at, actor_name")
      .eq("task_id", task.id)
      .eq("kind", "reminded")
      .contains("changes", { ok: true })
      .order("at", { ascending: false })
      .limit(1)
      .then(({ data }: { data: unknown }) => {
        // Nothing, or no such kind yet (a migration still to apply): no line.
        const row = (data as { at: string; actor_name: string | null }[] | null)?.[0];
        if (live && row) setLast((known) => (known && Date.parse(known.at) > Date.parse(row.at) ? known : { at: row.at, by: row.actor_name }));
      });
    return () => {
      live = false;
    };
  }, [can, task.id, task.updated_at]);

  async function send() {
    if (!onRemind || sending) return;
    setSending(true);
    setNote(null);
    const result = await onRemind(message.trim());
    setSending(false);
    if (result.error !== null) {
      setNote({ ok: false, text: result.error });
      return;
    }
    setNote({ ok: true, text: `Sent — ${assigneeName || "they"} got ${message.trim() ? "your message" : "a reminder"} by DM just now.` });
    setMessage("");
    setLast({ at: result.sentAt, by: result.by });
  }

  const who = assigneeName || "them";
  return (
    <div className="remind-now">
      {onRemind || blocked ? (
        <textarea
          className="note-edit remind-now-input"
          rows={2}
          maxLength={MANUAL_REMIND_MAX}
          value={message}
          disabled={!can || sending}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={can ? `A message for ${who} (optional) — leave it empty to send the usual reminder` : (blocked ?? "")}
          aria-label={`Message for ${who}, optional`}
        />
      ) : null}
      <div className="remind-now-actions">
        {onRemind || blocked ? (
          <button
            className="btn btn-sm btn-primary"
            disabled={!can || busy || sending}
            onClick={send}
            title={can ? `DM ${who} now, from the bot that sends the reminders` : (blocked ?? undefined)}
          >
            <BellRing /> {sending ? "Sending…" : "Remind now"}
          </button>
        ) : null}
        {children}
      </div>
      {blocked ? <p className="detail-hint">{blocked}</p> : null}
      {note ? (
        <p className="detail-hint remind-now-note" data-ok={note.ok} role="status">
          {note.text}
        </p>
      ) : null}
      {last ? (
        <p className="detail-hint">
          Last reminded by hand{last.by ? <> by <b>{last.by}</b></> : null} ·{" "}
          <span title={formatWhen(last.at, zone)}>{relativeTime(last.at, now)}</span>
        </p>
      ) : null}
    </div>
  );
}
