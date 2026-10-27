import { describe, expect, it } from "vitest";

import {
  extendDeadline,
  DEFAULT_AUTO_CADENCE_MINUTES,
  DEFAULT_DEADLINE_HOUR,
  MAX_DEADLINE_YEARS,
  TONIGHT_HOUR,
  deadlinePhraseFromText,
  decideAutoDeadline,
  detectBrowserTimeZone,
  fromZoned,
  isValidTimeZone,
  offsetMs,
  pickDeadlinePhrase,
  resolveSuggestedDeadline,
  zonedParts,
} from "./deadlines";

/**
 * Every resolver case asserts an EXACT instant. `toBeTruthy()` on a date parser
 * proves only that something came back, and the bugs this module exists to stop
 * — a bare local time read in the server's zone, a one-pass offset solve, a
 * weekday that resolves to today — all return a perfectly truthy wrong answer.
 *
 * The calendar facts these cases rest on, verified against Intl before they
 * were written: 2026-09-01 is a Tuesday, 2026-09-02 a Wednesday, 2026-09-08 the
 * next Tuesday; the US DST transition is 2026-03-08.
 */

const JHB = "Africa/Johannesburg"; // UTC+2 all year, no DST
const NY = "America/New_York"; // EST (-5) → EDT (-4) on 2026-03-08

// A Monday, 11:00 local in Johannesburg.
const SENT = "2026-09-07T09:00:00.000Z";
const NOW = new Date("2026-09-07T09:05:00.000Z");

const ctx = (over: Partial<{ sentAt: string; timezone: string; now: Date }> = {}) => ({
  sentAt: SENT,
  timezone: JHB,
  now: NOW,
  ...over,
});

describe("resolveSuggestedDeadline — durations", () => {
  it('resolves "in 24 hours" to exactly sent_at + 24h', () => {
    expect(resolveSuggestedDeadline("in 24 hours", ctx())).toBe("2026-09-08T09:00:00.000Z");
  });

  it('resolves "24 hours" without the leading "in" the same way', () => {
    expect(resolveSuggestedDeadline("24 hours", ctx())).toBe("2026-09-08T09:00:00.000Z");
  });

  it('resolves "in 36 hours" across a local day boundary, exactly', () => {
    const resolved = resolveSuggestedDeadline("in 36 hours", ctx());
    expect(resolved).toBe("2026-09-08T21:00:00.000Z");

    // The local wall clock is the user-visible claim: 23:00 on the 8th, where
    // the message itself was sent at 11:00 on the 7th.
    const sentLocal = zonedParts(new Date(SENT), JHB);
    const local = zonedParts(new Date(resolved as string), JHB);
    expect(sentLocal.day).toBe(7);
    expect(local.day).toBe(8);
    expect(local.hour).toBe(23);
  });

  it('counts "an" and "a" as one', () => {
    expect(resolveSuggestedDeadline("in an hour", ctx())).toBe("2026-09-07T10:00:00.000Z");
    expect(resolveSuggestedDeadline("in a week", ctx())).toBe("2026-09-14T09:00:00.000Z");
  });

  it("does no wall-clock rounding — a duration is pure offset arithmetic", () => {
    expect(resolveSuggestedDeadline("in 90 minutes", ctx())).toBe("2026-09-07T10:30:00.000Z");
    expect(resolveSuggestedDeadline("in 3 days", ctx())).toBe("2026-09-10T09:00:00.000Z");
  });
});

