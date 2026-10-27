import { NextResponse } from "next/server";

import { getUser } from "@/lib/auth";
import { tryOpen } from "@/lib/crypto";
import { DiscordError, sendDirectMessage } from "@/lib/discord";
import {
  MESSAGE_ALERT_KIND,
  pickAllowedRecipient,
  validateMessageContent,
} from "@/lib/messaging";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";

/**
 * Send a hand-typed note to one person on the caller's own board, as a Discord
 * DM from the caller's own bot.
 *
 * SEND-ONLY, FOREVER. A bot cannot see what comes back from a DM between two
 * humans, on any architecture (`AGENTS.md:21-22`, `lib/discord.ts:16-18`). This
 * file has exactly one job — push one note outwards — and there is deliberately
 * no GET handler, now or ever. Nothing here models anything incoming.
 *
 * Why this is a route and not a client write: a secret AND the Discord API are
 * both involved (`CLAUDE.md:20-23`), and the encrypted bot credential must never
 * reach the browser (`CLAUDE.md:11-15`). Ordinary mutations go through
 * `mutate()` in `components/tracker.tsx`; this one cannot.
 *
 * THE SECURITY BOUNDARY is the `.eq("user_id", user.id)` SELECT below: it is
 * what produces the allow-list of snowflakes this caller may write to.
 * `pickAllowedRecipient` (`lib/messaging.ts`) only filters a list that query
 * already scoped, and proves nothing on its own.
 *
 * DM ONLY — no channel target, and no fallback to the caller's own reminder
 * channel. That column belongs to the caller, so falling back to it would post
 * a note meant for one person into a different person's channel.
 *
 * The text itself is NEVER stored. The `tt_alerts` row answers who, when and
 * whether — never what.
 */

/** `nodejs` is required, not stylistic: `tryOpen` reaches Node's `crypto`. */
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    recipientId?: string;
    content?: string;
  };

  // Before Discord and before the database, so a too-long note costs nothing.
  const check = validateMessageContent(body.content);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
  const content = check.content;

  const db = createSupabaseServiceRoleClient();

  // The allow-list. Never trust that the UI only offers valid ids, and never
  // accept a client-supplied name: the caller may only write to a snowflake
  // that is already on a task of their own.
  //
  // assignee_discord_id must equal PERSON_KEY_COLUMN in lib/people.ts.
  const { data: tracked } = await db
    .from("tt_tasks")
    .select("assignee_discord_id")
    .eq("user_id", user.id)
    .eq("direction", "given") // ruling (b): a panel only shows work owed to the caller
    .not("assignee_discord_id", "is", null);

  const ids = ((tracked ?? []) as Array<{ assignee_discord_id: string | null }>)
    .map((row) => row.assignee_discord_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  // No enumeration leak: every rejected recipient — unknown, malformed, or
  // simply somebody else's — gets this same status and this same copy.
  const recipientId = pickAllowedRecipient(ids, body.recipientId);
  if (!recipientId) {
    return NextResponse.json({ error: "That person is not on your board." }, { status: 403 });
  }

  // The sign-up trigger guarantees the row
  // (supabase/migrations/20260902_01_task_tracker_core.sql:288-290), so
  // `.single()` is right; destructuring `data` and reading it with `connection?.`
  // means a missing row still lands on the 400 below rather than a 500.
  const { data: connection } = await db
    .from("tt_connections")
    .select("discord_bot_token_cipher")
    .eq("user_id", user.id)
    .single();

  // No shared bot and no fallback credential, ever (CLAUDE.md:16-19). What
  // `tryOpen` returns is never put in a response body, a log line or an error.
  const token = tryOpen(connection?.discord_bot_token_cipher);
  if (!token) {
    return NextResponse.json({ error: "Connect a Discord bot first." }, { status: 400 });
  }

  let ok = false;
  let target: string | null = null;
  let error: string | null = null;
  let response: NextResponse;

  try {
    target = await sendDirectMessage(token, recipientId, content);
    ok = true;
    response = NextResponse.json({ ok: true });
  } catch (caught) {
    if (caught instanceof DiscordError && caught.status === 429) {
      // A rate limit is per bot credential and belongs to this caller alone. It
      // comes straight back so the human can decide; the request does NOT wait
      // and re-send inside the invocation, which is the stall AGENTS.md:23-24
      // forbids and would burn `maxDuration` doing nothing.
      error = "Discord is rate limiting your bot. Try again shortly.";
      response = NextResponse.json({ error, retryAfterMs: caught.retryAfterMs }, { status: 429 });
    } else if (caught instanceof DiscordError && caught.status === 403) {
      // Discord refuses on the DM OPEN, not on the send (lib/discord.ts:233-237),
      // and the open fails for either of two reasons — so name both. The worker's
      // 403 copy is written for the self-DM case and must not be copied here.
      error =
        "Discord would not open a DM with this person. They may block direct messages from server members, or your bot may share no server with them.";
      response = NextResponse.json({ error }, { status: 403 });
    } else {
      // Translate, do not leak: the message only, no stack and no credential.
      error = caught instanceof Error ? caught.message : String(caught);
      response = NextResponse.json({ error }, { status: 400 });
    }
  }

  // Outcome logged on the ONE path both branches reach, success and failure
  // alike, exactly as the worker does (lib/worker.ts:536-542). Written with the
  // service role because `tt_alerts` has a SELECT-only policy for
  // `authenticated` (supabase/migrations/20260902_01_task_tracker_core.sql:341-343).
  await db.from("tt_alerts").insert({
    user_id: user.id,
    task_id: null, // person-level, not task-level; the column is nullable
    // (supabase/migrations/20260902_01_task_tracker_core.sql:212)
    kind: MESSAGE_ALERT_KIND, // distinct from the column default 'deadline'
    target, // the DM channel id, or null when the open failed
    ok,
    error,
  });

  // No task row is touched at all: the scheduler owns its derived columns and
  // sending a note is not a schedule change (CLAUDE.md:24-27, AGENTS.md:79-82).
  return response;
}
