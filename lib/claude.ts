import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { TRIAGE_CATEGORIES } from "@/lib/triage";

/**
 * The classifier: turn a message tagged to the tracker into a task card — or
 * say why it is not one.
 *
 * Every message that reaches it tagged the user's bot — `lib/relevance.ts`
 * drops everything else unread. Most are work. Some are not: "thanks @bot",
 * banter, a question to the bot, an instruction it cannot apply. Filing those
 * made the board a pile somebody had to clear by hand (Lucky35, 2026-09-29), so
 * the model sorts each one into a `category` first. Only "task" becomes a card;
 * the rest are answered with 👀 and kept on the board's "Not filed" list, so a
 * wrong call is one click to undo and nothing goes unanswered (`lib/triage.ts`).
 * For a task it then describes it: a title, a line of detail, which of the
 * @-mentioned people it went to, and the deadline in the message's own words.
 *
 * It runs on the USER'S OWN Anthropic key, every time. There is no app-level
 * key and no fallback to one, which is the point — nobody's Discord messages
 * are ever read on someone else's bill, and a user who revokes their key stops
 * the reading immediately and completely.
 *
 * Messages are described in batches so a busy hour costs one request rather
 * than forty. The batch is ordered and the model answers by index; a short
 * answer or a mismatched index is treated as "the batch failed", because a
 * message the model skipped would otherwise become a task with no title.
 */

export const CLASSIFY_MODELS = [
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (lightest)" },
] as const;

/**
 * Adaptive thinking and `output_config.effort` arrived with the 4.6 generation.
 * Sending either to an older model is a hard 400 -
 *   "adaptive thinking is not supported on this model"
 * - so the request shape has to follow the model rather than being fixed.
 *
 * This matters more than it looks: Haiku 4.5 is the model people fall back to
 * when their subscription has no headroom for the bigger ones, which is exactly
 * the moment classification must not also break.
 */
function supportsAdaptiveThinking(model: string): boolean {
  return !model.startsWith("claude-haiku-4-5") && !/-4-5$|-4-5-/.test(model);
}

export const DEFAULT_MODEL = "claude-opus-5";

/**
 * The only model a `claude setup-token` subscription credential can actually
 * reach on the Messages API.
 *
 * Measured 2026-09-03 with a real subscription token: a single 16-token request
 * to Opus 5 and Sonnet 5 both returned 429 `rate_limit_error` with the message
 * "Error" and NO `anthropic-ratelimit-*` headers, while the identical request to
 * Haiku 4.5 returned 200 with `anthropic-ratelimit-unified-status: allowed`.
 *
 * That is an entitlement boundary wearing a rate limit's clothes: nothing is
 * being consumed, so account usage does not move and waiting never helps. The
 * only fix is a model the credential is allowed to use.
 *
 * API keys are unaffected — they reach every model.
 */
export const OAUTH_ALLOWED_MODEL = "claude-haiku-4-5";

export function modelAllowedFor(kind: CredentialKind, model: string): boolean {
  return kind === "api_key" || model.startsWith("claude-haiku");
}

/**
 * The models to OFFER for a credential. Showing a choice that returns a
 * mystifying 429 is worse than showing one option — the picker was the bug.
 */
export function modelsFor(kind: CredentialKind | null | undefined) {
  return CLASSIFY_MODELS.filter((m) => modelAllowedFor(kind ?? "api_key", m.id));
}

/** The model to use when a credential of this kind is connected. */
export function defaultModelFor(kind: CredentialKind): string {
  return kind === "oauth" ? OAUTH_ALLOWED_MODEL : DEFAULT_MODEL;
}

/**
 * Two kinds of credential open the same door, and they are NOT interchangeable
 * on the wire:
 *
 *   sk-ant-api...  a console API key.       Sent as `x-api-key`. Metered billing.
 *   sk-ant-oat...  a `claude setup-token`   Sent as `Authorization: Bearer` plus
 *                  OAuth token bound to a   the `oauth-2025-04-20` beta header.
 *                  Pro/Max/Team seat.       Runs on the subscription, no credits.
 *
 * Detecting this rather than asking means nobody has to know which one they are
 * holding - they paste what they have and it works. Sending an OAuth token as
 * `x-api-key` is what produced the "key was rejected" error that started this.
 */
export type CredentialKind = "api_key" | "oauth";

export function credentialKind(secret: string): CredentialKind {
  return secret.trim().startsWith("sk-ant-oat") ? "oauth" : "api_key";
}

