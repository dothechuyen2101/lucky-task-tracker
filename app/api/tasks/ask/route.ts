import { NextResponse } from "next/server";

import { ASK_MAX_TASKS, type AskTask, askLines, cleanQuestion, matchesOf, peopleLegend, pickedCount, todayIn } from "@/lib/ask";
import { getUser } from "@/lib/auth";
import { askAboutTasks } from "@/lib/claude";
import { tryOpen } from "@/lib/crypto";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";

/**
 * "Did I already give someone a task about X?" (Lucky35, 2026-10-12).
 *
 * The board's owner asks in plain words; every task they have GIVEN — open
 * and finished, on their own board and nobody else's — goes to Claude as one
 * numbered line each (`askLines`), on the owner's OWN Anthropic credential
 * (there is no app-level key, CLAUDE.md). Claude names tasks by number; what
 * is sent back about each comes from the database (`matchesOf`), so an
 * invented task is impossible.
 *
 * A route because the credential is a secret: it is opened here, with the
 * service role, and never leaves the server. The tasks themselves are read on
 * the caller's own session, so RLS still decides what they are.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const FIELDS =
  "id, title, detail, assignee_name, assignee_discord_id, status, stage, review_state, deadline, created_at, completed_at, requested_by_name";

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { question?: unknown };
  const question = cleanQuestion(body.question);
  if (!question) return NextResponse.json({ error: "Ask a question — what is the task about?" }, { status: 400 });

  const db = createSupabaseServiceRoleClient();
  const { data: connection } = await db
    .from("tt_connections")
    .select("anthropic_key_cipher, anthropic_model")
    .eq("user_id", user.id)
    .maybeSingle();
  const apiKey = tryOpen(connection?.anthropic_key_cipher);
  if (!apiKey) {
    return NextResponse.json({ error: "Connect your Anthropic key in Settings first — the question runs on it." }, { status: 400 });
  }

  // Every task this owner gave, newest first, page by page — Supabase stops
  // at 1000 rows without a word (AGENTS.md).
  const supabase = await createSupabaseServerClient();
  const tasks: AskTask[] = [];
  for (let from = 0; from < ASK_MAX_TASKS; from += 1000) {
    const { data, error } = await supabase
      .from("tt_tasks")
      .select(FIELDS)
      .eq("user_id", user.id)
      .eq("direction", "given")
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, Math.min(from + 999, ASK_MAX_TASKS - 1));
    if (error) return NextResponse.json({ error: `Could not read your tasks: ${error.message}` }, { status: 500 });
    tasks.push(...((data ?? []) as AskTask[]));
    if ((data ?? []).length < 1000) break;
  }
  if (tasks.length === 0) {
    return NextResponse.json({ answer: "You have not given anyone a task yet.", matches: [], searched: 0 });
  }

  const { data: profile } = await supabase.from("tt_profiles").select("timezone").eq("id", user.id).maybeSingle();
  const zone = (profile as { timezone?: string | null } | null)?.timezone || "UTC";

  const result = await askAboutTasks({
    apiKey,
    model: (connection?.anthropic_model as string | null) ?? "",
    question,
    people: peopleLegend(tasks, await aliasesOf(supabase, user.id)),
    list: askLines(tasks, zone),
    count: tasks.length,
    today: todayIn(new Date(), zone),
    timezone: zone,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.failure === "unavailable" ? 502 : 422 });

  const matches = matchesOf(result.matches, tasks);
  return NextResponse.json({
    answer: result.answer,
    matches,
    more: pickedCount(result.matches, tasks) - matches.length,
    searched: tasks.length,
  });
}

/**
 * The other names the owner's people go by, by Discord id — so "what did I
 * give Leo?" finds @thuan2172001: the display name they tag the bot under,
 * their ClickUp name on the Developers list, how the owner noted them. All
 * read on the owner's own session; any of it missing is only fewer names.
 */
async function aliasesOf(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  ownerId: string,
): Promise<Map<string, Set<string>>> {
  const aliases = new Map<string, Set<string>>();
  const add = (id: string | null | undefined, name: string | null | undefined) => {
    const key = (id ?? "").trim();
    const value = (name ?? "").trim();
    if (!key || !value) return;
    const names = aliases.get(key) ?? new Set<string>();
    names.add(value);
    aliases.set(key, names);
  };

  const [messages, people, developers, clickup] = await Promise.all([
    supabase.from("tt_messages").select("author_id, author_name").eq("user_id", ownerId).order("sent_at", { ascending: false }).limit(1000),
    supabase.from("tt_people").select("discord_user_id, display_name").eq("user_id", ownerId).limit(1000),
    supabase.from("tt_developers").select("discord_user_id, clickup_user_id, name, discord_name").eq("owner_id", ownerId).limit(1000),
    supabase.from("tt_clickup_state").select("members").eq("owner_id", ownerId).maybeSingle(),
  ]);
  for (const m of (messages.data ?? []) as Array<{ author_id: string | null; author_name: string | null }>) add(m.author_id, m.author_name);
  for (const p of (people.data ?? []) as Array<{ discord_user_id: string | null; display_name: string | null }>) add(p.discord_user_id, p.display_name);
  const clickupNames = new Map(
    (((clickup.data as { members?: Array<{ id: string; name: string }> } | null)?.members ?? []) as Array<{ id: string; name: string }>).map(
      (member) => [member.id, member.name],
    ),
  );
  for (const d of (developers.data ?? []) as Array<{ discord_user_id: string | null; clickup_user_id: string | null; name: string; discord_name: string | null }>) {
    add(d.discord_user_id, d.name);
    add(d.discord_user_id, d.discord_name);
    if (d.clickup_user_id) add(d.discord_user_id, clickupNames.get(d.clickup_user_id));
  }
  return aliases;
}
