import { secretsMatch } from "@/lib/crypto";

/**
 * Who may ring a cron route: Vercel Cron's `Authorization: Bearer
 * $CRON_SECRET`, or the same secret as `?key=` for a pg_cron job, an uptime
 * pinger or `pnpm tick`. Compared in constant time; a missing CRON_SECRET
 * refuses every request rather than defaulting open.
 */
export function authorizeCron(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
  const query = new URL(request.url).searchParams.get("key");

  return secretsMatch(bearer, expected) || secretsMatch(query, expected);
}
