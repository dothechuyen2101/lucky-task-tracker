import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { discordIdentity } from "@/lib/auth";
import { NEXT_COOKIE, safeNextPath } from "@/lib/site";
import { seal } from "@/lib/crypto";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";

/**
 * Where Discord sends the browser back after consent.
 *
 * Two jobs: turn the code into a session, and copy the Discord identity onto
 * the profile. The second one runs on every sign-in rather than only at
 * sign-up, because a user who changes their Discord display name should not
 * have a stale one sitting in the database forever — and because the snowflake
 * is the poller's only way to recognise its owner's messages, so it is worth
 * refreshing from the source each time rather than trusting a row written once.
 */
/**
 * Supabase's OAuth failures arrive as provider-level jargon with a random
 * four-character suffix. They are accurate and completely unactionable — the
 * one that matters here, "Unable to exchange external code", means the token
 * exchange with Discord was rejected, which in practice always means the
 * Discord secret in Supabase is wrong. Say that, and keep the original text so
 * the real error is never hidden.
 */
function explain(raw: string): string {
  if (raw.includes("Unable to exchange external code")) {
    return (
      "Discord rejected the sign-in. The Discord Client Secret stored in Supabase is wrong or " +
      "has been reset — copy it again from the Discord app's OAuth2 tab (not the Public Key on " +
      `General Information) into Authentication → Providers → Discord. [${raw}]`
    );
  }

  if (raw.includes("OAuth state parameter missing")) {
    return "That sign-in link had expired or was opened directly. Start again from this page.";
  }

  if (raw.toLowerCase().includes("redirect")) {
    return (
      "Supabase refused the redirect target. Add this app's origin to Authentication → " +
      `URL Configuration → Redirect URLs. [${raw}]`
    );
  }

  return raw;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  // Only ever a path inside this app: `new URL("//evil.example", origin)` is
  // evil.example, and this parameter is whatever a link put there.
  const jar = await cookies();
  const carried = jar.get(NEXT_COOKIE)?.value;
  const next = safeNextPath(url.searchParams.get("next") ?? decoded(carried));

  if (!code) {
    const raw = url.searchParams.get("error_description") ?? "No authorization code returned.";
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(explain(raw))}`, url.origin),
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.user) {
    const detail = explain(error?.message ?? "Could not complete sign-in.");
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(detail)}`, url.origin));
  }

  const identity = discordIdentity(data.user);

  await supabase
    .from("tt_profiles")
    .upsert(
      {
        id: data.user.id,
        discord_user_id: identity.id,
        discord_username: identity.username,
        avatar_url: identity.avatarUrl,
      },
      { onConflict: "id" },
    );

  // Supabase hands over the provider's own access token exactly once, here.
  // It is what lets the settings page list the servers this user belongs to;
  // if we do not grab it now it is gone until the next sign-in.
  const providerToken = data.session?.provider_token;
  if (providerToken) {
    const expiresIn = 7 * 24 * 60 * 60 * 1000; // Discord issues ~7 days.
    const refresh = data.session?.provider_refresh_token;
    try {
      await createSupabaseServiceRoleClient()
        .from("tt_connections")
        .upsert(
          {
            user_id: data.user.id,
            discord_user_token_cipher: seal(providerToken),
            discord_user_refresh_cipher: refresh ? seal(refresh) : null,
            discord_user_token_expires: new Date(Date.now() + expiresIn).toISOString(),
          },
          { onConflict: "user_id" },
        );
    } catch {
      // A missing APP_ENCRYPTION_KEY must not block sign-in itself; the server
      // list simply stays unavailable until it is configured.
    }
  }

  const response = NextResponse.redirect(new URL(next, url.origin));
  response.cookies.delete(NEXT_COOKIE);
  return response;
}

/** A cookie value as written by the login button, or null when it will not decode. */
function decoded(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
