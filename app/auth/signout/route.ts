import { NextResponse } from "next/server";

import { safeNextPath } from "@/lib/site";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Sign out, and land on the sign-in page — sent back to `next` afterwards when
 * the form names one ("Sign in again" on Settings, to renew the Discord
 * sign-in behind "Your servers"). `next` is checked like every destination
 * (`safeNextPath`): a path on this site, never another.
 */
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const raw = form?.get("next");
  const next = safeNextPath(typeof raw === "string" ? raw : null);
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  const login = new URL("/login", new URL(request.url).origin);
  if (next !== "/") login.searchParams.set("next", next);
  return NextResponse.redirect(login, { status: 303 });
}
