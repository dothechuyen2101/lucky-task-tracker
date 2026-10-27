import { NextResponse } from "next/server";

import { getUser } from "@/lib/auth";
import { tryOpen } from "@/lib/crypto";
import { DiscordError, canInviteBot, getBotGuilds, getUserGuilds } from "@/lib/discord";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";

/**
 * Every server the signed-in user belongs to, and whether their bot is in it.
 *
 * Two lists, from two different credentials, joined on guild id:
 *   the USER's token  -> every server they are a member of
 *   the BOT's token   -> the subset the bot has been invited to
 *
 * The difference between those lists is exactly the thing the settings page
 * needs: "here is where your tracker is blind, and here is the button to fix
 * it". Discord offers no way to get that from one credential, because a bot
 * genuinely cannot see a server it has not been added to.
 *
 * `can_invite` comes from the user's own MANAGE_GUILD bit. Rendering an invite
 * button where Discord will refuse it is worse than rendering none, so the UI
 * needs to know before it draws.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const db = createSupabaseServiceRoleClient();

  const { data: connection } = await db
    .from("tt_connections")
    .select("discord_user_token_cipher, discord_bot_token_cipher, discord_user_token_expires")
    .eq("user_id", user.id)
    .single();

  const userToken = tryOpen(connection?.discord_user_token_cipher);
  if (!userToken) {
    return NextResponse.json(
      {
        error:
          "Your Discord sign-in did not include server access. Sign out and back in to grant it.",
        needs_reauth: true,
      },
      { status: 400 },
    );
  }

  // The user's servers.
  let userGuilds;
  try {
    userGuilds = await getUserGuilds(userToken);
  } catch (error) {
    const needsReauth = error instanceof DiscordError && error.status === 401;
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
        needs_reauth: needsReauth,
      },
      { status: 400 },
    );
  }

  // The bot's servers, if a bot is connected at all. A user with no bot yet
  // still gets the full list — seeing where it *would* go is the point.
  const botToken = tryOpen(connection?.discord_bot_token_cipher);
  const botGuildIds = new Set<string>();

  if (botToken) {
    try {
      for (const guild of await getBotGuilds(botToken)) botGuildIds.add(guild.id);
    } catch {
      // A failing bot token is reported by its own panel; do not lose the
      // user's server list over it.
    }
  }

  const rows = userGuilds.map((guild) => ({
    user_id: user.id,
    guild_id: guild.id,
    guild_name: guild.name,
    icon: guild.icon,
    bot_present: botGuildIds.has(guild.id),
    can_invite: Boolean(guild.owner) || canInviteBot(guild.permissions),
    refreshed_at: new Date().toISOString(),
  }));

  if (rows.length > 0) {
    const { error } = await db.from("tt_guilds").upsert(rows, { onConflict: "user_id,guild_id" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Servers the user has since left should not linger as invite targets.
  const keep = userGuilds.map((g) => g.id);
  if (keep.length > 0) {
    await db
      .from("tt_guilds")
      .delete()
      .eq("user_id", user.id)
      .not("guild_id", "in", `(${keep.map((id) => `"${id}"`).join(",")})`);
  }

  return NextResponse.json({
    ok: true,
    total: rows.length,
    with_bot: rows.filter((r) => r.bot_present).length,
    invitable: rows.filter((r) => !r.bot_present && r.can_invite).length,
    has_bot: Boolean(botToken),
  });
}