describe("resolveSuggestedDeadline — Tuesday and the rest of the weekday grammar", () => {
  // Sent on a Wednesday.
  const wednesday = ctx({ sentAt: "2026-09-02T09:00:00.000Z", now: new Date("2026-09-02T09:00:00.000Z") });

  it('resolves "Tuesday" sent on a Wednesday to the following Tuesday at 17:00 local', () => {
    expect(resolveSuggestedDeadline("Tuesday", wednesday)).toBe("2026-09-08T15:00:00.000Z");
    expect(zonedParts(new Date("2026-09-08T15:00:00.000Z"), JHB).hour).toBe(DEFAULT_DEADLINE_HOUR);
  });

  it('resolves "Tuesday" sent ON a Tuesday to the Tuesday a week later, not the same day', () => {
    const tuesday = ctx({
      sentAt: "2026-09-01T09:00:00.000Z",
      now: new Date("2026-09-01T09:00:00.000Z"),
    });
    expect(zonedParts(new Date("2026-09-01T09:00:00.000Z"), JHB).weekday).toBe(2); // Tue
    expect(resolveSuggestedDeadline("Tuesday", tuesday)).toBe("2026-09-08T15:00:00.000Z");
  });

  it('accepts the "by" / "on" / "this" prefixes, and is case-insensitive', () => {
    expect(resolveSuggestedDeadline("by Tuesday", wednesday)).toBe("2026-09-08T15:00:00.000Z");
    expect(resolveSuggestedDeadline("on tuesday", wednesday)).toBe("2026-09-08T15:00:00.000Z");
    expect(resolveSuggestedDeadline("THIS TUESDAY", wednesday)).toBe("2026-09-08T15:00:00.000Z");
  });

  it('"next Tuesday" is the nearest Tuesday ahead, never a week further', () => {
    // Lucky35, 2026-09-30: said on a Wednesday it is six days out, like "Tuesday".
    expect(resolveSuggestedDeadline("next Tuesday", wednesday)).toBe("2026-09-08T15:00:00.000Z");
    expect(resolveSuggestedDeadline("next Tuesday", wednesday)).toBe(resolveSuggestedDeadline("tuesday", wednesday));
  });

  it("resolves a named day of a month to the next one on or after the sent day", () => {
    // SENT is 2026-09-07 in Johannesburg; 17:00 there is 15:00Z.
    expect(resolveSuggestedDeadline("october 3", ctx())).toBe("2026-10-03T15:00:00.000Z");
    expect(resolveSuggestedDeadline("3rd of oct", ctx())).toBe("2026-10-03T15:00:00.000Z");
    expect(resolveSuggestedDeadline("by sep 7", ctx())).toBe("2026-09-07T15:00:00.000Z");
    // Already gone this year: next year's, not a date in the past.
    expect(resolveSuggestedDeadline("sep 1", ctx())).toBe("2027-09-01T15:00:00.000Z");
    expect(resolveSuggestedDeadline("february 30", ctx())).toBeNull();
  });

  it('resolves "today", "tonight" and "tomorrow" at their fixed local hours', () => {
    expect(resolveSuggestedDeadline("today", ctx())).toBe("2026-09-07T15:00:00.000Z");
    expect(resolveSuggestedDeadline("tonight", ctx())).toBe("2026-09-07T19:00:00.000Z");
    expect(resolveSuggestedDeadline("this evening", ctx())).toBe("2026-09-07T19:00:00.000Z");
    expect(resolveSuggestedDeadline("tomorrow", ctx())).toBe("2026-09-08T15:00:00.000Z");

    expect(zonedParts(new Date("2026-09-07T19:00:00.000Z"), JHB).hour).toBe(TONIGHT_HOUR);
  });
});

