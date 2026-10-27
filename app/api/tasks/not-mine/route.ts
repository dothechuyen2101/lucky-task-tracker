import { NextResponse } from "next/server";

import { discordIdentity, getUser } from "@/lib/auth";
import { notMineNotice } from "@/lib/dm";
import { dmFromOwner } from "@/lib/owner-dm";
import { awaitsReview } from "@/lib/review";
import { taskUrl } from "@/lib/site";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import type { Task } from "@/lib/types/database";

/**
 * "Not mine" (Cenri, 2026-10-20): the person on a card says it is not theirs —
 * they were only copied in on the message. It changes nothing on the card
 * (saying so is not a way out of work): it goes in the task's activity, and
 * whoever reviews it — the person who asked through the owner's bot, else the
 * owner — is DMed, with the link to take them off it ("Not for them").
 *
 * Who may: the card's own person, on their proven Discord identity
 * (`tt_my_discord_id()`). Said once per card: a second press tells nobody.
 */

export const runtime = "nodejs";

/** `tt_alerts.kind` for the DM to the reviewer. */
const KIND = "not_mine";

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
  if (!task || !discordId || (task.assignee_discord_id ?? "").trim() !== discordId || task.direction !== "given") {
    return NextResponse.json({ error: "That card is not on you." }, { status: 404 });
  }
  if (!(task.status === "open" || awaitsReview(task))) {
    return NextResponse.json({ error: "It is closed already." }, { status: 409 });
  }

  const db = createSupabaseServiceRoleClient();
  const { data: said } = await db
    .from("tt_task_events")
    .select("id")
    .eq("task_id", task.id)
    .eq("kind", "not_mine")
    .eq("actor_discord_id", discordId)
    .limit(1);
  if (said && said.length > 0) return NextResponse.json({ ok: true, already: true });

  const who = discordIdentity(user).username ?? task.assignee_name ?? "Someone";
  const { error: eventError } = await db.from("tt_task_events").insert({
    user_id: task.user_id,
    task_id: task.id,
    actor_discord_id: discordId,
    actor_name: who,
    kind: "not_mine",
    changes: {},
  });
  if (eventError) return NextResponse.json({ error: eventError.message }, { status: 500 });

  // Whoever reviews it: the person who asked through the owner's bot, else the owner.
  let reviewer = (task.requested_by_discord_id ?? "").trim();
  if (reviewer === "") {
    const { data: profile } = await db.from("tt_profiles").select("discord_user_id").eq("id", task.user_id).maybeSingle();
    reviewer = (profile?.discord_user_id ?? "").trim();
  }
  const told = reviewer
    ? await dmFromOwner(db, task, reviewer, notMineNotice(who, task.title, taskUrl(task.id)), KIND)
    : { ok: false, error: "Nobody to tell." };
  return NextResponse.json({ ok: true, told: told.ok, error: told.error });
}