export function describeCredential(kind: CredentialKind): string {
  return kind === "oauth"
    ? "Claude subscription (no API credits used)"
    : "Anthropic API key (metered)";
}

/** Build a client for whichever credential this is. */
function clientFor(secret: string, maxRetries: number): Anthropic {
  const trimmed = secret.trim();

  if (credentialKind(trimmed) === "oauth") {
    return new Anthropic({
      authToken: trimmed,
      // /v1/messages rejects an OAuth bearer token without this header.
      defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
      maxRetries,
    });
  }

  return new Anthropic({ apiKey: trimmed, maxRetries });
}

/** How many messages go into one grading request. */
export const BATCH_SIZE = 20;

const VerdictSchema = z.object({
  index: z.number().int().describe("The 1-based index of the message being described."),
  category: z
    .enum(TRIAGE_CATEGORIES)
    .describe('What the message is. "task" unless it clearly gives nobody any work — see the instructions.'),
  reason: z.string().describe("One short clause saying what is being asked, or why it is not a task."),
  title: z.string().describe("An imperative one-line task title, without @-names and without the deadline."),
  detail: z.string().describe("At most one sentence of extra context. Empty string if there is none."),
  suggested_deadline: z
    .string()
    .describe(
      "The deadline the message itself states, normalised (see the instructions). Empty string if it states none. Never invent one.",
    ),
  // A required string, exactly like every sibling above — never made optional
  // and never made nullable. A schema the model cannot satisfy discards the
  // WHOLE batch of 20 and stalls that user's classification with
  // anthropic_last_error set. "Empty string otherwise" is how this file says
  // "no answer".
  assignee: z
    .string()
    .describe(
      "If an `assignees:` or `people:` line is present and the message hands the work to one of those people, their name or id copied verbatim from that line. Empty string otherwise. Never name anybody who is not on that line.",
    ),
  // Same rule as every field above: required, "" for no answer.
  named: z
    .string()
    .describe(
      "Only for a SENT message marked `via: direct message`: the person the work is handed to, exactly as the message writes the name (no @, never completed). Empty string otherwise.",
    ),
  // An enum the model always has an answer for: "medium" when the message
  // says nothing about urgency, which is most of them.
  priority: z
    .enum(["high", "medium", "low"])
    .describe('How urgent the message itself says the work is. "medium" unless it says so — see the instructions.'),
});

const BatchSchema = z.object({
  verdicts: z.array(VerdictSchema),
});

export type Verdict = z.infer<typeof VerdictSchema>;

