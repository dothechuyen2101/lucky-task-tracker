import { NextResponse } from "next/server";

import { getUser } from "@/lib/auth";
import { syncChannels } from "@/lib/channel-sync-server";
import { tryOpen } from "@/lib/crypto";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";

/**
 * Ask the user's bot what it can see, and bring `tt_channels` in step with it
 * — now, instead of within the next few minutes when the worker does the same
 * (`syncChannels`, `lib/channel-sync-server.ts`).
 *
 * Existing rows keep their `watching` switch, their poll cursor and their
 * history; only their labels follow Discord. A channel never seen before is
 * added and watched from when it could first have been missed (2026-10-06: a
 * whole server the bot joined after the last Refresh was never read). Channels
 * the bot has since lost access to are left in place with the access error on
 * them, because deleting them would silently stop tracking without saying so.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const db = createSupabaseServiceRoleClient();

  const { data: connection } = await db
    .from("tt_connections")
    .select("discord_bot_token_cipher, discord_bot_user_id")
    .eq("user_id", user.id)
    .single();

  const token = tryOpen(connection?.discord_bot_token_cipher);
  if (!token) {
    return NextResponse.json({ error: "Connect a Discord bot first." }, { status: 400 });
  }

  let result;
  try {
    // Every server's role, up front, while nobody is waiting on a tag.
    result = await syncChannels(db, {
      userId: user.id,
      botToken: token,
      botUserId: connection?.discord_bot_user_id ?? null,
      learnRoles: "all",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await db.from("tt_connections").update({ discord_last_error: detail }).eq("user_id", user.id);
    return NextResponse.json({ error: detail }, { status: 400 });
  }

  await db
    .from("tt_connections")
    .update({ discord_last_error: result.problems.length > 0 ? result.problems.join(" · ") : null })
    .eq("user_id", user.id);

  if (result.servers === 0) {
    return NextResponse.json({
      ok: true,
      guilds: 0,
      channels: 0,
      added: [],
      note: "That bot is not in any server yet. Use the invite link to add it to one.",
    });
  }

  return NextResponse.json({
    ok: true,
    guilds: result.servers,
    channels: result.channels,
    added: result.added,
    problems: result.problems,
  });
}
