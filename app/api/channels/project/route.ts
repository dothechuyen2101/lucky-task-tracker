import { NextResponse } from "next/server";

import { getUser } from "@/lib/auth";
import { tryOpen } from "@/lib/crypto";
import { DiscordError, createCategory, getGuildChannels, moveChannel } from "@/lib/discord";
import { botInviteUrl } from "@/lib/discord-links";
import { type ProjectState, chooseCategory } from "@/lib/projects";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";

/**
 * Move one project channel into the server's "Active projects" or "Done
 * projects" category (Lucky35, 2026-10-04) — creating the category the first
 * time, or an overflow when the last is full (`chooseCategory`).
 *
 * A route because it is the user's bot acting in their server: the token is
 * opened here and never reaches a browser. The channel must be one of the
 * caller's own `tt_channels` rows — the list Refresh built from what their bot
 * can see — so nobody moves a channel by guessing its id.
 *
 * The bot needs Manage Channels, which the ordinary invite deliberately does
 * not ask for. Without it Discord answers 403, and the answer carries the
 * invite that does (`PROJECT_BOT_PERMISSIONS`).
 */

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { channelId?: unknown; to?: unknown };
  const to = body.to === "active" || body.to === "done" ? (body.to as ProjectState) : null;
  if (typeof body.channelId !== "string" || !to) {
    return NextResponse.json({ error: "Say which channel, and active or done." }, { status: 400 });
  }
  const channelId = body.channelId;

  const db = createSupabaseServiceRoleClient();
  const [{ data: channel }, { data: connection }] = await Promise.all([
    db
      .from("tt_channels")
      .select("guild_id, guild_name, channel_name, parent_id")
      .eq("user_id", user.id)
      .eq("channel_id", channelId)
      .maybeSingle(),
    db.from("tt_connections").select("discord_bot_token_cipher, discord_bot_user_id").eq("user_id", user.id).maybeSingle(),
  ]);
  if (!channel) return NextResponse.json({ error: "That channel is not on your list. Refresh from Discord." }, { status: 404 });

  const token = tryOpen(connection?.discord_bot_token_cipher);
  if (!token) return NextResponse.json({ error: "Connect a Discord bot first." }, { status: 400 });

  const server = channel.guild_name ?? "that server";
  const invite = connection?.discord_bot_user_id
    ? botInviteUrl(connection.discord_bot_user_id, channel.guild_id, { manageChannels: true })
    : null;

  const { data: stored } = await db
    .from("tt_project_categories")
    .select("active_category_id, done_category_id")
    .eq("user_id", user.id)
    .eq("guild_id", channel.guild_id)
    .maybeSingle();

  try {
    const listing = await getGuildChannels(token, channel.guild_id);
    const current = listing.find((c) => c.id === channelId);
    if (!current) {
      return NextResponse.json({ error: `Discord no longer shows #${channel.channel_name ?? channelId} to your bot. Refresh from Discord.` }, { status: 404 });
    }

    const choice = chooseCategory(listing, to, (to === "done" ? stored?.done_category_id : stored?.active_category_id) ?? null);
    const category = "create" in choice ? await createCategory(token, channel.guild_id, choice.create) : choice;

    if (current.parent_id !== category.id) {
      await moveChannel(
        token,
        channelId,
        category.id,
        to === "done" ? "Task Tracker: project marked done" : "Task Tracker: project marked active",
      );
    }

    await Promise.all([
      db.from("tt_project_categories").upsert(
        {
          user_id: user.id,
          guild_id: channel.guild_id,
          [to === "done" ? "done_category_id" : "active_category_id"]: category.id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,guild_id" },
      ),
      db
        .from("tt_channels")
        .update({ parent_id: category.id, parent_name: category.name })
        .eq("user_id", user.id)
        .eq("channel_id", channelId),
    ]);

    return NextResponse.json({ ok: true, channelId, parent_id: category.id, parent_name: category.name, to });
  } catch (error) {
    if (error instanceof DiscordError && error.status === 403) {
      return NextResponse.json(
        {
          error: `Your bot is not allowed to manage channels in ${server}. Invite it again with the link below — it asks for Manage Channels — or give its role that permission in Discord.`,
          invite,
        },
        { status: 403 },
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: detail }, { status: 502 });
  }
}
