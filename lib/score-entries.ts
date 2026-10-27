import type { SupabaseClient } from "@supabase/supabase-js";

import type { ScoreEntry } from "@/lib/types/database";

/**
 * Reading the score history (`tt_score_entries`, `20261009_01`) on the
 * signed-in person's OWN session: RLS hands back their own entries — and,
 * for Lucky35, everyone's — so there is no filter here to forget, and none to
 * get wrong. Used by the board and the history page alike.
 */

/** Supabase caps a response at 1000 rows and says nothing (AGENTS.md). */
const PAGE = 1000;

/**
 * Every entry the caller may read, oldest first, a page at a time — the
 * history only ever grows. An error (the migration not applied yet) is said,
 * never read as "no points".
 */
export async function readScoreEntries(db: SupabaseClient): Promise<{ data: ScoreEntry[]; error: string | null }> {
  const rows: ScoreEntry[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("tt_score_entries")
      .select("*")
      .order("seq", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { data: rows, error: error.message };
    rows.push(...((data ?? []) as ScoreEntry[]));
    if (!data || data.length < PAGE) return { data: rows, error: null };
  }
}

/** Whether the caller is Lucky35 (`tt_score_admins`). False on any error. */
export async function readScoreAdmin(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db.rpc("tt_is_score_admin");
  return !error && data === true;
}
