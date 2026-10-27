"use client";

import { useState } from "react";

import { NEXT_COOKIE } from "@/lib/site";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * The whole sign-in.
 *
 * Two scopes, and no more:
 *   identify  the Discord user id, so the poller can tell this user's messages
 *             apart from everyone else's. Without it nothing works at all.
 *   guilds    the NAMES and IDS of the servers this user belongs to, so the
 *             settings page can show where their bot is missing and offer to
 *             invite it. This scope cannot read a single message - it returns
 *             a list of servers and nothing inside them.
 *
 * Reading messages remains the bot's job, and the bot is one the user creates
 * and invites themselves.
 */
export function LoginButton({ next = "/" }: { next?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);

    // Where to land afterwards rides in a short-lived cookie, not in
    // `redirectTo`: Supabase only redirects to URLs on its allow-list, and a
    // query string there can fail a match the bare callback passes. The
    // callback checks it (`safeNextPath`) before going anywhere near it.
    document.cookie = `${NEXT_COOKIE}=${encodeURIComponent(next)}; Path=/; Max-Age=600; SameSite=Lax`;

    const supabase = createSupabaseBrowserClient();
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: "discord",
      options: {
        scopes: "identify guilds",
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (authError) {
      setError(authError.message);
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn btn-discord" onClick={signIn} disabled={busy}>
        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">
          <path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.6 12.6 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.2 14.2 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127c-.598.35-1.22.645-1.873.891a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.057c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028ZM8.02 15.331c-1.182 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418Z" />
        </svg>
        {busy ? "Opening Discord…" : "Sign in with Discord"}
      </button>

      {error ? (
        <p className="err" style={{ padding: "14px 0 0" }}>
          {error}
        </p>
      ) : null}
    </>
  );
}