describe("resolveSuggestedDeadline — the zone is the user's, not the server's", () => {
  it("reads an ISO string with no offset in the user's zone, not as UTC", () => {
    // The bug this pins: `new Date("2026-09-08T17:00:00")` is LOCAL time, which
    // is UTC on Vercel — so a Johannesburg 17:00 would land two hours late.
    expect(resolveSuggestedDeadline("2026-09-08T17:00:00", ctx())).toBe("2026-09-08T15:00:00.000Z");
    expect(resolveSuggestedDeadline("2026-09-08T17:00:00", ctx())).not.toBe(
      "2026-09-08T17:00:00.000Z",
    );
  });

  it("takes an ISO string that carries an offset, or a Z, exactly as written", () => {
    expect(resolveSuggestedDeadline("2026-09-08T17:00:00+02:00", ctx())).toBe(
      "2026-09-08T15:00:00.000Z",
    );
    expect(resolveSuggestedDeadline("2026-09-08T17:00:00Z", ctx())).toBe("2026-09-08T17:00:00.000Z");
  });

  it("gives a bare ISO date the default local hour", () => {
    expect(resolveSuggestedDeadline("2026-09-08", ctx())).toBe("2026-09-08T15:00:00.000Z");
  });

  it("resolves a weekday to 17:00 LOCAL on both sides of the 2026-03-08 DST transition", () => {
    // Before: EST (-5). Sent Monday 2026-03-02, 10:00 New York.
    const beforeSent = "2026-03-02T15:00:00.000Z";
    const before = resolveSuggestedDeadline(
      "Tuesday",
      ctx({ sentAt: beforeSent, timezone: NY, now: new Date(beforeSent) }),
    );
    expect(before).toBe("2026-03-03T22:00:00.000Z");
    expect(zonedParts(new Date(before as string), NY).hour).toBe(DEFAULT_DEADLINE_HOUR);

    // After: EDT (-4). Sent Monday 2026-03-09, 10:00 New York.
    const afterSent = "2026-03-09T14:00:00.000Z";
    const after = resolveSuggestedDeadline(
      "Tuesday",
      ctx({ sentAt: afterSent, timezone: NY, now: new Date(afterSent) }),
    );
    expect(after).toBe("2026-03-10T21:00:00.000Z");
    expect(zonedParts(new Date(after as string), NY).hour).toBe(DEFAULT_DEADLINE_HOUR);

    // Same local hour, one hour apart in absolute terms — which is the point.
    expect(new Date(after as string).getUTCHours()).not.toBe(
      new Date(before as string).getUTCHours(),
    );
  });

  it("pins the TWO-PASS offset solve — a wall clock inside the DST window", () => {
    // 06:00 on transition day in New York is 10:00Z (EDT, -4). A single-pass
    // solve looks up the offset at 06:00Z — still EST, -5 — and answers 11:00Z.
    // Nothing else in this suite catches that: at 17:00 both solves agree.
    expect(
      resolveSuggestedDeadline(
        "2026-03-08T06:00:00",
        ctx({ timezone: NY, now: new Date("2026-03-01T00:00:00.000Z") }),
      ),
    ).toBe("2026-03-08T10:00:00.000Z");
  });

  it("falls back to UTC on an invalid or empty time zone instead of throwing", () => {
    expect(() => resolveSuggestedDeadline("2026-09-08T17:00:00", ctx({ timezone: "Mars/Olympus" })))
      .not.toThrow();
    expect(resolveSuggestedDeadline("2026-09-08T17:00:00", ctx({ timezone: "Mars/Olympus" }))).toBe(
      "2026-09-08T17:00:00.000Z",
    );
    expect(resolveSuggestedDeadline("2026-09-08T17:00:00", ctx({ timezone: "" }))).toBe(
      "2026-09-08T17:00:00.000Z",
    );
  });
});

describe("resolveSuggestedDeadline — what it refuses", () => {
  it("returns null for prose outside the grammar", () => {
    expect(resolveSuggestedDeadline("sometime after the demo", ctx())).toBeNull();
    expect(resolveSuggestedDeadline("asap", ctx())).toBeNull();
    expect(resolveSuggestedDeadline("end of the sprint", ctx())).toBeNull();
  });

  it("returns null for empty and whitespace-only input", () => {
    expect(resolveSuggestedDeadline("", ctx())).toBeNull();
    expect(resolveSuggestedDeadline("   ", ctx())).toBeNull();
  });

  it("refuses the bare numbers a naive new Date() would happily accept", () => {
    // `new Date("36")` is a real date in V8. The ISO prefix guard is what keeps
    // engine-specific accidents like it out.
    expect(resolveSuggestedDeadline("36", ctx())).toBeNull();
    expect(resolveSuggestedDeadline("2026", ctx())).toBeNull();
  });

  it(`returns null more than ${MAX_DEADLINE_YEARS} years out, in either direction`, () => {
    expect(resolveSuggestedDeadline("2035-01-01T12:00:00Z", ctx())).toBeNull();
    expect(resolveSuggestedDeadline("2015-01-01T12:00:00Z", ctx())).toBeNull();
    // Just inside the bound still resolves.
    expect(resolveSuggestedDeadline("2030-01-01T12:00:00Z", ctx())).toBe("2030-01-01T12:00:00.000Z");
  });
});

describe("decideAutoDeadline — a human's clock is never overwritten", () => {
  const base = {
    suggested: "in 24 hours",
    sentAt: SENT,
    timezone: JHB,
    now: NOW,
  };

  it('refuses with reason "manual-source" even when the suggestion is a good future date', () => {
    expect(
      decideAutoDeadline({
        ...base,
        existing: { deadline: null, deadlineSource: "manual", alertEveryMinutes: null },
      }),
    ).toEqual({ write: false, reason: "manual-source" });
  });

  it('refuses with "manual-source" when the manual row already carries a deadline too', () => {
    expect(
      decideAutoDeadline({
        ...base,
        existing: {
          deadline: "2026-09-20T12:00:00.000Z",
          deadlineSource: "manual",
          alertEveryMinutes: 60,
        },
      }),
    ).toEqual({ write: false, reason: "manual-source" });
  });

  it("checks manual-source FIRST — before the suggestion is even looked at", () => {
    expect(
      decideAutoDeadline({
        ...base,
        suggested: "",
        existing: { deadline: null, deadlineSource: "manual", alertEveryMinutes: null },
      }),
    ).toEqual({ write: false, reason: "manual-source" });
  });

  it("refuses to re-date a row an earlier auto pass already dated", () => {
    expect(
      decideAutoDeadline({
        ...base,
        existing: {
          deadline: "2026-09-20T12:00:00.000Z",
          deadlineSource: "auto",
          alertEveryMinutes: 1440,
        },
      }),
    ).toEqual({ write: false, reason: "already-dated" });
  });
});

