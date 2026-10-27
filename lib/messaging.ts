// Recipient column resolved from PERSON_KEY_COLUMN in lib/people.ts: "assignee_discord_id".

/**
 * The pure, testable half of "message a person from their panel".
 *
 * SECURITY BOUNDARY, stated once: the real boundary is the route's
 * `.eq("user_id", user.id)` SELECT in `app/api/message/route.ts`, which is what
 * PRODUCES `trackedIds` — `pickAllowedRecipient` below only filters a list that
 * query already scoped to the signed-in caller, and proves nothing on its own.
 *
 * Why this module exists at all: `vitest.config.mts:20` collects only
 * `lib/**\/*.test.ts`, so a guard written inside a route or a component has no
 * machine-checkable acceptance in this repo. The guards live here so they can
 * be tested.
 *
 * This module stays pure and client-safe — no framework runtime, no database
 * client, no React, no encryption import. `components/message-person.tsx` is a
 * client component and imports `DISCORD_MESSAGE_LIMIT` and `isSnowflake` from
 * here; anything server-bound in this file would break the browser bundle.
 * `lib/discord-links.ts:1-4` is the in-repo precedent.
 *
 * SEND-ONLY, forever. A bot cannot read a DM between two humans
 * (`AGENTS.md:21-22`, `lib/discord.ts:16-18`). Nothing here models an incoming
 * message, and nothing ever should.
 */

/**
 * The `tt_alerts.kind` value for a hand-typed message, distinct from the column
 * default `'deadline'`
 * (`supabase/migrations/20260902_01_task_tracker_core.sql:213`) so the alert log
 * stays honest about what was a scheduled reminder and what a person typed.
 *
 * The column is `text not null default 'deadline'` with no CHECK constraint and
 * `Alert.kind` is already `string` (`lib/types/database.ts:126`), so this new
 * value needs no migration and no type change.
 *
 * Exported as one constant so the route and any future reader cannot drift.
 */
export const MESSAGE_ALERT_KIND = "message";

/**
 * Discord's hard ceiling on a message body.
 *
 * Enforced nowhere else in this codebase today — `lib/reminders.ts:135-151`
 * never truncates and `lib/discord.ts:223-231` passes content straight through —
 * and hand-typed text makes overrun likely. Unchecked it comes back as a Discord
 * 400 that reads like a mystery, so it is checked here, before any network call.
 *
 * The client-side counter imports this same constant, so the courtesy counter
 * and the server guard cannot disagree.
 */
export const DISCORD_MESSAGE_LIMIT = 2000;

/** What `validateMessageContent` hands back: the sendable text, or the copy to show. */
export type ContentCheck =
  | { ok: true; content: string }
  | { ok: false; error: string };

/**
 * Is this the shape of a Discord snowflake — digits only, 17–20 characters?
 *
 * A DEFENSIVE SHAPE CHECK, NOT THE SECURITY BOUNDARY. It rejects obvious junk
 * (a name, a null, an object) before it reaches a URL path; it says nothing
 * about whether the caller is allowed to message that id. The allow-list does
 * that.
 */
export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{17,20}$/.test(value);
}

/**
 * Trim, then reject anything Discord would reject or that is not worth sending.
 *
 * Length is measured on the TRIMMED text, because the trimmed text is what gets
 * sent. Exactly `DISCORD_MESSAGE_LIMIT` characters is fine; one more is not.
 */
export function validateMessageContent(raw: unknown): ContentCheck {
  if (typeof raw !== "string") return { ok: false, error: "Type a message first." };

  const content = raw.trim();
  if (content === "") return { ok: false, error: "Type a message first." };

  if (content.length > DISCORD_MESSAGE_LIMIT) {
    return { ok: false, error: "Discord messages cap at 2000 characters." };
  }

  return { ok: true, content };
}

/**
 * The recipient the caller is actually allowed to message, or `null`.
 *
 * Returns `requestedId` only when it is snowflake-shaped AND appears in
 * `trackedIds`. Everything else — an arbitrary snowflake, a tracked value that
 * is not snowflake-shaped, a number, `null`, an object — is `null`, and the
 * caller turns every one of those into the same 403 with the same copy, so a
 * rejection never discloses whether that person exists.
 *
 * `trackedIds` MUST be the output of a query scoped by `.eq("user_id", user.id)`.
 * This function cannot check that and does not try to: it is a filter over an
 * already-scoped list, not the boundary itself.
 */
export function pickAllowedRecipient(
  trackedIds: readonly string[],
  requestedId: unknown,
): string | null {
  if (!isSnowflake(requestedId)) return null;
  return trackedIds.includes(requestedId) ? requestedId : null;
}

/**
 * The wait to show a human after Discord rate-limited their bot, or `null`.
 *
 * `app/api/message/route.ts` returns Discord's own delay beside its 429 copy.
 * Reading and phrasing that number lives HERE, not in the compose component,
 * for two reasons:
 *
 *  - `vitest.config.mts:20` collects only `lib/**\/*.test.ts`, so a formatter
 *    written inside a component would have no machine-checkable acceptance —
 *    the same reason the rest of this module exists.
 *  - the compose box must carry no re-send machinery at all: it names no
 *    timer, no delay field and no attempt counter, it only renders the
 *    sentence this function hands it. The human presses Send again, or does
 *    not. Nothing in this codebase ever re-sends a message to a person on its
 *    own — a note to a human has no undo.
 *
 * Rounded UP and hedged with "about", because a delay presented to the second
 * reads as a promise the app cannot keep. Anything past ninety seconds is said
 * in minutes; a number like "about 3600 seconds" is not an answer.
 */
export function rateLimitWait(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;

  const raw = (payload as Record<string, unknown>).retryAfterMs;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;

  const seconds = Math.max(1, Math.ceil(raw / 1000));
  if (seconds === 1) return "Discord asked for about a second.";
  if (seconds <= 90) return `Discord asked for about ${seconds} seconds.`;

  const minutes = Math.ceil(seconds / 60);
  return `Discord asked for about ${minutes} minutes.`;
}
