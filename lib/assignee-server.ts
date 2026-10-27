import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { type AssigneeAction, assigneeActionChanges, giverNotice, toggleNoticeDue } from "@/lib/assignee";
import { tryOpen } from "@/lib/crypto";
import { sendDm, sendReminderMessage } from "@/lib/discord";
import { type ProofItem, proofLines } from "@/lib/proof";
import { dropProofs, saveProofs } from "@/lib/proof-server";
import { taskUrl } from "@/lib/site";
import type { Task, TaskProof } from "@/lib/types/database";

/**
 * The assignee's answer applied to a row their account does not own — started,
 * done, stop my reminders, remind me again — and the giver told. Shared by the two
 * places an assignee can answer: the board (`/api/tasks/assignee`, identity
 * from `tt_my_discord_id()` on their own session) and a DM to the giver's bot
 * (the worker, identity from the DM's author — Discord's word for who wrote
 * it). The caller proves who `assigneeId` is; this checks it is the task's.
 *
 * Server-only: it writes with the service role and reads the giver's bot token.
 */

/** `tt_alerts.kind` for the note telling the giver what the assignee did. */
export const ASSIGNEE_ACTION_KIND = "assignee_action";


export type AnswerResult =
  | { ok: true; task: Task; changed: boolean; proofs: TaskProof[] }
  | { ok: false; error: string; status: number };

/** What came with a "done": the proof, and where it came from. */
export type ProofSubmission = {
  items: readonly ProofItem[];
  source: "board" | "discord";
  byName: string | null;
  messageUrl?: string | null;
};

export async function applyAssigneeAnswer(
  db: SupabaseClient,
  task: Task,
  action: AssigneeAction,
  assigneeId: string,
  now = new Date(),
  proof: ProofSubmission | null = null,
  { stage }: { stage?: number } = {},
): Promise<AnswerResult> {
  // One answer for "no such task" and "not given to you", so ids cannot be
  // probed for existence.
  if (task.direction !== "given" || task.assignee_discord_id !== assigneeId) {
    return { ok: false, error: "That task was not given to you.", status: 404 };
  }
  // Done is never taken on someone's word (Lucky35's PO, 2026-10-07).
  if (action === "done" && (!proof || proof.items.length === 0)) {
    return { ok: false, error: "Add proof that it is done — a few words, a link or a file.", status: 400 };
  }

  // The giver's own Discord id: a task they gave themselves has no second
  // stream, and the schedule is derived knowing that.
  const { data: giver } = await db.from("tt_profiles").select("discord_user_id").eq("id", task.user_id).maybeSingle();

  const result = assigneeActionChanges(task, action, now, giver?.discord_user_id ?? null, { stage });
  if (!result.ok) return { ok: false, error: result.error, status: 409 };
  if (Object.keys(result.changes).length === 0) return { ok: true, task, changed: false, proofs: [] };

  // The proof is kept before the task moves, so a report the reviewer sees
  // always has it — and taken back if the report itself does not go through.
  let proofs: TaskProof[] = [];
  if (action === "done" && proof) {
    const saved = await saveProofs(db, task, proof.items, {
      discordId: assigneeId,
      name: proof.byName,
      source: proof.source,
      messageUrl: proof.messageUrl ?? null,
    });
    if (!saved.ok) return { ok: false, error: `The proof was not saved: ${saved.error}`, status: 500 };
    proofs = saved.proofs;
  }

  const { data: updated, error } = await db
    .from("tt_tasks")
    // Credited to the assignee in the task's activity (`tt_task_events`).
    .update({
      ...result.changes,
      last_actor_discord_id: assigneeId,
      last_actor_name: proof?.byName ?? task.assignee_name,
      last_actor_at: now.toISOString(),
    })
    .eq("id", task.id)
    // Re-asserted in the write itself: an assignee changed between the read
    // and this line must not let the old one through, nor a second "done".
    .eq("assignee_discord_id", assigneeId)
    .eq("status", task.status)
    .select("*")
    .maybeSingle();

  if (error || !updated) {
    await dropProofs(db, proofs);
    return { ok: false, error: error?.message ?? "The task changed underneath you. Reload.", status: 409 };
  }

  // "Started" shows on the giver's board and is not worth a DM; "done" asks
  // the reviewer for their verdict; a stop or a resume is coalesced
  // (`settleToggleNotice`).
  if (action === "done") await tellReviewer(db, updated as Task, proofs);
  // Whoever was asked to review it hears it was taken back.
  else if (action === "withdraw") await tellReviewer(db, updated as Task, [], "withdraw");
  else if (action === "mute" || action === "unmute") await settleToggleNotice(db, updated as Task, now);
  return { ok: true, task: updated as Task, changed: true, proofs };
}

/**
 * Tell whoever reviews the task that it was reported done, with the proof and
 * a link straight to it (Lucky35's PO, 2026-10-07): the person who asked for
 * it through the owner's bot when someone did, else the owner. Only the owner
 * is told they can answer by reply — the bot reads replies from its owner as
 * commands; everyone else reviews on the board.
 */
