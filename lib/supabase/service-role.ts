// The service role reads every account's rows and every sealed secret. This
// import makes a build fail loudly if a client component ever pulls it in.
import "server-only";

import { createClient } from "@supabase/supabase-js";

export function createSupabaseServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Supabase service role configuration is missing.");
  }

  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
