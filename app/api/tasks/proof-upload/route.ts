import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { getUser } from "@/lib/auth";
import { PROOF_BUCKET, PROOF_FILE_MAX_BYTES, proofPath } from "@/lib/proof";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import type { Task } from "@/lib/types/database";

/**
 * Permission to upload ONE proof file for a task, before reporting it done:
 * a one-time signed upload into the task's own folder of the private
 * `task-proofs` bucket. The browser sends the file straight to storage —
 * nothing large passes through this function — and `/api/tasks/assignee`
 * checks the file landed there before it accepts the report.
 *
 * Only the person the task is on, on their proven Discord identity, and only
 * while it is open.
 */

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { taskId?: unknown; fileName?: unknown; size?: unknown };
  if (typeof body.taskId !== "string" || typeof body.fileName !== "string" || body.fileName.trim() === "") {
    return NextResponse.json({ error: "Say which task, and the file's name." }, { status: 400 });
  }
  if (typeof body.size === "number" && body.size > PROOF_FILE_MAX_BYTES) {
    return NextResponse.json({ error: "Files up to 50 MB — share a bigger one as a link." }, { status: 413 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: me } = await supabase.rpc("tt_my_discord_id");
  if (typeof me !== "string" || me === "") {
    return NextResponse.json({ error: "This sign-in carries no Discord identity." }, { status: 403 });
  }

  const db = createSupabaseServiceRoleClient();
  const { data } = await db.from("tt_tasks").select("id, assignee_discord_id, status").eq("id", body.taskId).maybeSingle();
  const task = data as Pick<Task, "id" | "assignee_discord_id" | "status"> | null;
  if (!task || task.assignee_discord_id !== me) {
    return NextResponse.json({ error: "That task was not given to you." }, { status: 404 });
  }
  if (task.status !== "open") return NextResponse.json({ error: "It is not open any more." }, { status: 409 });

  const path = proofPath(task.id, body.fileName, randomUUID());
  const { data: signed, error } = await db.storage.from(PROOF_BUCKET).createSignedUploadUrl(path);
  if (error || !signed) return NextResponse.json({ error: error?.message ?? "Storage said no." }, { status: 500 });
  return NextResponse.json({ path: signed.path, token: signed.token });
}
