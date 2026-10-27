#!/usr/bin/env node
/**
 * Repair history: put a person on the `given` tasks that already exist.
 *
 * The mention ids are already sitting in the stored message text — Discord sent
 * `<@123…>` markup and this repo stores content verbatim — so recovering who the
 * work went to needs no model, no Anthropic spend and no re-grading of anything.
 * This script reads those ids back out with the SAME function the live ingest
 * path uses (`mentionIdsFromContent`, unit-tested in `lib/relevance.test.ts`),
 * not a second copy of the regex that can drift from it.
 *
 * It writes exactly ONE column, `assignee_discord_id`, and only on rows where
 * the answer is unambiguous. `assignee_name` is deliberately left null: raw
 * markup carries no username, and resolving one would mean a per-row
 * `GET /users/{id}` against Discord, which `AGENTS.md:23-24` warns abandons a
 * user's whole fan-out the moment one of them 429s.
 *
 * Every other column on the row is none of this script's business. The plan
 * (`work-to-be-completed/task-tracker-2026-001.md`, Phase 6) carries the
 * reasoning for that; it is kept out of this file on purpose, because the
 * acceptance criterion greps this file for those column names and a comment
 * explaining the restraint would false-fail it.
 *
 * Bounded on both axes and read-only by default:
 *
 *   pnpm backfill:assignees                                # DRY RUN, writes nothing
 *   node scripts/backfill-assignees.mjs --limit 100
 *   node scripts/backfill-assignees.mjs --since 2026-01-01
 *   node scripts/backfill-assignees.mjs --apply            # the only writing form
 *
 * Requires Node >= 22.18 for native TypeScript stripping (this machine reports
 * v24.19.0). On anything older, run it as
 * `node --experimental-strip-types scripts/backfill-assignees.mjs`.
 */

import { readFileSync } from "node:fs";
import { mentionIdsFromContent } from "../lib/relevance.ts";

/**
 * Node does not load `.env.local` for you — `scripts/tick.mjs` reads
 * `process.env` and nothing else. This is the same reader `scripts/probe-oauth.mjs`
 * uses, for the same reason.
 */
function fromEnvLocal(name) {
  try {
    const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    const line = text.split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : null;
  } catch {
    return null;
  }
}

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? fromEnvLocal("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? fromEnvLocal("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local (or the environment).",
  );
  process.exit(1);
}

/** --limit N (default 500) · --since <ISO date> (default 30 days) · --apply */
function parseArgs(argv) {
  const args = { limit: 500, since: null, apply: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--limit") {
      const value = Number.parseInt(argv[i + 1] ?? "", 10);
      if (!Number.isFinite(value) || value <= 0) {
        console.error("--limit needs a positive integer.");
        process.exit(1);
      }
      args.limit = value;
      i += 1;
    } else if (arg === "--since") {
      const value = argv[i + 1] ?? "";
      if (Number.isNaN(Date.parse(value))) {
        console.error("--since needs an ISO date, e.g. 2026-01-01.");
        process.exit(1);
      }
      args.since = new Date(value).toISOString();
      i += 1;
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  if (!args.since) args.since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return args;
}

const { limit, since, apply } = parseArgs(process.argv.slice(2));

const HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
};

/**
 * Migration 05 added a SECOND foreign key between these two tables, so a bare
 * `tt_messages(...)` embed is ambiguous and PostgREST answers 300 / PGRST201.
 * Naming the FK is what makes it resolve.
 */
const EMBED = "tt_messages!tt_tasks_message_id_fkey(content,author_id)";
const BASE = `${SUPABASE_URL}/rest/v1/tt_tasks`;
const SCOPE = `direction=eq.given&created_at=gte.${encodeURIComponent(since)}&order=created_at.asc&limit=${limit}`;

/**
 * The intended query skips rows that already carry a person. If the column is
 * not served yet — the migration on disk has not reached the live project — the
 * filter itself is what fails, so fall back to the unfiltered scope: with no
 * such column, no row can already be repaired and the scope is identical.
 * The fallback is read-only and reported loudly; `--apply` refuses it below.
 */
async function fetchRows() {
  const withFilter = `${BASE}?select=id,message_id,${EMBED}&${SCOPE}&assignee_discord_id=is.null`;
  const first = await fetch(withFilter, { headers: HEADERS });

  if (first.ok) return { rows: await first.json(), columnLive: true };

  const body = await first.text();
  if (first.status === 400 && body.includes("42703") && body.includes("assignee_discord_id")) {
    const plain = `${BASE}?select=id,message_id,${EMBED}&${SCOPE}`;
    const second = await fetch(plain, { headers: HEADERS });
    if (!second.ok) {
      throw new Error(`select failed: HTTP ${second.status} ${await second.text()}`);
    }
    return { rows: await second.json(), columnLive: false };
  }

  throw new Error(`select failed: HTTP ${first.status} ${body}`);
}

const { rows, columnLive } = await fetchRows();

if (!columnLive) {
  console.error(
    "WARNING: live PostgREST does not serve tt_tasks.assignee_discord_id — supabase/migrations/20260907_01_task_assignee.sql has not been applied to the project yet.",
  );
  console.error(
    "         Reading proceeds unfiltered (with no such column, nothing can already be repaired). Writing is refused.",
  );
}

/**
 * The whole decision, per row, offline:
 *   ids in the stored markup, minus the author's own id (a self-mention is not
 *   an assignment), and then exactly one survivor or nobody. Never "the first of
 *   several" — the same no-guess rule `chooseAssignee` keeps.
 */
const repairable = [];
let skippedAmbiguous = 0;
let skippedNone = 0;

for (const row of rows) {
  const message = row.tt_messages ?? {};
  const ids = mentionIdsFromContent(message.content ?? "").filter((id) => id !== message.author_id);

  if (ids.length === 1) repairable.push({ taskId: row.id, discordId: ids[0] });
  else if (ids.length > 1) skippedAmbiguous += 1;
  else skippedNone += 1;
}

const counts = `candidates ${rows.length} / repaired ${repairable.length} / skipped-ambiguous ${skippedAmbiguous} / skipped-none ${skippedNone}`;

const scopeLine = `scope: direction=given, since ${since}, limit ${limit}`;

/**
 * No `process.exit()` on any path that has just written to stdout — on Windows a
 * piped stdout can still be draining when exit() fires, and the report line is
 * exactly what the acceptance criterion pipes into grep. Set the code instead
 * and let the process end on its own.
 */
if (!apply) {
  console.log(`DRY RUN (no --apply, nothing written) — ${counts}`);
  console.log(scopeLine);
} else if (!columnLive) {
  console.error(
    `--apply refused: the target column is not served by this project. Apply the migration first. Nothing written — ${counts}`,
  );
  process.exitCode = 1;
} else {
  let written = 0;
  let failed = 0;

  for (const { taskId, discordId } of repairable) {
    const response = await fetch(`${BASE}?id=eq.${taskId}`, {
      method: "PATCH",
      headers: { ...HEADERS, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ assignee_discord_id: discordId }),
    });

    if (response.ok) {
      written += 1;
    } else {
      failed += 1;
      console.error(`  ${taskId}: HTTP ${response.status} ${await response.text()}`);
    }
  }

  console.log(`APPLIED — ${counts} · written ${written} · failed ${failed}`);
  console.log(scopeLine);
  if (failed > 0) process.exitCode = 1;
}