const SYSTEM = `You turn Discord messages into task cards for a task tracker.

Every message below explicitly tagged the tracker's bot. Tagging the bot is how
people say "track this", so nearly every message here is a task. First sort
each one into a category:

  task      somebody now has work to do: an instruction, a request, a stated
            need, a commitment. This is the default.
  thanks    thanks or an acknowledgement and nothing else: "thanks @bot",
            "got it", "👍", "ok will do" with no new work in it.
  chatter   banter, a greeting, a joke, a reaction — no work, no question.
  question  a question TO THE BOT about itself or the board: "what can you
            do?", "what's on my list?", "did you get that?".
  command   an instruction ABOUT an existing task rather than new work:
            "done", "mark it finished", "ignore that", "change the deadline to
            Friday", "remind me daily" — with nothing new to do in it.

Only "task" goes on the board. The others are answered in Discord and kept on
a "Not filed" list a person can file from with one click — so when you are
unsure, answer "task": a wrong card costs a click to dismiss, a missed task
costs a deadline. A message that thanks someone AND asks for more is a task.
For anything but "task", still fill every field: title and detail may be empty
strings, and the rest follow their own rules.

A message marked "continues: yes" was written by the same person in the same
channel moments after the one before it. Read the two together for context —
"@bot @minh" then "@bot redo the banner too" is one person handing out work —
but still return a verdict for each.

Each message is marked with a direction:

  SENT      the person you work for wrote it: work they handed to somebody,
            or took on themselves.
  RECEIVED  someone else wrote it and @-mentioned them: work asked OF them.

TITLE AND DETAIL

Titles are imperative and specific: "Send Bianca the signed NDA", not "NDA".
Never write a title longer than 80 characters. Leave out the @-mentions, the
bot's name and the deadline — the card shows who and when on its own.

For a RECEIVED message, write the title as an instruction to the person you
work for: "Send Bianca the signed NDA", never "Erik should send the NDA" and
never "Asked Erik to send the NDA". They are reading their own to-do list.

detail is at most one sentence of useful context, or an empty string.

WHO THE WORK WENT TO

Some messages carry an "assignees:" line. That means the person you work for
wrote the message and @-mentioned those people. If the message hands the work
to one of them, return that person in \`assignee\`, copied verbatim from the
line. If it names several and does not single one out, return an empty string.
Never return a person who is not on that line, and never invent one.

DIRECT MESSAGES

A message marked "via: direct message" was written straight to the bot in a
private chat, without tagging it — it counts exactly as if it had. Discord's @
list offers nobody else in a private chat, so people there name others in
words or as "@name" typed as plain text. If such a SENT message hands the
work to someone, return the name EXACTLY as the message writes it (without the
@, never completed or corrected) in \`named\` — the tracker matches it itself,
and asks the person you work for when it is not sure. It may carry a "people:"
line of everyone they have handed work to before, to help you tell a name from
an ordinary word; never put a name from that line in \`named\` that the
message did not write. If it names nobody, \`named\` is an empty string, as it
is for every other message.

THE DEADLINE

suggested_deadline is the deadline the message itself states, copied into ONE
of these forms. The tracker does the date arithmetic itself, counting from the
moment the message was sent, in the person's own time zone — so do not work
out a date for anything the first three forms can express:

  - a duration: "in N minutes|hours|days|weeks"
      "deadline is 24 hours" -> "in 24 hours"; "36h" -> "in 36 hours";
      "within 2 days" -> "in 2 days"; "in an hour" -> "in 1 hour"
  - a weekday: "tuesday" — it means the nearest Tuesday still ahead, and so
      does "next Tuesday" (the tracker's own rule, not a week further)
      "by Tuesday" -> "tuesday"; "on fri" -> "friday"; "next Tue" -> "tuesday"
  - "today", "tonight" or "tomorrow"
  - anything else — a calendar date, or a day WITH a clock time — as ISO-8601:
      a date alone as 2026-10-03; with a time, resolved against the message's
      sent_at in the person's time zone and carrying an explicit UTC offset,
      for example 2026-09-08T15:00:00+02:00.

If the message states no deadline, return an empty string. Do not guess one
from urgency words like "ASAP" or "soon".

PRIORITY

priority is how urgent the message itself says the work is: "high" when it
says urgent, ASAP, top or high priority, "gấp" or the like; "low" when it says
low priority, no rush, whenever, "không gấp"; "medium" otherwise — which is
most messages. Never raise it because the work sounds important.

Return exactly one verdict per message, using the 1-based index shown.`;

export type ClassifyInput = {
  apiKey: string;
  model: string;
  /**
   * The person's IANA zone, from `tt_profiles.timezone`. Rendered into the
   * batch text — NOT into SYSTEM — so SYSTEM stays one constant string and
   * keeps its prompt-cache hit across every user.
   */
  timezone: string;
  messages: Array<{
    id: string;
    content: string;
    sentAt: string;
    channelName: string | null;
    direction: "sent" | "received";
    authorName: string | null;
    /** True when this continues the previous message: same author, same channel, moments later. */
    continues?: boolean;
    /**
     * Who this message @-mentioned, already stripped of the author and the bot.
     * Only ever populated for `sent` messages.
     */
    assignees?: Array<{ id: string; name: string }>;
    /** Written to the bot in a DM rather than tagged in a channel. */
    viaDm?: boolean;
    /**
     * On a `sent` DM that @-mentions nobody: everyone the owner has handed work
     * to, for the model to pick the one the message names (`named` otherwise).
     */
    people?: Array<{ id: string; name: string }>;
  }>;
};

/**
 * Why a batch produced no verdicts, because the two call for opposite answers:
 *
 *   unavailable  the credential, the network or Anthropic — nothing about these
 *                messages. Stop for this user and retry the same batch later.
 *   unreadable   Claude answered, but the answer cannot be used: a refusal, a
 *                reply that does not fit the schema, a verdict missing. Retrying
 *                the same batch gets the same answer, so the worker splits it
 *                up and, for one message that keeps failing alone, files it
 *                from its own words instead of stalling everything behind it.
 */
export type ClassifyFailure = "unavailable" | "unreadable";

export type ClassifyResult =
  | { ok: true; verdicts: Map<string, Verdict> }
  | { ok: false; error: string; failure: ClassifyFailure };

/**
 * Describe one batch. Returns a verdict per input message id, or an error for
 * the whole batch — the caller leaves those messages unclassified so the next
 * tick tries again.
 */
