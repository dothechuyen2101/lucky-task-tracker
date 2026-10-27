import { NextResponse } from "next/server";

import { getUser } from "@/lib/auth";
import { isEncryptionConfigured, seal } from "@/lib/crypto";
import { getBotUser } from "@/lib/discord";
import { botInviteUrl } from "@/lib/discord-links";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";

/**
 * Connect (or disconnect) a user's own Discord bot.
 *
 * The token is verified against Discord before anything is written, so a typo
 * fails here with a readable message instead of silently at 3am in the worker.
 * It is sealed on the way in and never comes back out of this API — the UI is
 * told the bot's username and nothing else.
 */

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  if (!isEncryptionConfigured()) {
    return NextResponse.json(
      { error: "APP_ENCRYPTION_KEY is not set on the server, so credentials cannot be stored." },
      { status: 500 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as { token?: string };
  const token = body.token?.trim();

  if (!token) return NextResponse.json({ error: "Paste a bot token." }, { status: 400 });

  let bot;
  try {
    bot = await getBotUser(token);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error && error.message.includes("401")
            ? "Discord rejected that token. Copy it again from the Bot tab — it is the bot token, not the client secret or the application id."
            : `Discord could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 400 },
    );
  }

  const db = createSupabaseServiceRoleClient();
  const { error } = await db.from("tt_connections").upsert(
    {
      user_id: user.id,
      discord_bot_token_cipher: seal(token),
      discord_bot_user_id: bot.id,
      discord_bot_username: bot.global_name ?? bot.username,
      discord_connected_at: new Date().toISOString(),
      discord_last_error: null,
    },
    { onConflict: "user_id" },
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    bot: { id: bot.id, username: bot.global_name ?? bot.username },
    // Not a secret — it is in every invite link — but handy enough to save the
    // user a trip back to the developer portal.
    invite_url: botInviteUrl(bot.id),
  });
}

export async function DELETE() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const db = createSupabaseServiceRoleClient();

  // Stop the polling as well as the reading. Leaving channels watched with no
  // token would just log an error every minute.
  await db.from("tt_channels").update({ watching: false }).eq("user_id", user.id);

  const { error } = await db
    .from("tt_connections")
    .update({
      discord_bot_token_cipher: null,
      discord_bot_user_id: null,
      discord_bot_username: null,
      discord_connected_at: null,
      discord_last_error: null,
    })
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
