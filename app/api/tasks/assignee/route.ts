import { NextResponse } from "next/server";

import { isAssigneeAction } from "@/lib/assignee";
import { applyAssigneeAnswer } from "@/lib/assignee-server";
import { discordIdentity, getUser } from "@/lib/auth";
import { proofFromBoard } from "@/lib/proof";
import { uploadedPaths } from "@/lib/proof-server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import type { Task } from "@/lib/types/database";

/**
 * The person a task was given to answers it: started, done, stop reminding
 * me, or remind me again (`lib/assignee.ts` decides what each changes). "Done"
 * carries its proof — words, links, and files already uploaded into the
 * task's folder (`/api/tasks/proof-upload`) — and is refused without it
 * (Lucky35's PO, 2026-10-07).
 *
 * A route rather than a client write, for both of CLAUDE.md's reasons: the row
 * belongs to the GIVER's account — the assignee's read path is SELECT-only
 * (`20260928_01_assignee_reads_their_tasks.sql`) and stays that way — and the
 * reviewer is told at once through the owner's own bot, whose token must
 * never reach a browser.
 *
 * WHO is asking is the security boundary. It is read from `auth.identities`,
 * through `tt_my_discord_id()` on the caller's OWN session — the same proof the
 * read policy uses — never from the request body, and never from
 * `tt_profiles.discord_user_id`, which its owner can edit.
 */

/** `nodejs` is required, not stylistic: the giver's token is opened with Node's `crypto`. */
export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { taskId?: unknown; action?: unknown; proof?: unknown; stage?: unknown };
  if (typeof body.taskId !== "string" || !isAssigneeAction(body.action)) {
    return NextResponse.json({ error: "Say which task, and start, stage, done, withdraw, mute or unmute." }, { status: 400 });
  }
  const action = body.action;
  // How far along, for `stage`: 0 not started, 1 started, 2 in progress.
  const stage = typeof body.stage === "number" ? body.stage : undefined;

  const supabase = await createSupabaseServerClient();
  const { data: me } = await supabase.rpc("tt_my_discord_id");
  if (typeof me !== "string" || me === "") {
    return NextResponse.json({ error: "This sign-in carries no Discord identity." }, { status: 403 });
  }

  const db = createSupabaseServiceRoleClient();
  const { data } = await db.from("tt_tasks").select("*").eq("id", body.taskId).maybeSingle();
  const task = data as Task | null;
  if (!task || task.assignee_discord_id !== me) {
    return NextResponse.json({ error: "That task was not given to you." }, { status: 404 });
  }

  // The proof, checked: files must really be in this task's folder.
  let proof = null;
  if (action === "done") {
    const read = proofFromBoard((body.proof ?? {}) as { text?: unknown; files?: unknown }, task.id);
    if (!read.ok) return NextResponse.json({ error: read.error }, { status: 400 });
    const files = read.items.filter((item) => item.kind === "file");
    if (files.length > 0) {
      const present = await uploadedPaths(db, task.id);
      if (files.some((item) => !present.has(item.file_path ?? ""))) {
        return NextResponse.json({ error: "A file did not finish uploading. Add it again." }, { status: 400 });
      }
    }
    proof = { items: read.items, source: "board" as const, byName: discordIdentity(user).username };
  }

  // The same rules, write and note to the reviewer as an answer by DM
  // (`lib/assignee-server.ts`): who is asking was proven above.
  const result = await applyAssigneeAnswer(db, task, action, me, new Date(), proof, { stage });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ task: result.task, proofs: result.proofs });
}