export async function classifyBatch({
  apiKey,
  model,
  timezone,
  messages,
}: ClassifyInput): Promise<ClassifyResult> {
  if (messages.length === 0) return { ok: true, verdicts: new Map() };

  const client = clientFor(apiKey, 2);

  // One line, once, at the head of the batch — every message in it belongs to
  // the same person, so repeating the zone per item would only spend tokens.
  // It lives here rather than in SYSTEM because SYSTEM is a constant and stays
  // cacheable across users; this is the one part of the prompt that is not.
  const zoneLine = `time zone: ${timezone || "UTC"}`;

  const body = messages
    .map(
      (message, i) =>
        [
          `[${i + 1}]`,
          // SYSTEM tells the model how to title each direction, so it has to
          // be told which one it is reading. A RECEIVED title is written to the
          // person it was asked of; without this line every one read as SENT.
          `direction: ${message.direction === "received" ? "RECEIVED" : "SENT"}`,
          ...(message.direction === "received" && message.authorName ? [`from: ${message.authorName}`] : []),
          `sent_at: ${message.sentAt}`,
          message.viaDm ? "via: direct message" : `channel: #${message.channelName ?? "unknown"}`,
          `message: ${message.content}`,
          // `markRuns` in the worker: the same person, the same channel,
          // moments after the message before. Said, so a request split over
          // two tags is read as one thought.
          ...(message.continues ? ["continues: yes"] : []),
          // One conditional line, and only when there is somebody to name.
          ...(message.assignees?.length
            ? [`assignees: ${message.assignees.map((a) => `${a.name} (id ${a.id})`).join(", ")}`]
            : []),
          ...(message.people?.length ? [`people: ${message.people.map((a) => `${a.name} (id ${a.id})`).join(", ")}`] : []),
        ].join("\n"),
    )
    .join("\n\n---\n\n");

  const rendered = `${zoneLine}\n\n${body}`;

  try {
    const chosen = model || DEFAULT_MODEL;
    const modern = supportsAdaptiveThinking(chosen);

    const response = await client.messages.parse({
      model: chosen,
      max_tokens: 16000,
      system: SYSTEM,
      // On a 4.6+ model: thinking on so borderline cases get read properly,
      // effort low so a routine "yeah sounds good" costs almost nothing. That
      // pair is the knob to turn if the verdicts feel careless.
      //
      // Older models reject both outright, so they get neither. Haiku 4.5 is
      // exactly where people land when their subscription has no headroom for
      // the bigger models — the moment classification must not also break.
      ...(modern ? { thinking: { type: "adaptive" as const } } : {}),
      output_config: {
        ...(modern ? { effort: "low" as const } : {}),
        format: zodOutputFormat(BatchSchema),
      },
      messages: [{ role: "user", content: `Describe these ${messages.length} tagged messages.\n\n${rendered}` }],
    });

    // A safety classifier declining is a 200, not a throw. Without this check
    // the parse below would read an empty body and the batch would look like a
    // clean sweep of "not a task".
    if (response.stop_reason === "refusal") {
      return {
        ok: false,
        failure: "unreadable",
        error: `Claude declined to classify this batch (${response.stop_details?.category ?? "unspecified"}).`,
      };
    }

    const parsed = response.parsed_output;
    if (!parsed) {
      return { ok: false, failure: "unreadable", error: "Claude returned a response that did not match the schema." };
    }

    const verdicts = new Map<string, Verdict>();
    for (const verdict of parsed.verdicts) {
      const message = messages[verdict.index - 1];
      if (message) verdicts.set(message.id, verdict);
    }

    if (verdicts.size !== messages.length) {
      return {
        ok: false,
        failure: "unreadable",
        error: `Claude graded ${verdicts.size} of ${messages.length} messages; batch discarded.`,
      };
    }

    return { ok: true, verdicts };
  } catch (error) {
    const kind = credentialKind(apiKey);

    // A subscription credential aimed at a model it cannot reach fails on the
    // FIRST request, not after a burst — so retrying the same model is pointless
    // and waiting is worse than pointless. Drop to the model it is allowed to
    // use and finish the batch, rather than stalling every tick forever.
    if (
      error instanceof Anthropic.RateLimitError &&
      kind === "oauth" &&
      !modelAllowedFor(kind, model || DEFAULT_MODEL)
    ) {
      // The zone rides through the downgrade verbatim. Dropping it here would
      // make the retried batch — the one that actually produces the verdicts —
      // the only path that resolves "Tuesday" against the wrong clock.
      const retried = await classifyBatch({
        apiKey,
        model: OAUTH_ALLOWED_MODEL,
        timezone,
        messages,
      });
      if (retried.ok) return retried;
    }

    return { ok: false, failure: failureOf(error), error: describeAnthropicError(error, kind, model) };
  }
}