export async function tellReviewer(
  db: SupabaseClient,
  task: Task,
  proofs: readonly TaskProof[],
  action: "done" | "withdraw" = "done",
) {
  const requester = (task.requested_by_discord_id ?? "").trim();
  if (requester === "" || requester === (task.assignee_discord_id ?? "").trim()) {
    await tellGiver(db, task, action, proofs);
    return;
  }

  const { data: connection } = await db
    .from("tt_connections")
    .select("discord_bot_token_cipher")
    .eq("user_id", task.user_id)
    .maybeSingle();
  const token = tryOpen(connection?.discord_bot_token_cipher);
  const text = giverNotice(action, task.title, task.assignee_name ?? "The person you gave it to", taskUrl(task.id), {
    proof: proofLines(proofs),
    canReply: false,
  });

  let ok = false;
  let target: string | null = null;
  let messageId: string | null = null;
  let error: string | null = token ? null : "The board's owner has no working Discord bot connected.";
  if (token && text) {
    try {
      const sent = await sendDm(token, requester, text);
      target = sent.channelId;
      messageId = sent.messageId;
      ok = true;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }
  await db.from("tt_alerts").insert({
    user_id: task.user_id,
    task_id: task.id,
    kind: ASSIGNEE_ACTION_KIND,
    target,
    message_id: messageId,
    ok,
    error,
  });
}

/**
 * Tell the giver where the assignee's reminders stand — now, once the quiet
 * window has passed (owed on the row and sent by the worker), or not at all
 * when it is what they were last told (`toggleNoticeDue`). Called after every
 * stop / resume, and by the worker for what is owed.
 */
export async function settleToggleNotice(db: SupabaseClient, task: Task, now = new Date()) {
  // A closed task reminds nobody; its "done" was told on its own.
  if (task.status !== "open") {
    if (task.assignee_mute_notice_due) await db.from("tt_tasks").update({ assignee_mute_notice_due: false }).eq("id", task.id);
    return;
  }
  const muted = Boolean(task.assignee_muted_at);
  const due = toggleNoticeDue(muted, task.assignee_mute_told, task.assignee_mute_told_at, now);

  if (due === "later") {
    await db.from("tt_tasks").update({ assignee_mute_notice_due: true }).eq("id", task.id);
    return;
  }
  if (due === "none") {
    if (task.assignee_mute_notice_due) await db.from("tt_tasks").update({ assignee_mute_notice_due: false }).eq("id", task.id);
    return;
  }

  await tellGiver(db, task, muted ? "mute" : "unmute");
  await db
    .from("tt_tasks")
    .update({
      assignee_mute_told: muted ? "muted" : "unmuted",
      assignee_mute_told_at: now.toISOString(),
      assignee_mute_notice_due: false,
    })
    .eq("id", task.id);
}

/**
 * DM the giver what just happened, from their own bot — every time it is
 * called: how often is `settleToggleNotice`'s call. Best effort: the
 * assignee's answer stands whether or not Discord delivers the news, and the
 * outcome is logged in `tt_alerts` like every other message the tracker sends
 * — with the id of the DM, so the giver's reply to it ("approve", "extend")
 * is a command about this task.
 */
export async function tellGiver(db: SupabaseClient, task: Task, action: AssigneeAction, proofs: readonly TaskProof[] = []) {
  const [{ data: connection }, { data: profile }] = await Promise.all([
    db.from("tt_connections").select("discord_bot_token_cipher").eq("user_id", task.user_id).maybeSingle(),
    db.from("tt_profiles").select("discord_user_id, reminder_channel_id").eq("id", task.user_id).maybeSingle(),
  ]);

  const text = giverNotice(action, task.title, task.assignee_name ?? "The person you gave it to", taskUrl(task.id), {
    proof: proofLines(proofs),
  });
  if (!text) return;

  // No bot, or no Discord identity on the giver's profile: the news cannot be
  // sent. Logged like a failed send, so it is visible in the giver's history
  // rather than vanishing (2026-09-30 audit).
  const token = tryOpen(connection?.discord_bot_token_cipher);
  if (!token || !profile?.discord_user_id) {
    await db.from("tt_alerts").insert({
      user_id: task.user_id,
      task_id: task.id,
      kind: ASSIGNEE_ACTION_KIND,
      target: null,
      ok: false,
      error: !token ? "The giver has no working Discord bot connected." : "The giver's profile has no Discord identity.",
    });
    return;
  }

  let ok = false;
  let target: string | null = null;
  let messageId: string | null = null;
  let error: string | null = null;
  try {
    const sent = await sendReminderMessage(token, profile.discord_user_id, text, profile.reminder_channel_id);
    target = sent.channelId;
    messageId = sent.messageId;
    ok = true;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  await db.from("tt_alerts").insert({
    user_id: task.user_id,
    task_id: task.id,
    kind: ASSIGNEE_ACTION_KIND,
    target,
    message_id: messageId,
    ok,
    error,
  });
}
