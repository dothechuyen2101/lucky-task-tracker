/**
 * Turning what the classifier said into a real instant — and deciding whether
 * the machine is allowed to write it.
 *
 * Erik reversed the "deadlines are manual" rule in session on 2026-09-07: when
 * the model can resolve a real time out of a message's own words, the task gets
 * a live `deadline`, a cadence and a derived `next_alert_at` in the same tick.
 * Every part of that decision lives here, for three reasons:
 *
 *   1. It is pure. No network, no Supabase, no clock of its own — `now` is
 *      always passed in — so the whole policy is unit-testable and the worker's
 *      50s budget never grows.
 *
 *   2. It has ZERO imports, on purpose. Do not add one, not even a relative
 *      one. `lib/worker.ts` is unreachable from a test, which is exactly how the
 *      old module-private date parser in it escaped ever being tested.
 *
 *   3. "A later pass never overwrites a human's deadline" is a rule, and a rule
 *      that lives in a comment is not a rule. It lives in `decideAutoDeadline`,
 *      is checked before anything else, and is pinned by a test.
 *
 * Zone arithmetic is done with `Intl.DateTimeFormat().formatToParts` and a
 * two-pass offset solve rather than a date library — there is no date library
 * in `package.json` and adding one would put an import in this file.
 */

// ---------------------------------------------------------------------------
// Constants the tests pin
// ---------------------------------------------------------------------------

/**
 * Matches `applyCommand`'s `?? 1440` in lib/worker.ts — a deadline with no
 * cadence would never remind anyone, so an auto deadline gets a daily one.
 */
export const DEFAULT_AUTO_CADENCE_MINUTES = 1440;

/**
 * Any date-only reference ("Tuesday", "tomorrow", a bare ISO date) lands at
 * 17:00 in the user's own zone rather than midnight UTC.
 */
export const DEFAULT_DEADLINE_HOUR = 17;

/** "tonight" / "this evening". */
export const TONIGHT_HOUR = 21;

/** Preserves the sanity bound of the worker-private parser this replaces. */
export const MAX_DEADLINE_YEARS = 5;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const MS_PER_WEEK = 7 * MS_PER_DAY;
const MAX_DEADLINE_MS = MAX_DEADLINE_YEARS * 365 * MS_PER_DAY;

// ---------------------------------------------------------------------------
// Zone arithmetic — no library (see the header)
// ---------------------------------------------------------------------------

export type ZonedParts = {
  year: number;
  /**
   * 1-based, like the string Intl hands back. `Date.UTC` wants it 0-based, so
   * every call site subtracts one — getting that wrong is a silent one-month
   * error that no type catches.
   */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
};

export type WallClock = {
  year: number;
  /** 1-based, matching `ZonedParts`. */
  month: number;
  day: number;
  hour: number;
  minute: number;
};

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const UNIT_MS: Record<string, number> = {
  minute: MS_PER_MINUTE,
  hour: MS_PER_HOUR,
  day: MS_PER_DAY,
  week: MS_PER_WEEK,
};

/**
 * True when the runtime recognises the IANA zone. Every entry point falls back
 * to "UTC" rather than throwing, because a bad zone in one profile must not
 * take down a whole classification batch.
 */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || typeof timeZone !== "string") return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

function safeZone(timeZone: string): string {
  return isValidTimeZone(timeZone) ? timeZone : "UTC";
}

/** The wall clock a person in `timeZone` sees at `instant`. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone(timeZone),
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  }).formatToParts(instant);

  const bag: Record<string, string> = {};
  for (const part of parts) bag[part.type] = part.value;

  // The hourCycle quirk: with hour12:false some runtimes render midnight as
  // "24" rather than "00".
  const hour = Number(bag.hour);

  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: hour === 24 ? 0 : hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
    weekday: WEEKDAY_INDEX[String(bag.weekday ?? "").slice(0, 3).toLowerCase()] ?? 0,
  };
}

/** The zone's offset from UTC at `instant`, in ms, positive east. */
export function offsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime();
}

/**
 * The instant at which a person in `timeZone` sees this wall clock.
 *
 * Two passes, both subtracting an offset from the SAME `guess`. One pass is an
 * hour out on the days either side of a DST transition, because the offset it
 * looks up is the offset at the wrong instant. Pinned by the
 * "2026-03-08T06:00:00" case in the tests: one pass says 11:00Z, two say 10:00Z.
 */
