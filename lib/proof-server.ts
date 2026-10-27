import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { tryOpen } from "@/lib/crypto";
import { refreshAttachmentUrl } from "@/lib/discord";
import { PROOF_BUCKET, type ProofItem } from "@/lib/proof";
import type { Task, TaskProof } from "@/lib/types/database";

/**
 * Proof, stored and opened — with the service role, so only after the caller
 * has proven who they are (`/api/tasks/assignee`, `/api/tasks/proof*`, the
 * worker). Board uploads live in the private `task-proofs` bucket; files sent
 * on Discord stay on Discord and their short-lived links are refreshed with
 * the owner's own bot when someone opens them.
 */

/** Keep the proof on the task. Returns what was written, or why not. */
export async function saveProofs(
  db: SupabaseClient,
  task: Pick<Task, "id" | "user_id">,
  items: readonly ProofItem[],
  by: { discordId: string | null; name: string | null; source: "board" | "discord"; messageUrl?: string | null },
): Promise<{ ok: true; proofs: TaskProof[] } | { ok: false; error: string }> {
  if (items.length === 0) return { ok: true, proofs: [] };
  const { data, error } = await db
    .from("tt_task_proofs")
    .insert(
      items.map((item) => ({
        user_id: task.user_id,
        task_id: task.id,
        submitted_by_discord_id: by.discordId,
        submitted_by_name: by.name,
        source: by.source,
        kind: item.kind,
        body: item.body ?? null,
        file_path: item.file_path ?? null,
        file_name: item.file_name ?? null,
        content_type: item.content_type ?? null,
        size_bytes: item.size_bytes ?? null,
        discord_url: item.discord_url ?? null,
        message_url: by.messageUrl ?? null,
      })),
    )
    .select("*");
  if (error) return { ok: false, error: error.message };
  return { ok: true, proofs: (data ?? []) as TaskProof[] };
}

/** Take back proof written for a report that then did not go through. */
export async function dropProofs(db: SupabaseClient, proofs: readonly TaskProof[]) {
  if (proofs.length === 0) return;
  await db.from("tt_task_proofs").delete().in("id", proofs.map((p) => p.id));
}

/** Files that really are in the task's folder — an upload path the browser made up is refused. */
export async function uploadedPaths(db: SupabaseClient, taskId: string): Promise<Set<string>> {
  const { data } = await db.storage.from(PROOF_BUCKET).list(taskId, { limit: 1000 });
  return new Set((data ?? []).map((object) => `${taskId}/${object.name}`));
}

/** Where to send someone who opens a proof file: a short-lived link to it, or null. */
export async function proofFileUrl(db: SupabaseClient, proof: TaskProof): Promise<string | null> {
  if (proof.file_path) {
    const { data } = await db.storage.from(PROOF_BUCKET).createSignedUrl(proof.file_path, 300);
    return data?.signedUrl ?? null;
  }
  if (proof.discord_url) {
    const { data: connection } = await db
      .from("tt_connections")
      .select("discord_bot_token_cipher")
      .eq("user_id", proof.user_id)
      .maybeSingle();
    const token = tryOpen(connection?.discord_bot_token_cipher);
    if (token) {
      try {
        const fresh = await refreshAttachmentUrl(token, proof.discord_url);
        if (fresh) return fresh;
      } catch {
        // Falls through to the message itself.
      }
    }
    return proof.message_url ?? proof.discord_url;
  }
  return null;
}
