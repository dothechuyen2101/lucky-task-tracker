import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { tryOpen } from "@/lib/crypto";
import { sendDm } from "@/lib/discord";
import type { Task } from "@/lib/types/database";

/**
 * One DM about a task, from its board owner's own bot — the channel every
 * reminder uses — logged in `tt_alerts` with the id it got back, so a reply to
 * it is about this task. Best effort: what the caller did stands whether or
 * not Discord delivers the news, and the outcome is said.
 *
 * Server-only: it opens the owner's bot token.
 */
export async function dmFromOwner(
  db: SupabaseClient,
  task: Pick<Task, "id" | "user_id">,
  recipientId: string,
  text: string,
  kind: string,
): Promise<{ ok: boolean; error: string | null }> {
  const { data: connection } = await db
    .from("tt_connections")
    .select("discord_bot_token_cipher")
    .eq("user_id", task.user_id)
    .maybeSingle();
  const token = tryOpen(connection?.discord_bot_token_cipher);

  let ok = false;
  let error: string | null = token ? null : "The board's owner has no working Discord bot connected.";
  let target: string | null = null;
  let messageId: string | null = null;
  if (token) {
    try {
      const sent = await sendDm(token, recipientId, text);
      target = sent.channelId;
      messageId = sent.messageId;
      ok = true;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }
  await db.from("tt_alerts").insert({ user_id: task.user_id, task_id: task.id, kind, target, message_id: messageId, ok, error });
  return { ok, error };
}