export function fromZoned(wall: WallClock, timeZone: string): Date {
  const zone = safeZone(timeZone);
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0);
  const first = guess - offsetMs(new Date(guess), zone);
  const second = guess - offsetMs(new Date(first), zone);
  return new Date(second);
}

/** The zone the browser is in, or "UTC". Safe to call on the server. */
export function detectBrowserTimeZone(): string {
  try {
    const detected = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(detected) ? detected : "UTC";
  } catch {
    return "UTC";
  }
}

// ---------------------------------------------------------------------------
// Resolving what the model said
// ---------------------------------------------------------------------------

export type DeadlineContext = {
  /**
   * The message's own `sent_at` — relative phrases resolve against this, not
   * against `now`, so a backfilled message is read in its own past.
   */
  sentAt: string;
  timezone: string;
  now: Date;
};

/**
 * The guard that keeps `new Date("36")` and other engine-specific accidents out
 * of the ISO branch.
 */
const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}([T ]|$)/;

const ISO_SHAPE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * `in 3 days`, `3 days`, `an hour`. Nothing else — this grammar is fixed and
 * must not grow into an NLP library.
 */
const DURATION = /^(?:in\s+)?(\d{1,5}|an?)\s+(minute|hour|day|week)s?$/;

const WEEKDAY_PHRASE =
  /^(?:(by|on|this|next)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/;

const MONTH_WORDS =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const MONTH_INDEX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * A calendar day with no year: "october 3", "oct 3rd", "3 oct", "3rd of
 * october". The next such day on or after the day the message was sent, at the
 * default hour — the model is asked for ISO dates, so this is here for the
 * words `deadlinePhraseFromText` reads when the model returned nothing.
 */
const MONTH_DAY = new RegExp(`^(?:(?:by|on)\\s+)?(${MONTH_WORDS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?$`);
const DAY_MONTH = new RegExp(`^(?:(?:by|on)\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_WORDS})\\.?$`);

function monthDayBranch(text: string, local: ZonedParts, zone: string): Date | null {
  const md = MONTH_DAY.exec(text);
  const dm = md ? null : DAY_MONTH.exec(text);
  if (!md && !dm) return null;

  const month = MONTH_INDEX[(md ? md[1] : dm![2]).slice(0, 3)];
  const day = Number(md ? md[2] : dm![1]);
  if (!month || day < 1 || day > 31) return null;

  for (const year of [local.year, local.year + 1]) {
    const date = new Date(Date.UTC(year, month - 1, day));
    // Rejects "february 30" rather than rolling it into March.
    if (date.getUTCMonth() !== month - 1) return null;
    const onOrAfterSent = Date.UTC(year, month - 1, day) >= Date.UTC(local.year, local.month - 1, local.day);
    if (onOrAfterSent) return fromZoned({ year, month, day, hour: DEFAULT_DEADLINE_HOUR, minute: 0 }, zone);
  }
  return null;
}

function isoBranch(text: string, zone: string): Date | null {
  if (!ISO_PREFIX.test(text)) return null;

  const m = ISO_SHAPE.exec(text);
  if (!m) return null;

  // Carries an offset or a Z: it names an instant, so take it as-is.
  if (m[7]) {
    const explicit = new Date(text);
    return Number.isNaN(explicit.getTime()) ? null : explicit;
  }

  // No offset. `new Date("2026-09-08T17:00:00")` is LOCAL time — UTC on Vercel —
  // so reading it naively puts a Johannesburg user's 17:00 two hours late.
  return fromZoned(
    {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: m[4] === undefined ? DEFAULT_DEADLINE_HOUR : Number(m[4]),
      minute: m[5] === undefined ? 0 : Number(m[5]),
    },
    zone,
  );
}

/**
 * `days` on from a local calendar date, at `hour` local. Pure UTC calendar
 * arithmetic on the date, then one zoned solve — so month ends and DST days
 * both land right.
 */
function localDayAt(base: ZonedParts, days: number, hour: number, zone: string): Date {
  const shifted = new Date(Date.UTC(base.year, base.month - 1, base.day) + days * MS_PER_DAY);
  return fromZoned(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour,
      minute: 0,
    },
    zone,
  );
}