describe("decideAutoDeadline — the backfill guard", () => {
  it("refuses a suggestion that resolves before now", () => {
    // A months-old backfilled message: "in 24 hours" off its own sent_at is
    // January, and anything inside MAX_OVERDUE_DAYS would start DMing at once.
    const decision = decideAutoDeadline({
      suggested: "in 24 hours",
      sentAt: "2026-01-01T09:00:00.000Z",
      timezone: JHB,
      now: NOW,
      existing: null,
    });
    expect(decision).toEqual({ write: false, reason: "in-the-past" });
  });

  it("still resolves that past value, so suggested_deadline stays populated", () => {
    // Ruling 2 depends on this: the board's "Use <date>" button is the human's
    // way to accept a date the worker refused.
    expect(
      resolveSuggestedDeadline("in 24 hours", ctx({ sentAt: "2026-01-01T09:00:00.000Z" })),
    ).toBe("2026-01-02T09:00:00.000Z");
  });
});

describe("decideAutoDeadline — what it writes", () => {
  const base = { suggested: "in 24 hours", sentAt: SENT, timezone: JHB, now: NOW };

  it("writes the resolved deadline, stamped auto, with the daily default cadence", () => {
    expect(decideAutoDeadline({ ...base, existing: null })).toEqual({
      write: true,
      deadline: "2026-09-08T09:00:00.000Z",
      source: "auto",
      alertEveryMinutes: DEFAULT_AUTO_CADENCE_MINUTES,
    });
    expect(DEFAULT_AUTO_CADENCE_MINUTES).toBe(1440);
  });

  it("defaults the cadence when the row has none — without one nothing ever reminds", () => {
    const decision = decideAutoDeadline({
      ...base,
      existing: { deadline: null, deadlineSource: null, alertEveryMinutes: null },
    });
    expect(decision.write).toBe(true);
    expect(decision.write && decision.alertEveryMinutes).toBe(1440);
  });

  it("preserves the row's OWN cadence when it has one", () => {
    const decision = decideAutoDeadline({
      ...base,
      existing: { deadline: null, deadlineSource: "auto", alertEveryMinutes: 60 },
    });
    expect(decision.write).toBe(true);
    expect(decision.write && decision.alertEveryMinutes).toBe(60);
  });

  it('treats an omitted existing row the same as null', () => {
    expect(decideAutoDeadline(base)).toEqual({
      write: true,
      deadline: "2026-09-08T09:00:00.000Z",
      source: "auto",
      alertEveryMinutes: 1440,
    });
  });

  it("separates an empty suggestion from an unparseable one", () => {
    expect(decideAutoDeadline({ ...base, suggested: "" })).toEqual({
      write: false,
      reason: "no-suggestion",
    });
    expect(decideAutoDeadline({ ...base, suggested: "   " })).toEqual({
      write: false,
      reason: "no-suggestion",
    });
    expect(decideAutoDeadline({ ...base, suggested: "sometime after the demo" })).toEqual({
      write: false,
      reason: "unparseable",
    });
  });
});

