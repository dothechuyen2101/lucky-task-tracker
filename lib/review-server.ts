import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { tryOpen } from "@/lib/crypto";
import { sendDm } from "@/lib/discord";
import { type ReviewInput, reviewChanges, undoChanges, undoneNotice, verdictNotice } from "@/lib/review";
import { mineUrl } from "@/lib/site";
import type { Task, TaskReview } from "@/lib/types/database";

/**
 * A reviewer's verdict — approve on time, approve late, disapprove (close or
 * reopen), extend — written with its points in the permanent score history
 * (`tt_task_reviews`, `tt_score_entries`), and
 * the assignee told by DM. Shared by the two places a verdict is given: the
 * board (`/api/tasks/review`, after proving the caller may review it) and the
 * owner's reply to the bot's "reported done" DM (the worker).
 * `lib/review.ts` decides what changes; the caller proves who is deciding.
 *
 * Server-only: it writes with the service role and reads the owner's bot token.
 */

/** `tt_alerts.kind` for the DM telling the assignee the verdict. */
export const VERDICT_KIND = "verdict";

export type VerdictResult =
  | { ok: true; task: Task; review: TaskReview; told: boolean; error: string | null }
  | { ok: false; error: string; status: number };

export async function decide(
  db: SupabaseClient,
  task: Task,
  input: ReviewInput,
  {
    now = new Date(),
    botToken = null,
    reviewer,
  }: { now?: Date; botToken?: string | null; reviewer: { discordId: string | null; name: string | null } },
): Promise<VerdictResult> {
  const { data: owner } = await db
    .from("tt_profiles")
    .select("discord_user_id, discord_username")
    .eq("id", task.user_id)
    .maybeSingle();

  const result = reviewChanges(task, input, now, owner?.discord_user_id ?? null);
  if (!result.ok) return { ok: false, error: result.error, status: 409 };

  // One transaction (`tt_give_verdict`, 20261009_01): the task is locked and
  // changed only while it stands where the reviewer saw it, the verdict is
  // recorded, and its points written to the permanent history — all, or
  // nothing. (A verdict can no longer be inserted and deleted again on a lost
  // race: its −1 could not be.) Credited to the reviewer in the activity.
  const actor = { last_actor_discord_id: reviewer.discordId, last_actor_name: reviewer.name, last_actor_at: now.toISOString() };
  const { data, error } = await db.rpc("tt_give_verdict", {
    p_task: task.id,
    p_status: task.status,
    p_review_state: task.review_state,
    p_changes: { ...result.changes, ...actor },
    p_review: {
      reviewer_discord_id: reviewer.discordId,
      reviewer_name: reviewer.name,
      ...result.record,
      decided_at: now.toISOString(),
    },
  });
  if (error) return { ok: false, error: error.message, status: 500 };
  const given = data as { task: Task; review: TaskReview } | null;
  if (!given) return { ok: false, error: "It changed underneath you — reload and look again.", status: 409 };

  const written = given.task;
  const review = given.review;
  const told = await tellAssignee(db, written, {
    ownerId: owner?.discord_user_id ?? null,
    botToken,
    text: verdictNotice(input.decision, written.title, reviewer.name ?? owner?.discord_username ?? written.owner_name, review.note, review.new_deadline, mineUrl()),
  });
  return { ok: true, task: written, review, told: told.ok, error: told.error };
}

/**
 * Take a verdict back (PO, 2026-10-07: "clicked Completed by mistake, and did
 * not know how to undo it"). Allowed while the task still stands as the
 * verdict left it (`undoChanges`): it goes back exactly as it was, the verdict
 * stays listed but excused as 'undone' — counting nothing — and the assignee,
 * who was told the verdict, is told it was taken back.
 */
export async function undoVerdict(
  db: SupabaseClient,
  task: Task,
  reviewId: string,
  {
    now = new Date(),
    botToken = null,
    reviewer,
  }: { now?: Date; botToken?: string | null; reviewer: { discordId: string | null; name: string | null } },
): Promise<VerdictResult> {
  const { data: found } = await db.from("tt_task_reviews").select("*").eq("id", reviewId).eq("task_id", task.id).maybeSingle();
  const review = found as TaskReview | null;
  if (!review) return { ok: false, error: "That verdict is not on this task.", status: 404 };

  const { data: owner } = await db
    .from("tt_profiles")
    .select("discord_user_id, discord_username")
    .eq("id", task.user_id)
    .maybeSingle();
  const result = undoChanges(task, review, now, owner?.discord_user_id ?? null);
  if (!result.ok) return { ok: false, error: result.error, status: 409 };

  // One transaction (`tt_undo_verdict`, 20261009_01): the verdict marked
  // 'undone', the task put back while it still stands as the verdict left it,
  // and the points it moved corrected in the history — a correction beside
  // the original, never an edit of it.
  const actor = { last_actor_discord_id: reviewer.discordId, last_actor_name: reviewer.name, last_actor_at: now.toISOString() };
  const { data, error } = await db.rpc("tt_undo_verdict", {
    p_review: review.id,
    p_task: task.id,
    p_status: task.status,
    p_review_state: task.review_state,
    p_changes: { ...result.changes, ...actor },
    p_actor_id: reviewer.discordId,
    p_actor_name: reviewer.name,
    p_at: now.toISOString(),
  });
  if (error) return { ok: false, error: error.message, status: 409 };
  const undone = data as { task: Task; review: TaskReview } | null;
  if (!undone) return { ok: false, error: "It changed underneath you — reload and look again.", status: 409 };

  const written = undone.task;
  const marked = undone.review;
  const told = await tellAssignee(db, written, {
    ownerId: owner?.discord_user_id ?? null,
    botToken,
    text: undoneNotice(review.decision, written.title, reviewer.name ?? owner?.discord_username ?? written.owner_name, result.changes, mineUrl()),
  });
  return { ok: true, task: written, review: marked as TaskReview, told: told.ok, error: told.error };
}

/**
 * DM the assignee the verdict, from the owner's own bot. The id of the DM is
 * kept (`tt_alerts.message_id`) so their reply — the proof, when it was
 * reopened — is about this task. Nobody to tell when the owner had it
 * themselves. A failure is logged like every other send, and said.
 */
async function tellAssignee(
  db: SupabaseClient,
  task: Task,
  { ownerId, botToken, text }: { ownerId: string | null; botToken: string | null; text: string },
): Promise<{ ok: boolean; error: string | null }> {
  const assignee = (task.assignee_discord_id ?? "").trim();
  if (task.direction !== "given" || assignee === "" || assignee === ownerId) return { ok: true, error: null };

  let token = botToken;
  if (!token) {
    const { data: connection } = await db
      .from("tt_connections")
      .select("discord_bot_token_cipher")
      .eq("user_id", task.user_id)
      .maybeSingle();
    token = tryOpen(connection?.discord_bot_token_cipher);
  }

  let ok = false;
  let error: string | null = null;
  let target: string | null = null;
  let messageId: string | null = null;
  if (!token) {
    error = "No working Discord bot is connected.";
  } else {
    try {
      const sent = await sendDm(token, assignee, text);
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
    kind: VERDICT_KIND,
    target,
    message_id: messageId,
    ok,
    error,
  });
  return { ok, error };
}
