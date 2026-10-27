import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";

import { safeNextPath } from "@/lib/site";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The signed-in user, or a redirect to the login page. Every page and every API
 * route that touches user data starts here — including the ones whose queries
 * are already RLS-scoped, because a 401 you can read beats an empty list you
 * have to interpret.
 *
 * `next` is where the page was going, carried through the sign-in so a
 * reminder's "?task=" link opens that task afterwards, not the board's first
 * card (2026-09-30 audit).
 */
export async function requireUser(next = "/"): Promise<User> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const path = safeNextPath(next);
    redirect(path === "/" ? "/login" : `/login?next=${encodeURIComponent(path)}`);
  }
  return user;
}

/** The same, for API routes: null instead of a redirect. */
export async function getUser(): Promise<User | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ?? null;
}

/**
 * The Discord snowflake behind this account.
 *
 * Supabase puts the provider's user id in a couple of places depending on when
 * the identity was linked, so all of them are checked. Without this the poller
 * has no way to tell the user's own messages from everyone else's, which is the
 * one thing it has to get right.
 */
export function discordIdentity(user: User): {
  id: string | null;
  username: string | null;
  avatarUrl: string | null;
} {
  const identity = user.identities?.find((i) => i.provider === "discord");
  const meta = { ...(identity?.identity_data ?? {}), ...user.user_metadata };

  return {
    id:
      (identity?.id as string | undefined) ??
      (meta.provider_id as string | undefined) ??
      (meta.sub as string | undefined) ??
      null,
    username:
      (meta.full_name as string | undefined) ??
      (meta.name as string | undefined) ??
      (meta.user_name as string | undefined) ??
      (meta.preferred_username as string | undefined) ??
      null,
    avatarUrl: (meta.avatar_url as string | undefined) ?? (meta.picture as string | undefined) ?? null,
  };
}

/** Where Discord sends the browser back to after consent. */
export { siteUrl } from "@/lib/site";
