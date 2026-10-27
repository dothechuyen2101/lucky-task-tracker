import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarDays, Inbox, LayoutGrid, Settings } from "lucide-react";

import { ScoreHistory } from "@/components/score-history";
import { requireUser } from "@/lib/auth";
import { nameFromEntries, parsePeriod } from "@/lib/score-history";
import { readScoreAdmin, readScoreEntries } from "@/lib/score-entries";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Person, Profile } from "@/lib/types/database";

/**
 * The score history — every point each person gained or lost, and why
 * (Lucky35's PO, 2026-10-09). `/scores?person=<discord id>&period=day|week|month&day=YYYY-MM-DD`.
 *
 * A page of its own, with a link of its own, because who may open it is the
 * point: each person sees their own history, Lucky35 everyone's. That is not
 * decided here — the entries are read on the caller's own session, and RLS
 * hands back only what they may read (`20261009_01`). This page only says so
 * plainly when a link names somebody else's history, instead of showing an
 * empty one that would read as "no points".
 *
 * It writes nothing itself; a correction goes through `tt_correct_score`,
 * which checks who is asking again.
 */

// Verdicts land between requests; the history is never cached.
export const dynamic = "force-dynamic";

/** The moment of this request — which day "today" is. */
function requestTime(): Date {
  return new Date();
}

export default async function ScoresPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (!isSupabaseConfigured) redirect("/");

  const params = await searchParams;
  const pick = (key: string) => (typeof params[key] === "string" ? (params[key] as string).trim() : "");
  const asked = new URLSearchParams(
    Object.entries({ person: pick("person"), period: pick("period"), day: pick("day") }).filter((e) => e[1] !== ""),
  ).toString();
  const user = await requireUser(asked ? `/scores?${asked}` : "/scores");
  const supabase = await createSupabaseServerClient();

  const [{ data: profileRow }, { data: me }, admin, entries, peopleResult] = await Promise.all([
    supabase.from("tt_profiles").select("*").eq("id", user.id).maybeSingle(),
    // Who the caller IS — from what only Supabase Auth writes, never a profile field.
    supabase.rpc("tt_my_discord_id"),
    readScoreAdmin(supabase),
    readScoreEntries(supabase),
    supabase.from("tt_people").select("*"),
  ]);
  if (!profileRow) redirect("/");
  const profile = profileRow as Profile;
  const zone = profile.timezone || "UTC";
  const self = typeof me === "string" ? me : "";

  const now = requestTime();
  const period = parsePeriod(pick("period"), pick("day"), now, zone);
  // Lucky35 chooses whose; everyone else has one history: their own.
  const askedFor = pick("person");
  const person = admin ? askedFor || null : self;
  const refused = !admin && askedFor !== "" && askedFor !== self;

  const people = (peopleResult.data ?? []) as Person[];
  const names = new Map<string, string>();
  for (const row of people) {
    const name = row.display_name?.trim();
    if (row.discord_user_id && name) names.set(row.discord_user_id, name);
  }
  const everyone = [...new Set(entries.data.map((e) => e.person_discord_id))]
    .map((id) => ({ id, name: names.get(id) ?? nameFromEntries(entries.data, id) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <main className="main">
      <div className="page-head">
        <h1 className="mark">
          Task Tracker
          <span>{profile.discord_username ?? "LookUp Media"}</span>
        </h1>
        <div className="head-actions">
          <Link className="btn btn-sm" href="/">
            <LayoutGrid /> Board
          </Link>
          <Link className="btn btn-sm" href="/?mine">
            <Inbox /> My tasks
          </Link>
          <Link className="btn btn-sm" href="/summary">
            <CalendarDays /> Monthly
          </Link>
          <Link className="btn btn-sm" href="/settings">
            <Settings /> Settings
          </Link>
        </div>
      </div>

      {refused ? (
        <div className="person-view score-history">
          <section className="panel score-refused" role="alert">
            <h2 className="person-panel-name">Not yours to see</h2>
            <p>
              Each person sees only their own score history; only Lucky35 sees everyone&apos;s. Nothing of that
              history was loaded.
            </p>
            <Link className="btn btn-sm" href="/scores">
              Your own history
            </Link>
          </section>
        </div>
      ) : entries.error ? (
        <div className="notice">
          <strong>The score history could not be read</strong>
          {entries.error}
          <p style={{ margin: "8px 0 0", color: "var(--muted)" }}>
            If it does not exist yet, apply <code>supabase/migrations/20261009_01_score_history.sql</code>.
          </p>
        </div>
      ) : !self ? (
        <div className="notice">
          <strong>No Discord account</strong>
          Your score history is kept by your Discord account. Sign out and sign in again with Discord.
        </div>
      ) : (
        <ScoreHistory
          entries={entries.data}
          viewer={{ discordId: self, admin }}
          person={person}
          people={admin ? everyone : [{ id: self, name: profile.discord_username ?? names.get(self) ?? "You" }]}
          period={period}
          zone={zone}
          renderedAt={now.toISOString()}
        />
      )}
    </main>
  );
}