/**
 * A thrown error is "unavailable" — credential, network, Anthropic — unless it
 * is the SDK failing to parse what came back against the schema, which is
 * about the messages and would fail the same way on a retry.
 */
function failureOf(error: unknown): ClassifyFailure {
  if (error instanceof Anthropic.APIError) return "unavailable";
  return error instanceof Error && /pars|schema|JSON/i.test(error.message) ? "unreadable" : "unavailable";
}

/**
 * Cheapest possible call that proves a credential works, used when a user
 * pastes one into settings. `max_tokens: 1` so the check costs a rounding error.
 *
 * A 429 is NOT a failure here. Anthropic answers a bad credential with 401;
 * rate limits are applied per account, which means the request got through
 * authentication before it was throttled. Refusing to store a credential the
 * server just told us it recognised would strand the user behind a transient
 * limit they cannot see or clear — so it is stored, with a warning, and the
 * worker proves it properly on the next tick.
 */
export async function verifyApiKey(
  apiKey: string,
  model: string,
): Promise<{ ok: true; warning?: string } | { ok: false; error: string }> {
  try {
    const client = clientFor(apiKey, 0);
    const chosen = model || DEFAULT_MODEL;
    await client.messages.create({
      model: chosen,
      max_tokens: 1,
      ...(supportsAdaptiveThinking(chosen) ? { thinking: { type: "disabled" as const } } : {}),
      messages: [{ role: "user", content: "ok" }],
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return {
        ok: true,
        warning:
          "Saved. Claude is rate-limiting right now, so this could not be fully tested — " +
          "the credential was accepted, which a wrong one would not be. Tracking will start " +
          "as soon as the limit clears.",
      };
    }
    return { ok: false, error: describeAnthropicError(error, credentialKind(apiKey)) };
  }
}

function describeAnthropicError(
  error: unknown,
  kind: CredentialKind = "api_key",
  model = "",
): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return kind === "oauth"
      ? "Claude rejected that subscription token. It may have expired — run `claude setup-token` again to mint a new one."
      : "Anthropic rejected that API key. Copy it again from console.anthropic.com → API keys.";
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return "That key exists but is not allowed to use this model.";
  }
  if (error instanceof Anthropic.NotFoundError) {
    return "That model id does not exist for this key.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    // Distinguish the two things Anthropic returns 429 for. Only one of them
    // is worth waiting out.
    if (kind === "oauth" && !modelAllowedFor(kind, model)) {
      return (
        "A Claude subscription cannot use this model here — only Haiku is available on a " +
        "subscription token, and Anthropic reports that as a rate limit even though nothing " +
        "was used. Switch the model to Claude Haiku 4.5 in Settings. Waiting will not help."
      );
    }
    return (
      "Claude is rate-limiting right now. The credential is fine — this should clear on its own " +
      "within a few minutes."
    );
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Could not reach the Anthropic API.";
  }
  if (error instanceof Anthropic.APIError) {
    return `Anthropic returned ${error.status ?? "an error"}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Commands — talking to the tracker from inside Discord
// ---------------------------------------------------------------------------

const CommandSchema = z.object({
  action: z
    .enum(["set_deadline", "extend_deadline", "set_reminder", "complete", "dismiss", "accept", "send_back", "new_task", "none"])
    .describe("What the person is asking the tracker to do to the task they replied to."),
  deadline: z
    .string()
    .describe("For set_deadline, the new deadline in one of the forms the instructions list. Empty otherwise."),
  every_minutes: z
    .number()
    .int()
    .describe("Reminder cadence in minutes for set_reminder, else 0. 60=hourly, 1440=daily, 10080=weekly."),
  extend_minutes: z
    .number()
    .int()
    .describe("For extend_deadline, how much later the deadline moves, in minutes: 6 hours = 360, 2 days = 2880. Else 0."),
  note: z
    .string()
    .describe("For send_back, what the person says is missing or wrong, in their words. Empty otherwise."),
  timing: z
    .enum(["on_time", "late", "unsaid"])
    .describe('For accept: "late" when they approve it as late, "on_time" when they say on time, otherwise "unsaid".'),
  reply: z.string().describe("One short sentence to send back in Discord confirming what was done."),
});

export type Command = z.infer<typeof CommandSchema>;

const COMMAND_SYSTEM = `You read one Discord message addressed to a task-tracker
bot and work out what it is being asked to do.

The person REPLIED to the message that created one of their tracked tasks, or
to the bot's own message about it, so they are talking ABOUT that task.
Typical messages:
  "@tracker deadline friday 5pm"        -> set_deadline
  "@tracker give her 6 more hours",
  "6 extra hours", "extend by 2 days",
  "push it back a day"                  -> extend_deadline, extend_minutes 360 /
                                           360 / 2880 / 1440
  "@tracker remind me every day"        -> set_reminder, every_minutes 1440

extend_deadline is MORE time on top of the deadline the task already has
("more", "extra", "extend", "push back", "give them N more"). A deadline said
as a time from now ("deadline in 6 hours", "due tomorrow") is set_deadline.
  "@tracker this one is done"           -> complete
  "@tracker ignore that"                -> dismiss

When someone the task was given to says it is finished, the bot tells the
person and asks them to review it. Their answer to that:
  "accept", "approve", "looks good"     -> accept, timing unsaid
  "approve, but late", "approved late"  -> accept, timing late
  "approve on time"                     -> accept, timing on_time
  "send back: the footer is missing",
  "not done, the colours are off",
  "reject", "disapprove"                -> send_back, note = what is missing
                                           ("the footer is missing"), or empty
  "give them 2 more days"               -> extend_deadline, extend_minutes 2880

For set_deadline, write the deadline in ONE of these forms. The tracker does
the date arithmetic itself, from the message's sent_at in the person's own
time zone (both are given to you), so do not work out a date for anything the
first three forms can express:

  - a duration: "in N minutes|hours|days|weeks"      "in 2 days"
  - a weekday: "friday" — the nearest Friday ahead, and so is "next Friday"
  - "today", "tonight" or "tomorrow"
  - anything with a clock time, or a calendar date, as ISO-8601. A date alone
    as 2026-10-03. With a time, resolved in the person's time zone and
    carrying its UTC offset: "friday 5pm" said by someone in Asia/Ho_Chi_Minh
    -> 2026-10-02T17:00:00+07:00.

If the message adds NEW work rather than changing this task ("also do the
footer"), return action "new_task" — the tracker will file it as a task of its
own. If it asks for none of these and adds no work ("thanks", "hmm", something
you cannot make sense of), return action "none": the tracker explains what it
can do and files nothing.

The reply is read in Discord by the person who wrote the message. One sentence,
plain, no preamble.`;

/**
 * Parse one "@bot ..." message into an action. Runs on the same credential and
 * model as classification, so a command costs no more than a task does.
 */
export async function parseCommand({
  apiKey,
  model,
  content,
  sentAt,
  timezone,
}: {
  apiKey: string;
  model: string;
  content: string;
  sentAt: string;
  /**
   * `tt_profiles.timezone`. Without it "friday 5pm" was resolved in whatever
   * zone the model assumed — seven hours out for someone in UTC+7.
   */
  timezone: string;
}): Promise<{ ok: true; command: Command } | { ok: false; error: string; failure: ClassifyFailure }> {
  try {
    const chosen = model || DEFAULT_MODEL;
    const modern = supportsAdaptiveThinking(chosen);

    const response = await clientFor(apiKey, 1).messages.parse({
      model: chosen,
      max_tokens: 4000,
      system: COMMAND_SYSTEM,
      ...(modern ? { thinking: { type: "adaptive" as const } } : {}),
      output_config: {
        ...(modern ? { effort: "low" as const } : {}),
        format: zodOutputFormat(CommandSchema),
      },
      messages: [
        { role: "user", content: `time zone: ${timezone || "UTC"}\nsent_at: ${sentAt}\n\nmessage: ${content}` },
      ],
    });

    if (response.stop_reason === "refusal") {
      return { ok: false, failure: "unreadable", error: "Claude declined to read that command." };
    }

    const parsed = response.parsed_output;
    return parsed
      ? { ok: true, command: parsed }
      : { ok: false, failure: "unreadable", error: "Claude returned an unreadable command." };
  } catch (error) {
    return { ok: false, failure: failureOf(error), error: describeAnthropicError(error, credentialKind(apiKey), model) };
  }
}

// ---------------------------------------------------------------------------
// A DM from someone other than the bot's owner
// ---------------------------------------------------------------------------

export const DM_ACTIONS = ["started", "done", "stop_reminders", "resume_reminders", "list", "request", "thanks", "other"] as const;

const DirectMessageSchema = z.object({
  action: z.enum(DM_ACTIONS).describe("What the person wants. See the instructions."),
  task: z
    .number()
    .int()
    .describe("For started / done / stop_reminders / resume_reminders: the number of the task they mean from the numbered list, or 0 when it is the one they replied to or you cannot tell."),
  // Required like every field: "" is "no answer".
  proof: z
    .string()
    .describe("For done: the words in the message that show or describe the finished work, copied as written. Empty when it only says it is done, and for every other action."),
});

export type DirectMessageReading = z.infer<typeof DirectMessageSchema>;

const DM_SYSTEM = `You read one message that someone sent to a task-tracking bot — privately,
or in a server channel tagging it ("where" says which). The bot belongs to one
person — named in the message as "bot belongs to" — and tracks the tasks that
person hands out. The sender is usually someone they gave work to. Decide what
the sender wants:

  started           they have begun a task of theirs, or are working on it
                    right now ("start", "on it", "started", "đang làm")
  done              a task of theirs is finished ("done", "xong rồi", "sent it")
  stop_reminders    they want the reminders about a task to stop
  resume_reminders  they want those reminders back
  list              they ask what tasks they have, or what is due
  request           they clearly ask the bot's owner for something, or hand
                    the owner work ("can you review my draft by Friday?") —
                    the sender is then asked to confirm it as a task
  thanks            thanks, an acknowledgement or small talk, nothing to do
                    ("ok", "will do", "👍", "hi")
  other             anything else, or you cannot tell

"replying to" names the task when they replied to the bot's message about it.
"their open tasks" is numbered. For started, done, stop_reminders and resume_reminders,
return in \`task\` the number of the task they mean, or 0 when it is the one
they replied to or the message does not say which.

A promise to do the work later ("I'll finish it tomorrow", "will do") is
"thanks" — neither "started" nor "done". Choose "request" only when they plainly ask the owner for something;
an update, a question about a task, a promise or small talk is not a request.
When unsure, choose "thanks" or "other" — never turn chat into work.

Handing in the work is "done" too: a message that shares the result — "here is
the final cut", a link, "attached", a screenshot ("files: N" says the message
carried files) — even without the word "done". For "done", copy into \`proof\`
the words that show or describe what was done ("rendered both exports and
uploaded them to Drive"); leave it empty when the message only says it is
done ("done", "xong rồi", "finished!"). Links and files are read by the
tracker itself — do not copy them.`;

/**
 * Read one DM from someone other than the bot's owner: an answer about their
 * own tasks, or a request for the owner. Runs on the OWNER's credential and
 * model — it is the owner's bot being written to — like every other message
 * the owner's tracker reads.
 */
export async function readDirectMessage({
  apiKey,
  model,
  ownerName,
  authorName,
  content,
  replyingTo,
  tasks,
  where = "direct message",
  files = 0,
}: {
  apiKey: string;
  model: string;
  ownerName: string | null;
  authorName: string | null;
  content: string;
  /** The title of the task whose bot message this replies to, or null. */
  replyingTo: string | null;
  /** Their open tasks from the owner, in the order the bot lists them. */
  tasks: string[];
  /** A private message, or a channel message that tagged the bot. */
  where?: "direct message" | "server channel";
  /** How many files the message carried — handing in the work. */
  files?: number;
}): Promise<{ ok: true; reading: DirectMessageReading } | { ok: false; error: string; failure: ClassifyFailure }> {
  try {
    const chosen = model || DEFAULT_MODEL;
    const modern = supportsAdaptiveThinking(chosen);
    const listed = tasks.length > 0 ? tasks.map((title, i) => `${i + 1}. ${title}`).join("\n") : "(none)";

    const response = await clientFor(apiKey, 1).messages.parse({
      model: chosen,
      max_tokens: 4000,
      system: DM_SYSTEM,
      ...(modern ? { thinking: { type: "adaptive" as const } } : {}),
      output_config: {
        ...(modern ? { effort: "low" as const } : {}),
        format: zodOutputFormat(DirectMessageSchema),
      },
      messages: [
        {
          role: "user",
          content:
            `bot belongs to: ${ownerName ?? "unknown"}\nfrom: ${authorName ?? "unknown"}\nwhere: ${where}\nfiles: ${files}\n` +
            `replying to: ${replyingTo ?? "nothing"}\ntheir open tasks:\n${listed}\n\nmessage: ${content}`,
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      return { ok: false, failure: "unreadable", error: "Claude declined to read that message." };
    }

    const parsed = response.parsed_output;
    return parsed
      ? { ok: true, reading: parsed }
      : { ok: false, failure: "unreadable", error: "Claude returned an unreadable answer." };
  } catch (error) {
    return { ok: false, failure: failureOf(error), error: describeAnthropicError(error, credentialKind(apiKey), model) };
  }
}

// ---------------------------------------------------------------------------
// "Did I already give someone a task about X?" (Lucky35, 2026-10-12)
// ---------------------------------------------------------------------------

/** What one question cost, in tokens — whether the cached task list was read back. */
export type AskUsage = { input: number; cacheRead: number; cacheWrite: number; output: number };

const AskSchema = z.object({
  matches: z
    .array(
      z.object({
        index: z.number().int().describe("The task's number as listed, [n]."),
        why: z.string().describe("A few words on what about it matches the question — not its title again."),
      }),
    )
    .describe("Every listed task about what the question asks — none when nothing is."),
  answer: z.string().describe("One or two short sentences answering the question, in its language."),
});

const ASK_SYSTEM = `You help the owner of a task tracker remember the work they have
already handed out. They give many tasks to many people and forget what they
gave. You get every task they have given — open and finished — one numbered
line each, and a question such as "did I give anyone a task about the GPU
server?".

Find EVERY task that is about what they ask — all of them, not a sample: by
MEANING, not exact words —
paraphrases, synonyms, abbreviations, typos, the same piece of work described
differently, and a question in another language than the tasks. A task that
is only loosely related is not a match. Answer with the numbers exactly as
listed, each once, closest first; never a number that is not on the list.

Dates are in the owner's time zone. "This week" runs from Monday up to today;
"last week" is the Monday to Sunday before it; "yesterday" is the day before
today. A question about a person and a time wants every task given to that
person in that time, whatever it is about.

A task was given to the person named after "for". The People list, when
there is one, gives the other names those people go by — match a name in the
question against them too. A name that appears only inside a task's title or
detail is NOT who it was given to.

Then answer the question directly in one or two short sentences — who it went
to, when, and whether it is still open — using only what the list says. Write
the answer in the language the QUESTION is written in: an English question
gets an English answer, a Vietnamese question a Vietnamese one. Any number you
state must match the tasks you return. Name tasks by what they are about,
never by their [n] number: the owner never sees the numbers. When nothing
matches, say plainly that no task they gave is about that, and do not guess.`;

/**
 * Which of the owner's given tasks a question is about. Runs on the owner's
 * own credential and chosen model, like everything else here; the answer is
 * numbers into `list` (`lib/ask.ts` turns them back into tasks).
 */
export async function askAboutTasks({
  apiKey,
  model,
  question,
  people = "",
  list,
  count,
  today,
  timezone,
}: {
  apiKey: string;
  model: string;
  question: string;
  /** `peopleLegend`: the other names the people go by; empty when none. */
  people?: string;
  /** `askLines` of the tasks, newest first. */
  list: string;
  count: number;
  /** Today in the owner's zone with its weekday (`todayIn`) — "still open" and "last week" need it. */
  today: string;
  timezone: string;
}): Promise<
  | { ok: true; matches: Array<{ index: number; why: string }>; answer: string; usage: AskUsage }
  | { ok: false; error: string; failure: ClassifyFailure }
> {
  try {
    const chosen = model || DEFAULT_MODEL;
    const modern = supportsAdaptiveThinking(chosen);

    const response = await clientFor(apiKey, 1).messages.parse({
      model: chosen,
      max_tokens: 8000,
      system: ASK_SYSTEM,
      ...(modern ? { thinking: { type: "adaptive" as const } } : {}),
      output_config: {
        ...(modern ? { effort: "medium" as const } : {}),
        format: zodOutputFormat(AskSchema),
      },
      messages: [
        {
          role: "user",
          content: [
            // The list first and marked for caching: a second question about
            // the same tasks reads it back instead of paying for it again.
            {
              type: "text",
              text: `${people ? `People (other names they go by):\n${people}\n\n` : ""}Tasks you have given (${count}), newest first:\n${list}`,
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: `Today: ${today} (${timezone || "UTC"}).\n\nQuestion: ${question}` },
          ],
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      return { ok: false, failure: "unreadable", error: "Claude declined to answer that question." };
    }
    if (response.stop_reason === "max_tokens") {
      return { ok: false, failure: "unreadable", error: "Claude's answer was cut off — ask a narrower question." };
    }

    const parsed = response.parsed_output;
    const usage: AskUsage = {
      input: response.usage.input_tokens,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
      cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
      output: response.usage.output_tokens,
    };
    return parsed
      ? { ok: true, matches: parsed.matches, answer: parsed.answer, usage }
      : { ok: false, failure: "unreadable", error: "Claude returned an unreadable answer." };
  } catch (error) {
    return { ok: false, failure: failureOf(error), error: describeAnthropicError(error, credentialKind(apiKey), model) };
  }
}
