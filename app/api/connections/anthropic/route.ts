import { NextResponse } from "next/server";

import { getUser } from "@/lib/auth";
import { CLASSIFY_MODELS, DEFAULT_MODEL, verifyApiKey } from "@/lib/claude";
import { hint, isEncryptionConfigured, seal } from "@/lib/crypto";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";

/**
 * Connect (or disconnect) a user's own Anthropic key.
 *
 * Verified with a one-token request before it is stored, so an expired or
 * wrong-workspace key is caught here rather than showing up as an empty task
 * list a day later. Only the last four characters are ever readable again.
 */

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  if (!isEncryptionConfigured()) {
    return NextResponse.json(
      { error: "APP_ENCRYPTION_KEY is not set on the server, so credentials cannot be stored." },
      { status: 500 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as { key?: string; model?: string };
  const apiKey = body.key?.trim();
  const model = body.model?.trim() || DEFAULT_MODEL;

  if (!apiKey) return NextResponse.json({ error: "Paste an API key." }, { status: 400 });

  if (!CLASSIFY_MODELS.some((m) => m.id === model)) {
    return NextResponse.json({ error: `Unknown model: ${model}` }, { status: 400 });
  }

  const check = await verifyApiKey(apiKey, model);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

  // The caveat from a rate-limited check is returned to the caller and shown
  // once, but deliberately NOT persisted: `anthropic_last_error` drives the red
  // status pill, and a credential that authenticated is connected, not broken.
  // If it genuinely does not work, the worker writes a real error there on its
  // next tick - which is the only thing that can actually tell the difference.
  const warning = check.warning ?? null;

  const db = createSupabaseServiceRoleClient();
  const { error } = await db.from("tt_connections").upsert(
    {
      user_id: user.id,
      anthropic_key_cipher: seal(apiKey),
      anthropic_key_hint: hint(apiKey),
      anthropic_model: model,
      anthropic_connected_at: new Date().toISOString(),
      anthropic_last_error: null,
    },
    { onConflict: "user_id" },
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, hint: hint(apiKey), model, warning });
}

/** Change the model without re-pasting the key. */
export async function PATCH(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { model?: string };
  const model = body.model?.trim();

  if (!model || !CLASSIFY_MODELS.some((m) => m.id === model)) {
    return NextResponse.json({ error: `Unknown model: ${model ?? ""}` }, { status: 400 });
  }

  const db = createSupabaseServiceRoleClient();
  const { error } = await db
    .from("tt_connections")
    .update({ anthropic_model: model, anthropic_last_error: null })
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, model });
}

export async function DELETE() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const db = createSupabaseServiceRoleClient();
  const { error } = await db
    .from("tt_connections")
    .update({
      anthropic_key_cipher: null,
      anthropic_key_hint: null,
      anthropic_connected_at: null,
      anthropic_last_error: null,
    })
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
