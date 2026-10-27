import { redirect } from "next/navigation";

import { LoginButton } from "@/components/login-button";
import { safeNextPath } from "@/lib/site";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next: rawNext } = await searchParams;
  // Where the person was going before they were asked to sign in.
  const next = safeNextPath(rawNext);

  if (isSupabaseConfigured) {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) redirect(next);
  }

  return (
    <main className="gate">
      <div className="gate-card">
        <h1 className="mark">
          Task Tracker
          <span>LookUp Media</span>
        </h1>

        <p>
          Sign in with Discord. The tracker reads the messages you write in the channels you pick,
          works out which of them are tasks, and reminds you about the ones you put a deadline on.
        </p>

        {error ? (
          <div className="notice" style={{ textAlign: "left", marginBottom: 20 }}>
            <strong>Sign-in failed</strong>
            {error}
          </div>
        ) : null}

        {isSupabaseConfigured ? (
          <LoginButton next={next} />
        ) : (
          <div className="notice" style={{ textAlign: "left", margin: 0 }}>
            <strong>Not connected</strong>
            Supabase credentials are missing. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
            <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>.
          </div>
        )}

        <p className="gate-foot">
          Signing in links your Discord account so the tracker can tell your messages from everyone
          else&apos;s. It cannot read anything until you add your own bot and choose the channels
          yourself.
        </p>
      </div>
    </main>
  );
}
