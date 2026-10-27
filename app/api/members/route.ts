import { NextResponse } from "next/server";

import { getUser } from "@/lib/auth";
import { tryOpen } from "@/lib/crypto";
import { DiscordError, type DiscordMember, listGuildMembers, searchGuildMembers } from "@/lib/discord";
import { memberOptions } from "@/lib/dm";
import type { MembersAnswer, PickablePerson } from "@/lib/members";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";

/**
 * Everyone the signed-in user can give work to: the members of every server
 * their bot is in (Lucky35's PO, 2026-10-05 — "Given to" offered only the
 * people already given something, and Rea was not among them).
 *
 *   GET          every member, when the bot has the Server Members Intent
 *   GET ?q=rea   members whose name starts with it — no intent needed
 *
 *   GET ?owner=… the same, from the servers of ANOTHER account's bot — for
 *                someone that owner named to keep their Developers list
 *                (`tt_dev_editors`), who picks developers from those servers
 *                without a bot of their own. Asked on the caller's own session
 *                (`tt_keeps_dev_list`), never taken from the request.
 *
 * The bot token is read and used here and never leaves the server; what goes
 * back is ids and names, the same the @ list in Discord shows everyone in it.
 */

export const runtime = "nodejs";
export const maxDuration = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Servers looked in, and members read from each — a ceiling, not a target. */
const MAX_SERVERS = 10;
const MAX_MEMBERS_PER_SERVER = 5000;

export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const query = (params.get("q") ?? "").trim().replace(/^@/, "");

  // Whose bot: the caller's own, or the owner of a Developers list they keep.
  const owner = (params.get("owner") ?? "").trim();
  let botOwner = user.id;
  if (owner !== "" && owner !== user.id) {
    if (!UUID.test(owner)) return NextResponse.json({ error: "Say whose list." }, { status: 400 });
    const supabase = await createSupabaseServerClient();
    const { data: keeps } = await supabase.rpc("tt_keeps_dev_list", { owner });
    if (keeps !== true) return NextResponse.json({ error: "You do not keep that list." }, { status: 403 });
    botOwner = owner;
  }

  const db = createSupabaseServiceRoleClient();

  const { data: connection } = await db
    .from("tt_connections")
    .select("discord_bot_token_cipher")
    .eq("user_id", botOwner)
    .maybeSingle();
  const botToken = tryOpen(connection?.discord_bot_token_cipher);
  if (!botToken) return NextResponse.json({ listing: "no_bot", members: [] } satisfies MembersAnswer);

  const servers = await serversOf(db, botOwner);

  if (query === "") {
    const found: Array<{ where: string | null; member: DiscordMember }> = [];
    try {
      for (const server of servers) {
        for (let after = "0", read = 0; read < MAX_MEMBERS_PER_SERVER; ) {
          const page = await listGuildMembers(botToken, server.id, after);
          for (const member of page) found.push({ where: server.name, member });
          read += page.length;
          if (page.length < 1000) break;
          after = page[page.length - 1].user.id;
        }
      }
    } catch (error) {
      // 403: the intent is off. The picker searches by name instead and says
      // how to switch it on. Anything else is said as it is.
      if (error instanceof DiscordError && error.status === 403) {
        return NextResponse.json({ listing: "search", members: [] } satisfies MembersAnswer);
      }
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
    }
    return NextResponse.json({ listing: "full", members: asPeople(found) } satisfies MembersAnswer);
  }

  if (query.length < 2) return NextResponse.json({ listing: "search", members: [] } satisfies MembersAnswer);
  const found: Array<{ where: string | null; member: DiscordMember }> = [];
  for (const server of servers) {
    try {
      for (const member of await searchGuildMembers(botToken, server.id, query, 10)) found.push({ where: server.name, member });
    } catch {
      // One server that will not answer leaves fewer people offered, not none.
    }
  }
  return NextResponse.json({ listing: "search", members: asPeople(found) } satisfies MembersAnswer);
}

/** The servers the bot is in: as Settings last saw them, else every server with a channel on file. */
async function serversOf(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
): Promise<Array<{ id: string; name: string | null }>> {
  const byId = new Map<string, string | null>();
  const { data: guilds } = await db.from("tt_guilds").select("guild_id, guild_name").eq("user_id", userId).eq("bot_present", true);
  for (const g of (guilds ?? []) as Array<{ guild_id: string; guild_name: string | null }>) byId.set(g.guild_id, g.guild_name);
  if (byId.size === 0) {
    const { data: channels } = await db.from("tt_channels").select("guild_id, guild_name").eq("user_id", userId).limit(1000);
    for (const c of (channels ?? []) as Array<{ guild_id: string; guild_name: string | null }>) byId.set(c.guild_id, c.guild_name);
  }
  return [...byId].slice(0, MAX_SERVERS).map(([id, name]) => ({ id, name }));
}

function asPeople(found: Array<{ where: string | null; member: DiscordMember }>): PickablePerson[] {
  return memberOptions(found).map((option) => ({
    id: option.id,
    name: option.names[0] ?? option.label,
    label: option.label,
    where: option.where,
  }));
}