describe("deadlinePhraseFromText — the words Lucky35's board missed", () => {
  it('reads "deadline is 24 hours" as a duration counted from sent_at', () => {
    const phrase = deadlinePhraseFromText("<@999999999999999999> <@222222222222222222> redo the thumbnail, deadline is 24 hours");
    expect(phrase).toBe("in 24 hours");
    expect(resolveSuggestedDeadline(phrase as string, ctx())).toBe("2026-09-08T09:00:00.000Z");
  });

  it("reads the short and spelled-out duration forms behind a cue word", () => {
    expect(deadlinePhraseFromText("deadline: 36h")).toBe("in 36 hours");
    expect(deadlinePhraseFromText("due in 36 hrs please")).toBe("in 36 hours");
    expect(deadlinePhraseFromText("within 2 days")).toBe("in 2 days");
    expect(deadlinePhraseFromText("eta 1 week")).toBe("in 1 week");
    expect(deadlinePhraseFromText("24h deadline on this one")).toBe("in 24 hours");
    expect(resolveSuggestedDeadline("in 1 hour", ctx())).toBe("2026-09-07T10:00:00.000Z");
  });

  it('reads "36 hours" standing on its own after the ask', () => {
    expect(deadlinePhraseFromText("<@1> redo the thumbnail, 36 hours")).toBe("in 36 hours");
    expect(deadlinePhraseFromText("fix login - 24h")).toBe("in 24 hours");
    expect(deadlinePhraseFromText("<@1> redo the thumbnail 36 hours")).toBe("in 36 hours");
    expect(deadlinePhraseFromText("redo the thumbnail 2 days.")).toBe("in 2 days");
  });

  it("does not read a duration that only describes the work, or when something happens", () => {
    expect(deadlinePhraseFromText("cut a 30 minute video from the stream")).toBeNull();
    // The audit's two invented deadlines (2026-09-30).
    expect(deadlinePhraseFromText("the error shows up in 5 minutes")).toBeNull();
    expect(deadlinePhraseFromText("the render took 2 days")).toBeNull();
    expect(deadlinePhraseFromText("look at the stream for 3 hours")).toBeNull();
    expect(deadlinePhraseFromText("render it in 3d")).toBeNull();
    expect(deadlinePhraseFromText("push the call back by 2 hours")).toBeNull();
  });

  it("reads a weekday behind a cue, abbreviations included; 'next' is the same day", () => {
    expect(deadlinePhraseFromText("send the invoice by Tuesday")).toBe("tuesday");
    expect(deadlinePhraseFromText("due fri pls")).toBe("friday");
    expect(deadlinePhraseFromText("ship it next Monday")).toBe("monday");
    expect(deadlinePhraseFromText("this thurs")).toBe("thursday");
  });

  it("never reads a weekday with no cue, or behind 'on', as a deadline", () => {
    expect(deadlinePhraseFromText("notes from the Monday meeting")).toBeNull();
    expect(deadlinePhraseFromText("storyboard Thursday")).toBeNull();
    expect(deadlinePhraseFromText("the bug we saw on monday")).toBeNull();
    expect(deadlinePhraseFromText("buy a sun hat")).toBeNull();
  });

  it("reads a named month and day behind a cue", () => {
    expect(deadlinePhraseFromText("send the deck by Oct 3")).toBe("oct 3");
    expect(deadlinePhraseFromText("due 3rd of October")).toBe("3rd of october");
    expect(deadlinePhraseFromText("deadline is october 3rd")).toBe("october 3rd");
    expect(deadlinePhraseFromText("notes from the meeting on oct 3")).toBeNull();
    expect(resolveSuggestedDeadline("october 3rd", ctx())).toBe("2026-10-03T15:00:00.000Z");
  });

  it("reads an ISO date, with or without a time", () => {
    expect(deadlinePhraseFromText("launch copy 2026-10-03")).toBe("2026-10-03");
    expect(deadlinePhraseFromText("launch copy 2026-10-03 14:30")).toBe("2026-10-03T14:30");
  });

  it("reads tonight, tomorrow and end of day", () => {
    expect(deadlinePhraseFromText("render it tonight")).toBe("tonight");
    expect(deadlinePhraseFromText("tmrw works")).toBe("tomorrow");
    expect(deadlinePhraseFromText("need this by EOD")).toBe("today");
  });

  it("does not read tonight's or tomorrow's THING as a deadline", () => {
    expect(deadlinePhraseFromText("clip tonight's stream highlights")).toBeNull();
    expect(deadlinePhraseFromText("slides for tomorrow's meeting")).toBeNull();
  });

  it("never reads the digits of a mention or a link as a count", () => {
    expect(deadlinePhraseFromText("<@123456789012345678> in <#234567890123456789>")).toBeNull();
    expect(deadlinePhraseFromText("see https://example.com/in/3/days")).toBeNull();
  });

  it("returns null when the message states no deadline", () => {
    expect(deadlinePhraseFromText("fix the login page")).toBeNull();
    expect(deadlinePhraseFromText("")).toBeNull();
  });
});

