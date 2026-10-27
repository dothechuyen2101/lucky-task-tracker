import { NextResponse } from "next/server";

import { discordIdentity, getUser } from "@/lib/auth";
import { tryOpen } from "@/lib/crypto";
import { sendDm } from "@/lib/discord";
import { MANUAL_REMIND_EVERY_MS, MANUAL_REMIND_MAX, manualReminderText } from "@/lib/reminders";
import { mineUrl, taskUrl } from "@/lib/site";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import type { Task } from "@/lib/types/database";

/**
 * "Remind now" (Lucky35's PO, 2026-10-07, task 5): ping the person a task is
 * on at once instead of waiting for the schedule — with the reviewer's own
 * words (`message`, optional), or the usual reminder when they typed none
 * (`manualReminderText`). One DM to the assignee — never anyone else — from
 * the board owner's bot, the channel the automatic reminders use, logged in
 * `tt_alerts` with the id it got back, so their reply ("done", the proof) is
 * about this task.
 *
 * It counts in "Sent so far" (`alerts_sent`) and in the assignee's own stream
 * (`assignee_alerts_sent`, the line the giver reads about them), and it goes
 * in the task's activity with who sent it and what it said: a 'reminded'
 * event in `tt_task_events` (`20261007_03`) — delivered or not.
 *
 * Who may: the board's owner, or the person who asked for it — on their
 * proven Discord identity — never the assignee about their own work. At most
 * once per task every `MANUAL_REMIND_EVERY_MS`.
 */

export const runtime = "nodejs";

/** `tt_alerts.kind` for a reminder sent by hand. */
const KIND = "manual_reminder";

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { taskId?: unknown; message?: unknown };
  if (typeof body.taskId !== "string") return NextResponse.json({ error: "Say which task." }, { status: 400 });
  if (body.message != null && typeof body.message !== "string") {
    return NextResponse.json({ error: "The message has to be text." }, { status: 400 });
  }
  const message = typeof body.message === "string" && body.message.trim() !== "" ? body.message.trim() : null;
  if (message && message.length > MANUAL_REMIND_MAX) {
    return NextResponse.json({ error: `Keep the message under ${MANUAL_REMIND_MAX} characters.` }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const [{ data }, { data: me }] = await Promise.all([
    supabase.from("tt_tasks").select("*").eq("id", body.taskId).maybeSingle(),
    supabase.rpc("tt_my_discord_id"),
  ]);
  const task = data as Task | null;
  const discordId = typeof me === "string" && me !== "" ? me : null;
  const owner = task?.user_id === user.id;
  const asker = Boolean(discordId && task?.requested_by_discord_id === discordId);
  const assignee = (task?.assignee_discord_id ?? "").trim();
  if (!task || !(owner || asker) || assignee === "" || assignee === discordId) {
    return NextResponse.json({ error: "There is nobody on it for you to remind." }, { status: 404 });
  }
  if (task.status !== "open") {
    return NextResponse.json({ error: "It is not open — there is nothing to remind them of." }, { status: 409 });
  }

  const db = createSupabaseServiceRoleClient();
  const now = new Date();
  const { data: recent } = await db
    .from("tt_alerts")
    .select("sent_at")
    .eq("task_id", task.id)
    .eq("kind", KIND)
    .gte("sent_at", new Date(now.getTime() - MANUAL_REMIND_EVERY_MS).toISOString())
    .limit(1);
  if (recent && recent.length > 0) {
    return NextResponse.json({ error: "Someone reminded them a few minutes ago — give it a little longer." }, { status: 429 });
  }

  const { data: connection } = await db
    .from("tt_connections")
    .select("discord_bot_token_cipher")
    .eq("user_id", task.user_id)
    .maybeSingle();
  const token = tryOpen(connection?.discord_bot_token_cipher);

  const who = discordIdentity(user).username ?? (owner ? task.owner_name : task.requested_by_name) ?? "Someone";
  const text = manualReminderText(who, task, message, now, {
    from: task.owner_name,
    assignee: { last: false },
    link: taskUrl(task.id),
    mine: mineUrl(),
  });

  let ok = false;
  let error: string | null = token ? null : "The board's owner has no working Discord bot connected.";
  let target: string | null = null;
  let messageId: string | null = null;
  if (token) {
    try {
      const sent = await sendDm(token, assignee, text);
      target = sent.channelId;
      messageId = sent.messageId;
      ok = true;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }

  const stamp = now.toISOString();
  await db.from("tt_alerts").insert({ user_id: task.user_id, task_id: task.id, kind: KIND, target, message_id: messageId, ok, error });

  // Who sent it, when and what it said — on the task, for everyone who can
  // read it. A refused write (the migration not applied yet) costs only this
  // line: the DM has gone either way.
  const { error: eventError } = await db.from("tt_task_events").insert({
    user_id: task.user_id,
    task_id: task.id,
    at: stamp,
    actor_discord_id: discordId,
    actor_name: who,
    kind: "reminded",
    changes: { to: task.assignee_name ?? assignee, message, ok, error },
  });
  if (eventError) console.error(`remind ${task.id}: activity not recorded: ${eventError.message}`);

  if (!ok) return NextResponse.json({ error: `The reminder did not go through: ${error}` }, { status: 502 });

  // Counted like a scheduled reminder that arrived: in "Sent so far", and in
  // the assignee's stream — but not against the overdue cap, which is the
  // automatic reminders' alone. The schedule is not touched: `last_alert_at`
  // is what `next_alert_at` is derived from, and this one changes neither.
  const counts = {
    alerts_sent: task.alerts_sent + 1,
    assignee_alerts_sent: task.assignee_alerts_sent + 1,
    assignee_last_alert_at: stamp,
    assignee_last_error: null,
  };
  const { error: countError } = await db.from("tt_tasks").update(counts).eq("id", task.id);
  if (countError) console.error(`remind ${task.id}: count not kept: ${countError.message}`);
  return NextResponse.json({ ok: true, sentAt: stamp, by: who, ...(countError ? {} : { counts }) });
}
