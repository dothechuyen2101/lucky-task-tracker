import { NextResponse } from "next/server";

import { authorizeCron } from "@/lib/cron-auth";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { DEFAULT_LIMITS, runTick } from "@/lib/worker";

/**
 * The scheduler's only entry point: poll Discord, classify, send reminders.
 *
 * Called once a minute by Vercel Cron (see `vercel.json`), which sends
 * `Authorization: Bearer $CRON_SECRET` once that variable exists on the
 * project. The same secret works as `?key=` so a Supabase pg_cron job, an
 * uptime pinger, or `pnpm tick` can drive it too — Vercel's per-minute cron
 * needs a Pro plan, and this endpoint should not care which of those is
 * ringing it.
 *
 * The route is public by necessity, so the secret is compared in constant time
 * and a missing CRON_SECRET refuses every request rather than defaulting open.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel kills a function at its limit mid-write. The worker's own budget
// (DEFAULT_LIMITS.budgetMs) is set below this so it stops itself first.
export const maxDuration = 60;

async function handle(request: Request) {
  if (!authorizeCron(request)) {
    return NextResponse.json(
      { error: process.env.CRON_SECRET ? "Unauthorized." : "CRON_SECRET is not set on the server." },
      { status: 401 },
    );
  }

  try {
    const summary = await runTick(createSupabaseServiceRoleClient(), DEFAULT_LIMITS);
    return NextResponse.json(summary);
  } catch (error) {
    // A 500 here is what makes Vercel's cron log show red. Return the reason.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