function relativeBranch(text: string, zone: string, ctx: DeadlineContext): Date | null {
  const sent = new Date(ctx.sentAt);
  const base = Number.isNaN(sent.getTime()) ? ctx.now : sent;

  const duration = DURATION.exec(text);
  if (duration) {
    const count = /^an?$/.test(duration[1]) ? 1 : Number(duration[1]);
    const unit = UNIT_MS[duration[2]];
    if (!unit || !Number.isFinite(count)) return null;
    // Pure offset arithmetic, no wall-clock rounding: "in 24 hours" is exactly
    // +24h, even across a DST transition.
    return new Date(base.getTime() + count * unit);
  }

  const local = zonedParts(base, zone);

  if (text === "today") return localDayAt(local, 0, DEFAULT_DEADLINE_HOUR, zone);
  if (text === "tonight" || text === "this evening") return localDayAt(local, 0, TONIGHT_HOUR, zone);
  if (text === "tomorrow") return localDayAt(local, 1, DEFAULT_DEADLINE_HOUR, zone);

  const weekday = WEEKDAY_PHRASE.exec(text);
  if (weekday) {
    const target = WEEKDAY_INDEX[weekday[2].slice(0, 3)];
    // Strictly after today: "Tuesday" said on a Tuesday means the next one.
    // "next Tuesday" is the SAME day — the nearest Tuesday still ahead, never a
    // week further (Lucky35, 2026-09-30: said on a Monday it meant tomorrow,
    // and eight days out was a deadline nobody gave).
    let delta = (target - local.weekday + 7) % 7;
    if (delta === 0) delta = 7;
    return localDayAt(local, delta, DEFAULT_DEADLINE_HOUR, zone);
  }

  return monthDayBranch(text, local, zone);
}

/**
 * The model's `suggested_deadline` string → an absolute instant, as an ISO
 * string, or null when it cannot be resolved.
 *
 * Replaces the module-private date parser that used to live in lib/worker.ts,
 * which only validated an ISO string: it read a bare local time in the server's
 * zone and understood no prose at all.
 */
export function resolveSuggestedDeadline(raw: string, ctx: DeadlineContext): string | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;

  const zone = safeZone(ctx.timezone);
  const resolved = isoBranch(text, zone) ?? relativeBranch(text.toLowerCase(), zone, ctx);
  if (!resolved || Number.isNaN(resolved.getTime())) return null;

  // Sanity, preserved from the code this replaces.
  if (Math.abs(resolved.getTime() - ctx.now.getTime()) > MAX_DEADLINE_MS) return null;

  return resolved.toISOString();
}

// ---------------------------------------------------------------------------
// Reading a deadline straight out of the message
// ---------------------------------------------------------------------------

const DURATION_UNIT: Record<string, string> = {
  m: "minute",
  min: "minute",
  mins: "minute",
  minute: "minute",
  minutes: "minute",
  h: "hour",
  hr: "hour",
  hrs: "hour",
  hour: "hour",
  hours: "hour",
  d: "day",
  day: "day",
  days: "day",
  w: "week",
  wk: "week",
  wks: "week",
  week: "week",
  weeks: "week",
};

const WEEKDAY_NAME: Record<string, string> = {
  mon: "monday",
  monday: "monday",
  tue: "tuesday",
  tues: "tuesday",
  tuesday: "tuesday",
  wed: "wednesday",
  wednesday: "wednesday",
  thu: "thursday",
  thur: "thursday",
  thurs: "thursday",
  thursday: "thursday",
  fri: "friday",
  friday: "friday",
  sat: "saturday",
  saturday: "saturday",
  sun: "sunday",
  sunday: "sunday",
};

/**
 * A duration only counts when a word in front of it says it is a deadline:
 * "deadline is 24 hours", "due in 36h", "within 2 days". A bare "a 30 minute
 * video" is a description of the work, not a clock — and neither is "in 5
 * minutes" on its own ("the bug shows up in 5 minutes"), which is why a plain
 * "in" is not a cue here: the model reads "need it in an hour" properly, and
 * this net only catches what is unmistakably a deadline (Lucky35, 2026-09-30:
 * the net was inventing deadlines, and a five-minute one DMs "Overdue" almost
 * at once).
 */
const CUED_DURATION =
  /\b(?:deadline|due|within|eta|turnaround)\b(?:\s*(?:is|of|in|within|:|=|-|–))*\s*(\d{1,4}|an?)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w)\b/;

/** "24h deadline", "a 2-day turnaround": the duration first, the cue after. */
const DURATION_THEN_CUE =
  /\b(\d{1,4}|an?)[\s-]*(minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|wks?|w)\s+(?:deadline|turnaround)\b/;

/**
 * "36 hours" standing alone as its own clause — "redo the thumbnail, 36 hours"
 * or "fix login - 24h" — which is how people write a deadline after the ask.
 * Only between punctuation or the ends of the message, so "a 30 minute video"
 * never qualifies.
 */
