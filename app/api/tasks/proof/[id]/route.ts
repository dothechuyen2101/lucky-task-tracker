import { NextResponse } from "next/server";

import { getUser } from "@/lib/auth";
import { proofFileUrl } from "@/lib/proof-server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import type { TaskProof } from "@/lib/types/database";

/**
 * Open one proof file: a redirect to a short-lived link. Board uploads are in
 * a private bucket; Discord's attachment links expire within a day and are
 * refreshed with the owner's bot. Who may open it is decided by reading the
 * proof on the caller's OWN session — RLS serves it to the board's owner, the
 * assignee and the person who asked for the task, and to nobody else.
 */

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.from("tt_task_proofs").select("*").eq("id", id).maybeSingle();
  const proof = data as TaskProof | null;
  if (!proof || proof.kind !== "file") return NextResponse.json({ error: "No such proof." }, { status: 404 });

  const url = await proofFileUrl(createSupabaseServiceRoleClient(), proof);
  if (!url) return NextResponse.json({ error: "That file cannot be opened any more." }, { status: 410 });
  return NextResponse.redirect(url, 302);
}
