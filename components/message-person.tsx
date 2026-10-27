"use client";

import { useState } from "react";
import { Send } from "lucide-react";

import { DISCORD_MESSAGE_LIMIT, isSnowflake, rateLimitWait } from "@/lib/messaging";

/**
 * Type one note and send it to this person as a Discord DM, from the owner's
 * own bot.
 *
 * SEND-ONLY, FOREVER. A bot cannot see what comes back from a DM between two
 * humans, on any architecture (`AGENTS.md:21-22`, `lib/discord.ts:16-18`). So
 * this is one field, one button and one result line — deliberately not a
 * message list, not bubbles, not a timestamped log of who said what. There is
 * nothing here to grow into a chat window, and the standing line under the
 * field says out loud that what comes back lands in Discord and not in this
 * app, so nobody sits waiting on a surface that will never show them anything.
 *
 * Three more things it deliberately does not do:
 *
 *  - It does not write to Supabase. Ordinary mutations go through the
 *    optimistic browser-client write helper in `components/tracker.tsx`; this
 *    one cannot, because the bot credential is a secret and must never reach
 *    the browser (`CLAUDE.md:11-15`, 20-23). Everything goes through
 *    `POST /api/message`, which is where the boundary is held.
 *  - It does not re-send on its own, ever. `POST /api/message` is GUARDED, not
 *    idempotent: pressing Send twice sends two DMs, and a note to a human has
 *    no undo. The busy flag below is the guard; there is no timer, no attempt
 *    counter and no automatic second try. On a rate limit the wait is shown
 *    and the person decides.
 *  - It derives nothing and formats nothing. The cap and the shape check are
 *    `lib/messaging.ts`'s — the same module the route validates with, so the
 *    counter here and the guard there cannot drift — and so is the 429 wait,
 *    because `vitest.config.mts:20` collects only `lib/**\/*.test.ts` and a
 *    rule written in this file would have no test.
 *
 * It does not call `router.refresh()` after a send: nothing on the page
 * changes, because nothing about the note is stored.
 */

type MessagePersonProps = {
  /** The snowflake `PERSON_KEY_COLUMN` holds — the key this panel was opened on. */
  personKey: string;
  /** Already resolved by `displayNameFor`; this component never resolves it. */
  name: string;
};

/** What the one result line is currently saying, and in what colour. */
type Result = { tone: "good" | "bad"; text: string };

export function MessagePerson({ personKey, name }: MessagePersonProps) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  // The shape check is defensive, not the security boundary — that is the
  // route's allow-list (`app/api/message/route.ts`). A row repaired by the
  // offline backfill can carry a name where an id belongs, and firing a
  // request that is certain to come back 403 teaches the user nothing.
  const reachable = isSnowflake(personKey);

  // Length is measured on the TRIMMED text because the trimmed text is what
  // gets sent — the same rule `validateMessageContent` applies server-side.
  const content = draft.trim();
  const overBy = content.length - DISCORD_MESSAGE_LIMIT;
  const sendable = reachable && content !== "" && overBy <= 0;

  async function send() {
    if (busy || !sendable) return;

    setBusy(true);
    setResult(null);

    try {
      const response = await fetch("/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipientId: personKey, content }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };

      if (!response.ok) {
        // The route's copy, verbatim — it names the actual cause — plus the
        // wait when Discord gave one. Never a stack, and never a raw status
        // on its own if the server said something a human can act on.
        const wait = rateLimitWait(payload);
        const said = payload.error ?? `${response.status} ${response.statusText}`;
        setResult({ tone: "bad", text: wait === null ? said : `${said} ${wait}` });
        return;
      }

      // Cleared only on success, so a failed send leaves the words the person
      // typed exactly where they left them.
      setDraft("");
      setResult({ tone: "good", text: `Sent to ${name}.` });
    } catch (caught) {
      setResult({
        tone: "bad",
        text: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="person-message">
      <p className="sub-title">Send a note</p>

      <textarea
        className="note-edit"
        value={draft}
        disabled={busy || !reachable}
        placeholder="Type a note. It arrives as a DM from your bot, not from your account — so say who you are."
        aria-label={`Send a note to ${name} on Discord`}
        onChange={(event) => setDraft(event.target.value)}
      />

      <div className="person-message-foot">
        {/* A figure, so it is mono and tabular like every other count in this
            product. It takes colour only once it is telling you something:
            past the cap, where the send is about to be refused. */}
        <span className={`person-message-count ${overBy > 0 ? "attention" : ""}`}>
          {content.length}/{DISCORD_MESSAGE_LIMIT}
        </span>

        <button
          className="btn btn-primary"
          type="button"
          onClick={send}
          disabled={busy || !sendable}
          title={reachable ? "Send this as a Discord DM" : "No Discord identity for this person yet"}
        >
          <Send />
          {busy ? "Sending…" : "Send"}
        </button>
      </div>

      {reachable ? (
        <p className="person-hint">
          One way. Whatever they say back arrives in Discord, not here.
        </p>
      ) : (
        <p className="person-hint">
          No Discord identity for this person yet; it is picked up the next time they
          are @-mentioned.
        </p>
      )}

      {result === null ? null : (
        <p className={`person-message-result ${result.tone}`} role="status">
          {result.text}
        </p>
      )}
    </section>
  );
}