const STANDALONE_DURATION =
  /(?:^|[,;:(—–-])\s*(\d{1,4})\s*(minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|wks?|w)\s*(?:$|[.,;!)—–-])/;

/**
 * The same, closing the message with no comma in front: "redo the thumbnail
 * 36 hours". Not after a word that makes it a length of time rather than a
 * deadline — "took 2 days", "for 3 hours", "in 5 minutes" (the model reads
 * that one; alone it is as often "shows up in 5 minutes" as a deadline).
 */
const TRAILING_DURATION = /(?:^|\s)(\d{1,4})\s*(hours?|hrs?|h|days?|d|weeks?|wks?|w)\s*[.!]*$/;

const LENGTH_NOT_DEADLINE =
  /\b(?:took|take|takes|taking|for|after|lasted|lasts|over|about|around|of|every|each|than|last|past|in|by|to|a|the|first|next|only|just)\s*$/;

function trailingDuration(text: string): RegExpExecArray | null {
  const match = TRAILING_DURATION.exec(text);
  if (!match) return null;
  return LENGTH_NOT_DEADLINE.test(text.slice(0, match.index)) ? null : match;
}

/**
 * "by oct 3", "due 3rd october", "deadline october 3" — a named month behind a
 * cue, returned in the words `resolveSuggestedDeadline` reads (`MONTH_DAY`).
 * Not behind "on": "the meeting on oct 3" dates the meeting, not the work.
 */
const CUED_MONTH_DAY = new RegExp(
  `\\b(?:by|before|until|till|due|deadline)(?:\\s+(?:is|on|by))?\\s+(?:the\\s+)?((?:${MONTH_WORDS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTH_WORDS}))\\b`,
);

const WEEKDAY_WORDS =
  "monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thur?s?|fri|sat|sun";

/**
 * A cue word, then a weekday. Only behind a cue: "notes from the Monday
 * meeting" names a day without setting a deadline on it — and "on" is not one,
 * because "the bug we saw on Monday" is not due next Monday.
 */
const CUED_WEEKDAY = new RegExp(`\\b(by|before|until|till|due|this|next)\\s+(${WEEKDAY_WORDS})\\b`);

const ISO_DATE_IN_TEXT = /\b(\d{4}-\d{2}-\d{2})(?:[ t](\d{2}:\d{2}))?\b/;

function durationPhrase(rawCount: string, rawUnit: string): string | null {
  const unit = DURATION_UNIT[rawUnit];
  const count = /^an?$/.test(rawCount) ? "1" : String(Number(rawCount));
  if (!unit || count === "0") return null;
  return `in ${count} ${unit}${count === "1" ? "" : "s"}`;
}

/**
 * The deadline a message states in plain words, normalised into the grammar
 * `resolveSuggestedDeadline` reads — or null when it states none.
 *
 * This is the safety net under the model, not a replacement for it: the model
 * reads any language and any phrasing, this reads a handful of English shapes
 * the board was seen failing on ("deadline is 24 hours" landing under "No
 * deadline yet"). It errs towards silence — a deadline it invents DMs people —
 * so every shape it reads says "deadline" in some way. Mention markup and links
 * are stripped first so the digits in a snowflake or a URL are never read as a
 * count.
 *
 * Precedence, not position: an explicit date beats a duration, which beats a
 * weekday, which beats today / tonight / tomorrow.
 */
