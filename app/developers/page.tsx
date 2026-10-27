import { redirect } from "next/navigation";

import { DevelopersView } from "@/components/developers-view";
import { requireUser } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { ClickUpState, ClickUpTask, DevEditor, Developer, Profile } from "@/lib/types/database";

/**
 * Developers — which dev is on what, kept by hand, seen live (Lucky35's PO,
 * 2026-10-05). The owner's own list, and every list somebody else named the
 * viewer to keep; both through RLS (`20261005_03_developers.sql`), so there is
 * no filter here to forget. Changes arrive over Realtime in the view.
 */

// Somebody else keeps these lists too; the page is never cached.
export const dynamic = "force-dynamic";

/** The moment this page was rendered — the view's clock starts from it. */
function renderTime(): string {
  return new Date().toISOString();
}

/**
 * Every ClickUp task the viewer may read — a manager's all, a developer's own
 * (RLS, `20261012_03`) — page by page: Supabase stops at 1000 rows without a
 * word (AGENTS.md). A database without the table gives none.
 */
async function clickUpTasks(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>): Promise<ClickUpTask[]> {
  const tasks: ClickUpTask[] = [];
  for (let from = 0; from < 20_000; from += 1000) {
    const { data, error } = await supabase
      .from("tt_clickup_tasks")
      .select("*")
      .order("updated_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) return tasks;
    tasks.push(...((data ?? []) as ClickUpTask[]));
    if ((data ?? []).length < 1000) break;
  }
  return tasks;
}

export default async function DevelopersPage() {
  if (!isSupabaseConfigured) redirect("/");
  const user = await requireUser("/developers");
  const supabase = await createSupabaseServerClient();

  const [profileResult, connectionResult, developersResult, editorsResult, clickupResult, tasks] = await Promise.all([
    supabase.from("tt_profiles").select("*").eq("id", user.id).maybeSingle(),
    supabase.from("tt_connection_status").select("discord_connected").maybeSingle(),
    supabase.from("tt_developers").select("*").order("sort_order", { ascending: true }).limit(1000),
    supabase.from("tt_dev_editors").select("*").order("created_at", { ascending: true }).limit(1000),
    // Which lists ClickUp feeds (`20261012_01`); a database without it feeds none.
    supabase.from("tt_clickup_state").select("*").limit(100),
    clickUpTasks(supabase),
  ]);

  // No profile: the board says why, and what to do about it.
  if (!profileResult.data) redirect("/");

  const setupError = developersResult.error ?? editorsResult.error;

  return (
    <DevelopersView
      profile={profileResult.data as Profile}
      // Someone with a bot hands out work and has a list of their own; someone
      // who only keeps another's list is not shown an empty one of theirs.
      ownListAnyway={Boolean((connectionResult.data as { discord_connected?: boolean } | null)?.discord_connected)}
      developers={(developersResult.data ?? []) as Developer[]}
      editors={(editorsResult.data ?? []) as DevEditor[]}
      clickup={(clickupResult.error ? [] : (clickupResult.data ?? [])) as ClickUpState[]}
      clickupTasks={tasks}
      renderedAt={renderTime()}
      setupError={setupError ? setupError.message : null}
    />
  );
}