describe("pickDeadlinePhrase", () => {
  it("takes the model's answer when it resolves", () => {
    expect(pickDeadlinePhrase("tuesday", "deadline is 24 hours", ctx())).toBe("tuesday");
  });

  it("falls back to the message's own words when the model found nothing", () => {
    expect(pickDeadlinePhrase("", "deadline is 24 hours", ctx())).toBe("in 24 hours");
  });

  it("falls back when the model's answer does not parse", () => {
    expect(pickDeadlinePhrase("sometime soon", "by Friday", ctx())).toBe("friday");
  });

  it("hands the model's answer back unchanged when neither resolves", () => {
    expect(pickDeadlinePhrase("sometime soon", "no clock here", ctx())).toBe("sometime soon");
    expect(pickDeadlinePhrase("", "no clock here", ctx())).toBe("");
  });

  it("feeds decideAutoDeadline a live deadline for the 24-hour message", () => {
    const decision = decideAutoDeadline({
      suggested: pickDeadlinePhrase("", "deadline is 24 hours", ctx()),
      sentAt: SENT,
      timezone: JHB,
      now: NOW,
    });
    expect(decision).toEqual({
      write: true,
      deadline: "2026-09-08T09:00:00.000Z",
      source: "auto",
      alertEveryMinutes: DEFAULT_AUTO_CADENCE_MINUTES,
    });
  });
});

describe("zone helpers", () => {
  it("returns 1-based months and a 0–6 weekday", () => {
    const parts = zonedParts(new Date("2026-09-08T09:00:00.000Z"), JHB);
    expect(parts).toMatchObject({ year: 2026, month: 9, day: 8, hour: 11, minute: 0, weekday: 2 });
  });

  it("normalises a midnight rendered as hour 24 to 0", () => {
    expect(zonedParts(new Date("2026-09-08T22:00:00.000Z"), JHB).hour).toBe(0);
  });

  it("reports the offset positive east and negative west", () => {
    expect(offsetMs(new Date("2026-09-08T09:00:00.000Z"), JHB)).toBe(2 * 3_600_000);
    expect(offsetMs(new Date("2026-09-08T09:00:00.000Z"), NY)).toBe(-4 * 3_600_000);
    expect(offsetMs(new Date("2026-01-08T09:00:00.000Z"), NY)).toBe(-5 * 3_600_000);
  });

  it("round-trips a wall clock through fromZoned and back", () => {
    const instant = fromZoned({ year: 2026, month: 3, day: 10, hour: 17, minute: 30 }, NY);
    expect(instant.toISOString()).toBe("2026-03-10T21:30:00.000Z");
    expect(zonedParts(instant, NY)).toMatchObject({ month: 3, day: 10, hour: 17, minute: 30 });
  });

  it("validates zones and falls back rather than throwing", () => {
    expect(isValidTimeZone("Africa/Johannesburg")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(() => zonedParts(new Date(SENT), "Mars/Olympus")).not.toThrow();
    expect(zonedParts(new Date(SENT), "Mars/Olympus").hour).toBe(9); // UTC
  });

  it("detects a usable browser zone, or says UTC", () => {
    const detected = detectBrowserTimeZone();
    expect(typeof detected).toBe("string");
    expect(isValidTimeZone(detected)).toBe(true);
  });
});

describe("extendDeadline — \"give her 6 more hours\" (Lucky35, 2026-10-06)", () => {
  const now = new Date("2026-10-06T15:00:00.000Z");

  it("moves the deadline it has, not now", () => {
    // Rea's: due 17:55, six more hours.
    expect(extendDeadline("2026-10-06T17:55:00.000Z", 360, now)).toBe("2026-10-06T23:55:00.000Z");
  });

  it("an hour after a deadline already passed still lands after it — from the deadline when that is still ahead", () => {
    expect(extendDeadline("2026-10-06T14:00:00.000Z", 360, now)).toBe("2026-10-06T20:00:00.000Z");
  });

  it("never gives a deadline that is already missed: from now when the old one is too far gone", () => {
    expect(extendDeadline("2026-10-05T09:00:00.000Z", 60, now)).toBe("2026-10-06T16:00:00.000Z");
  });

  it("with no deadline, from now", () => {
    expect(extendDeadline(null, 24 * 60, now)).toBe("2026-10-07T15:00:00.000Z");
  });

  it("rounds to whole minutes, at least one, at most a year", () => {
    expect(extendDeadline(null, 0, now)).toBe("2026-10-06T15:01:00.000Z");
    expect(Date.parse(extendDeadline(null, 10_000_000, now)) - now.getTime()).toBe(366 * 24 * 3_600_000);
  });
});
