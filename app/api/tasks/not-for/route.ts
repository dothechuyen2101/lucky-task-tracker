import { NextResponse } from "next/server";

import { discordIdentity, getUser } from "@/lib/auth";
import { notForThemNotice } from "@/lib/dm";
import { dmFromOwner } from "@/lib/owner-dm";
import { awaitsReview } from "@/lib/review";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import type { Task } from "@/lib/types/database";

/**
 * "Not for them" (Cenri, 2026-10-20): close a card whose person was only
 * copied in on the message — "@jfabbs … share it with @umer" gave umer one.
 *
 * The card is dismissed with `dismiss_reason = 'only_cc'`, so nothing counts
 * for or against them: the dismissal trigger excuses any verdict on it and
 * corrects their points in the score history (`tt_note_missed_deadline`,
 * credited to whoever did this through `last_actor_*`). The other cards of the
 * same message name them as CC. They are DMed from the owner's bot when the
 * card was still reminding them or waiting for a verdict — so the reminders
 * stopping is not a mystery, and nobody tells them to "reply done".
 *
 * Who may: the board's owner, or the person who asked for it through the
 * owner's bot — on their proven Discord identity (`tt_my_discord_id()`) —
 * which is why it is a route: the asker cannot write the owner's row.
 */

export const runtime = "nodejs";

/** `tt_alerts.kind` for the DM telling someone they were only copied in. */
const KIND = "not_for_them";

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { taskId?: unknown };
  if (typeof body.taskId !== "string") return NextResponse.json({ error: "Say which task." }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const [{ data }, { data: me }] = await Promise.all([
    supabase.from("tt_tasks").select("*").eq("id", body.taskId).maybeSingle(),
    supabase.rpc("tt_my_discord_id"),
  ]);
  const task = data as Task | null;
  const discordId = typeof me === "string" && me !== "" ? me : null;
  const owner = task?.user_id === user.id;
  const asker = Boolean(discordId && task?.requested_by_discord_id === discordId);
  const person = (task?.assignee_discord_id ?? "").trim();
  if (!task || !(owner || asker) || task.direction !== "given" || person === "") {
    return NextResponse.json({ error: "That card is not yours to change." }, { status: 404 });
  }
  if (person === discordId) {
    return NextResponse.json({ error: "It is on you — say it is not yours instead." }, { status: 409 });
  }
  if (task.status === "dismissed") return NextResponse.json({ error: "It is already closed." }, { status: 409 });

  const db = createSupabaseServiceRoleClient();
  const now = new Date().toISOString();
  const who = discordIdentity(user).username ?? (owner ? task.owner_name : task.requested_by_name) ?? null;
  const live = task.status === "open" || awaitsReview(task);

  // Only while it stands where the caller saw it: a verdict given meanwhile
  // is not dismissed from under the reviewer.
  let write = db
    .from("tt_tasks")
    .update({
      status: "dismissed",
      dismiss_reason: "only_cc",
      next_alert_at: null,
      review_nudge_at: null,
      last_actor_discord_id: discordId,
      last_actor_name: who,
      last_actor_at: now,
    })
    .eq("id", task.id)
    .eq("status", task.status);
  write = task.review_state === null ? write.is("review_state", null) : write.eq("review_state", task.review_state);
  const { data: updated, error } = await write.select("*").maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated) return NextResponse.json({ error: "It changed underneath you — reload and look again." }, { status: 409 });

  // Named as CC on the other cards of the same message.
  if (task.source_message_id) {
    const { data: siblings } = await db
      .from("tt_tasks")
      .select("id, cc")
      .eq("source_message_id", task.source_message_id)
      .neq("id", task.id);
    for (const sibling of (siblings ?? []) as Array<Pick<Task, "id" | "cc">>) {
      const cc = sibling.cc ?? [];
      if (cc.some((entry) => entry.id === person)) continue;
      await db.from("tt_tasks").update({ cc: [...cc, { id: person, name: task.assignee_name }] }).eq("id", sibling.id);
    }
  }

  const told = live ? await dmFromOwner(db, task, person, notForThemNotice(task.title, who), KIND) : { ok: false, error: null };
  return NextResponse.json({ task: updated, told: told.ok, error: told.error });
}
