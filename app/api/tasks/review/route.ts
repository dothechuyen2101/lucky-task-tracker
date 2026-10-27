import { NextResponse } from "next/server";

import { discordIdentity, getUser } from "@/lib/auth";
import { isReviewDecision } from "@/lib/review";
import { decide, undoVerdict } from "@/lib/review-server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import type { Task } from "@/lib/types/database";

/**
 * A reviewer's verdict on a task (`lib/review-server.ts`): approve on time,
 * approve late, disapprove and close, disapprove and reopen with a new
 * deadline, or extend the deadline. Each is recorded as the score
 * (`tt_task_reviews`) and the assignee is DMed (Lucky35's PO, 2026-10-07).
 *
 * A route rather than a client write: the verdict is written for a task the
 * reviewer may not own (they asked for it through someone else's bot), the
 * score is not theirs to write, and the assignee is told through the owner's
 * bot, whose token must never reach a browser.
 *
 * WHO may decide is the boundary: the task is read on the caller's OWN
 * session (RLS), and they must own the board it is on, or have asked for it —
 * on their proven Discord identity (`tt_my_discord_id()`), never a value from
 * the body. Nobody reviews their own work.
 */

/** `nodejs` is required, not stylistic: the owner's token is opened with Node's `crypto`. */
export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    taskId?: unknown;
    decision?: unknown;
    note?: unknown;
    deadline?: unknown;
    /** A verdict's id, to take it back instead of deciding. */
    undo?: unknown;
  };
  const undo = typeof body.undo === "string" ? body.undo : null;
  if (typeof body.taskId !== "string" || (!undo && !isReviewDecision(body.decision))) {
    return NextResponse.json(
      { error: "Say which task, and approve_on_time, approve_late, disapprove_reopen or extend — or undo." },
      { status: 400 },
    );
  }
  if (body.deadline !== undefined && body.deadline !== null && typeof body.deadline !== "string") {
    return NextResponse.json({ error: "The deadline must be a date." }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note : null;
  const deadline = typeof body.deadline === "string" ? body.deadline : null;

  const supabase = await createSupabaseServerClient();
  const [{ data }, { data: me }] = await Promise.all([
    supabase.from("tt_tasks").select("*").eq("id", body.taskId).maybeSingle(),
    supabase.rpc("tt_my_discord_id"),
  ]);
  const task = data as Task | null;
  const discordId = typeof me === "string" && me !== "" ? me : null;
  const owner = task?.user_id === user.id;
  const asker = Boolean(discordId && task?.requested_by_discord_id === discordId);
  const theirOwn = Boolean(discordId && task?.assignee_discord_id === discordId);
  if (!task || !(owner || asker) || theirOwn || task.direction !== "given" || !task.assignee_discord_id) {
    return NextResponse.json({ error: "That task is not yours to review." }, { status: 404 });
  }

  const db = createSupabaseServiceRoleClient();
  const reviewer = { discordId, name: discordIdentity(user).username };
  const result = undo
    ? await undoVerdict(db, task, undo, { reviewer })
    : await decide(db, task, { decision: body.decision as Parameters<typeof decide>[2]["decision"], note, deadline }, { reviewer });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ task: result.task, review: result.review, told: result.told, error: result.error });
}
