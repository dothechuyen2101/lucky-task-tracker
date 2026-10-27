/**
 * Where this deployment lives, for links that leave the app — the Discord
 * sign-in redirect and the "Board:" line in a reminder DM.
 *
 * Its own module, with no imports, so the worker can use it without pulling in
 * `lib/auth.ts` and the request-scoped Supabase client that comes with it.
 */
export function siteUrl(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  return "http://localhost:3000";
}

/** A link that opens the board focused on one task. */
export function taskUrl(taskId: string): string {
  return `${siteUrl()}/?task=${encodeURIComponent(taskId)}`;
}

/**
 * Everything on the person who opens it — given to them by anyone, from any
 * account (Lucky35, 2026-10-02: one place to look, not DMs and channels).
 */
export function mineUrl(): string {
  return `${siteUrl()}/?mine`;
}

/** The cookie that carries where to land after signing in, across the Discord round trip. */
export const NEXT_COOKIE = "tt_next";

/**
 * A place in THIS app to go after signing in, or "/" — never anywhere else.
 * Only a path: one leading "/", not "//" or "/\\" (both mean "another host" to a
 * browser), no scheme, no control characters. Whatever arrives in `?next=` or
 * the cookie was written by somebody's link, and an unchecked one turns the
 * sign-in page into a trampoline to any site (2026-09-30 audit).
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return "/";
  return raw;
}
