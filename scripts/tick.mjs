#!/usr/bin/env node
/**
 * Run one tick against a deployed instance, by hand.
 *
 * Vercel's per-minute cron needs a Pro plan; this is how you drive the same
 * endpoint from anywhere else — your laptop while testing, a Supabase pg_cron
 * job, or an uptime pinger. It sends exactly what Vercel Cron sends.
 *
 *   pnpm tick                              # hits $NEXT_PUBLIC_SITE_URL
 *   pnpm tick -- https://tracker.vercel.app
 */

const url = process.argv[2] ?? process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
const secret = process.env.CRON_SECRET;

if (!secret) {
  console.error("CRON_SECRET is not set. Export it, or put it in your shell env.");
  process.exit(1);
}

const endpoint = `${url.replace(/\/$/, "")}/api/cron/tick`;
const startedAt = Date.now();

const response = await fetch(endpoint, {
  method: "POST",
  headers: { Authorization: `Bearer ${secret}` },
});

const body = await response.json().catch(() => ({}));

if (!response.ok) {
  console.error(`${response.status} ${response.statusText}`);
  console.error(body);
  process.exit(1);
}

console.log(`${endpoint} -> ${response.status} in ${Date.now() - startedAt}ms`);
console.log(JSON.stringify(body, null, 2));

if (Array.isArray(body.errors) && body.errors.length > 0) {
  console.log("");
  console.log(`${body.errors.length} error(s) recorded on this run.`);
}
