import type { SupabaseClient } from "@supabase/supabase-js";

import { getBotRoleId } from "@/lib/discord";

/**
 * Learning the role Discord made for a user's bot in one server — shared by the
 * worker (the first live tag of an unknown role), the channel refresh (every
 * server, up front) and backfill (before it reads a single page of history).
 *
 * Server-only: it calls Discord with the bot token and writes with the service
 * role. The rule it exists for (Lucky35, 2026-09-29): a tag of the bot's role
 * must never be passed over silently. So a lookup that fails is reported as a
 * failure, never as "no role", and history read before the role was known is
 * marked to be read again rather than left quietly incomplete.
 */

export const RESCAN_REASON =
  "This channel's history was read before the bot's role in this server was known, so messages that tagged the role were passed over. Backfill reads it again.";

export type EnsureRoleInput = {
  userId: string;
  botToken: string;
  botUserId: string;
  guildId: string;
};

/**
 * Make sure the bot's role in this server is on `tt_connections`. Returns every
 * role id known afterwards and the one learned now (null when it was already
 * known, or the bot has none there) — or null when Discord would not say, in
 * which case the caller must not read that server's messages as if it knew.
 */
export async function ensureBotRole(
  db: SupabaseClient,
  { userId, botToken, botUserId, guildId }: EnsureRoleInput,
): Promise<{ known: string[]; learned: string | null } | null> {
  let roleId: string | null;
  try {
    roleId = await getBotRoleId(botToken, guildId, botUserId);
  } catch {
    return null;
  }

  // Re-read right before writing: the worker and a Settings request can both
  // be learning roles for the same user, and the column is written whole.
  const { data } = await db.from("tt_connections").select("discord_bot_role_ids").eq("user_id", userId).maybeSingle();
  const known = ((data?.discord_bot_role_ids as string[] | null) ?? []).slice();

  if (!roleId || known.includes(roleId)) return { known, learned: null };

  known.push(roleId);
  await db.from("tt_connections").update({ discord_bot_role_ids: known }).eq("user_id", userId);

  // Any history in this server already read was read without the role: every
  // tag of it there was passed over. Say so on the channel and reopen its
  // backfill from the top, so Settings shows the work and Backfill redoes it.
  await db
    .from("tt_channels")
    .update({ rescan_reason: RESCAN_REASON, backfill_done: false, backfill_before_id: null })
    .eq("user_id", userId)
    .eq("guild_id", guildId)
    .not("backfilled_at", "is", null);

  return { known, learned: roleId };
}