export function deadlinePhraseFromText(content: string): string | null {
  if (typeof content !== "string") return null;

  const text = content
    .replace(/<[@#][!&]?\d+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .toLowerCase()
    .trim();

  const date = ISO_DATE_IN_TEXT.exec(text);
  if (date) return date[2] ? `${date[1]}T${date[2]}` : date[1];

  const named = CUED_MONTH_DAY.exec(text);
  if (named) return named[1].replace(/\./g, "").replace(/\s+/g, " ");

  const durations = [CUED_DURATION.exec(text), DURATION_THEN_CUE.exec(text), STANDALONE_DURATION.exec(text), trailingDuration(text)];
  for (const duration of durations) {
    const phrase = duration ? durationPhrase(duration[1], duration[2]) : null;
    if (phrase) return phrase;
  }

  const cued = CUED_WEEKDAY.exec(text);
  if (cued) {
    const day = WEEKDAY_NAME[cued[2]];
    if (day) return day;
  }

  // "tonight's stream" and "tomorrow's meeting" name a thing, not a deadline.
  if (/\btonight\b(?!'s|’s)/.test(text)) return "tonight";
  if (/\b(?:tomorrow|tmrw|tmr)\b(?!'s|’s)/.test(text)) return "tomorrow";
  if (/\b(?:by|before|until|due)\s+(?:today|eod|end of (?:the )?day)\b/.test(text)) return "today";

  return null;
}

/**
 * Which deadline phrase to hand `decideAutoDeadline`: the model's when it
 * resolves, otherwise whatever the message itself says in words it can be
 * trusted on.
 *
 * When neither resolves, the model's own answer goes through unchanged, so the
 * decision still reports "no-suggestion" or "unparseable" truthfully rather than
 * blaming the fallback.
 */
export function pickDeadlinePhrase(modelSuggestion: string, content: string, ctx: DeadlineContext): string {
  const suggested = typeof modelSuggestion === "string" ? modelSuggestion.trim() : "";
  if (suggested && resolveSuggestedDeadline(suggested, ctx)) return suggested;

  const fromText = deadlinePhraseFromText(content);
  if (fromText && resolveSuggestedDeadline(fromText, ctx)) return fromText;

  return suggested;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type AutoDeadlineDecision =
  | {
      write: false;
      reason: "no-suggestion" | "unparseable" | "in-the-past" | "manual-source" | "already-dated";
    }
  | { write: true; deadline: string; source: "auto"; alertEveryMinutes: number };

export type AutoDeadlineInput = {
  suggested: string;
  sentAt: string;
  timezone: string;
  now: Date;
  existing?: {
    deadline: string | null;
    deadlineSource: "auto" | "manual" | null;
    alertEveryMinutes: number | null;
  } | null;
};

/**
 * May the machine write this deadline?
 *
 * The order matters and is the whole point of the function existing:
 * "never overwrite a human" is checked FIRST and can never be overridden.
 */
export function decideAutoDeadline(input: AutoDeadlineInput): AutoDeadlineDecision {
  const existing = input.existing ?? null;

  // 1. A human set this clock. Nothing below can override that.
  if (existing?.deadlineSource === "manual") return { write: false, reason: "manual-source" };

  // 2. Already dated by an earlier auto pass — do not re-date it.
  if (existing?.deadline) return { write: false, reason: "already-dated" };

  const suggested = typeof input.suggested === "string" ? input.suggested.trim() : "";
  if (!suggested) return { write: false, reason: "no-suggestion" };

  const deadline = resolveSuggestedDeadline(suggested, {
    sentAt: input.sentAt,
    timezone: input.timezone,
    now: input.now,
  });
  if (!deadline) return { write: false, reason: "unparseable" };

  // The backfill guard. Months-old messages resolve against their own historic
  // sent_at, so their dates are behind `now` — and anything inside
  // MAX_OVERDUE_DAYS would immediately start DMing. A past value still goes into
  // suggested_deadline, so a human can still accept it from the board.
  if (new Date(deadline).getTime() <= input.now.getTime()) {
    return { write: false, reason: "in-the-past" };
  }

  // A deadline with no cadence would never remind anyone.
  return {
    write: true,
    deadline,
    source: "auto",
    alertEveryMinutes: existing?.alertEveryMinutes ?? DEFAULT_AUTO_CADENCE_MINUTES,
  };
}

// ---------------------------------------------------------------------------
// Extending a deadline by hand
// ---------------------------------------------------------------------------

/** The longest extension one command may give: a year. Anything more is a misreading. */
export const MAX_EXTEND_MINUTES = 366 * 24 * 60;

/** The board's one-press extensions, beside the deadline field. */
export const EXTEND_CHOICES = [
  { minutes: 60, label: "+1h" },
  { minutes: 6 * 60, label: "+6h" },
  { minutes: 24 * 60, label: "+1 day" },
] as const;

/**
 * "Give her 6 more hours": the deadline it has, moved later by `minutes`
 * (Lucky35, 2026-10-06). Counted from the deadline, not from now — that is
 * what "extra" means — unless that would still leave it in the past, or there
 * is none: then from now, so an extension is never a deadline already missed.
 * The score counts only the final deadline (`20261005_02`), so a miss of the
 * one it replaces is taken back.
 */
export function extendDeadline(current: string | null, minutes: number, now: Date): string {
  const step = Math.min(Math.max(Math.round(minutes), 1), MAX_EXTEND_MINUTES) * 60_000;
  const base = current ? Date.parse(current) : NaN;
  const moved = Number.isFinite(base) ? base + step : NaN;
  return new Date(Number.isFinite(moved) && moved > now.getTime() ? moved : now.getTime() + step).toISOString();
}
