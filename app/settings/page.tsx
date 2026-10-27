import { headers } from "next/headers";

import { SettingsForm } from "@/components/settings-form";
import { requireUser } from "@/lib/auth";
import { siteUrl } from "@/lib/site";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Channel, ConnectionStatus, Guild, Profile, ProjectCategories } from "@/lib/types/database";

export const dynamic = "force-dynamic";

/** The moment of this request: whether the Discord sign-in behind "Your servers" has run out. */
function renderTime(): string {
  return new Date().toISOString();
}

export default async function SettingsPage() {
  const user = await requireUser("/settings");
  const supabase = await createSupabaseServerClient();

  const [profileResult, connectionResult, channelsResult, guildsResult, categoriesResult] = await Promise.all([
    supabase.from("tt_profiles").select("*").eq("id", user.id).single(),
    supabase.from("tt_connection_status").select("*").maybeSingle(),
    supabase
      .from("tt_channels")
      .select("*")
      .order("guild_name", { ascending: true })
      .order("channel_name", { ascending: true }),
    supabase.from("tt_guilds").select("*").order("guild_name", { ascending: true }),
    // Empty on an error (`20261004_01` not applied yet): the section still lists the channels.
    supabase.from("tt_project_categories").select("*"),
  ]);

  // The origin the browser actually used — the same text on the server and in
  // the browser. Falls back to the configured site when the host is missing.
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const proto = requestHeaders.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  const origin = host && /^[a-z0-9.:-]+$/i.test(host) ? `${proto.split(",")[0].trim()}://${host}` : siteUrl();

  return (
    <SettingsForm
      origin={origin}
      profile={profileResult.data as Profile}
      connections={(connectionResult.data as ConnectionStatus | null) ?? null}
      channels={(channelsResult.data ?? []) as Channel[]}
      guilds={(guildsResult.data ?? []) as Guild[]}
      projectCategories={(categoriesResult.data ?? []) as ProjectCategories[]}
      renderedAt={renderTime()}
    />
  );
}
