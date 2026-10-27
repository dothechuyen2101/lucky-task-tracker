import { NextResponse } from "next/server";

import { clickUpConfig, syncClickUp } from "@/lib/clickup-sync";
import { authorizeCron } from "@/lib/cron-auth";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";

/**
 * The ClickUp read for the Developers list, on its own clock (2026-10-13).
 *
 * It used to run inside `/api/cron/tick`, after the reminders. The tick
 * already runs close to its 60 seconds, and the read of every task pushed it
 * over: Vercel cut ticks mid-run ("Task timed out after 60 seconds"). Here it
 * has a function of its own, rung every minute by Vercel Cron (`vercel.json`)
 * — or by whatever rings the tick, with the same secret — and can never
 * delay a reminder or a Discord read.
 *
 * A failure is written on `tt_clickup_state` for the page (`syncClickUp`
 * never throws); this answers with what it did.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!authorizeCron(request)) {
    return NextResponse.json(
      { error: process.env.CRON_SECRET ? "Unauthorized." : "CRON_SECRET is not set on the server." },
      { status: 401 },
    );
  }
  if (!clickUpConfig()) return NextResponse.json({ skipped: "ClickUp is not configured (CLICKUP_* variables)." });

  const startedAt = Date.now();
  const summary = { errors: [] as string[] };
  await syncClickUp(createSupabaseServiceRoleClient(), summary, new Date());
  return NextResponse.json({ ok: summary.errors.length === 0, errors: summary.errors, duration_ms: Date.now() - startedAt });
}

export const GET = handle;
export const POST = handle;
