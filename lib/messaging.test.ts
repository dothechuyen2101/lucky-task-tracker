import { describe, expect, it } from "vitest";

import {
  DISCORD_MESSAGE_LIMIT,
  MESSAGE_ALERT_KIND,
  isSnowflake,
  pickAllowedRecipient,
  rateLimitWait,
  validateMessageContent,
} from "./messaging";

/**
 * Two real-shaped snowflakes (18 digits, the common Discord length) and one id
 * that is on the board but is NOT snowflake-shaped — the kind of value a
 * half-repaired row can carry.
 */
const LUKA = "222222222222222222";
const SAM = "333333333333333333";
const STRANGER = "444444444444444444";
const NOT_A_SNOWFLAKE = "luka";

const TRACKED = [LUKA, SAM, NOT_A_SNOWFLAKE] as const;

describe("pickAllowedRecipient", () => {
  it("returns null for an arbitrary snowflake that is not on the board", () => {
    expect(pickAllowedRecipient(TRACKED, STRANGER)).toBeNull();
  });

  it("returns the id for a snowflake that is on the board", () => {
    expect(pickAllowedRecipient(TRACKED, LUKA)).toBe(LUKA);
    expect(pickAllowedRecipient(TRACKED, SAM)).toBe(SAM);
  });

  it("returns null for a tracked value that is not snowflake-shaped", () => {
    expect(pickAllowedRecipient(TRACKED, NOT_A_SNOWFLAKE)).toBeNull();
  });

  it("returns null, without throwing, for a non-string requestedId", () => {
    expect(() => pickAllowedRecipient(TRACKED, null)).not.toThrow();
    expect(pickAllowedRecipient(TRACKED, null)).toBeNull();
    expect(pickAllowedRecipient(TRACKED, undefined)).toBeNull();
    expect(pickAllowedRecipient(TRACKED, 123)).toBeNull();
    expect(pickAllowedRecipient(TRACKED, {})).toBeNull();
    expect(pickAllowedRecipient(TRACKED, [LUKA])).toBeNull();
  });

  it("returns null when the board is empty, whatever is asked for", () => {
    expect(pickAllowedRecipient([], LUKA)).toBeNull();
  });

  it("matches the id exactly — no prefix, suffix or whitespace slack", () => {
    expect(pickAllowedRecipient(TRACKED, ` ${LUKA}`)).toBeNull();
    expect(pickAllowedRecipient(TRACKED, `${LUKA}0`)).toBeNull();
    expect(pickAllowedRecipient(TRACKED, LUKA.slice(0, 17))).toBeNull();
  });
});

describe("isSnowflake", () => {
  it("accepts digits-only ids of 17 to 20 characters", () => {
    expect(isSnowflake("1".repeat(17))).toBe(true);
    expect(isSnowflake("1".repeat(20))).toBe(true);
  });

  it("rejects the wrong length, non-digits and non-strings", () => {
    expect(isSnowflake("1".repeat(16))).toBe(false);
    expect(isSnowflake("1".repeat(21))).toBe(false);
    expect(isSnowflake("12345678901234567a")).toBe(false);
    expect(isSnowflake("")).toBe(false);
    expect(isSnowflake(222222222222222222)).toBe(false);
    expect(isSnowflake(null)).toBe(false);
  });
});

describe("validateMessageContent", () => {
  it("rejects empty and whitespace-only content", () => {
    expect(validateMessageContent("")).toEqual({
      ok: false,
      error: "Type a message first.",
    });
    expect(validateMessageContent("   \n\t  ")).toEqual({
      ok: false,
      error: "Type a message first.",
    });
  });

  it("rejects a non-string body with the same copy", () => {
    expect(validateMessageContent(undefined)).toEqual({
      ok: false,
      error: "Type a message first.",
    });
    expect(validateMessageContent(null)).toEqual({
      ok: false,
      error: "Type a message first.",
    });
    expect(validateMessageContent(42)).toEqual({
      ok: false,
      error: "Type a message first.",
    });
  });

  it("accepts ordinary text and returns it trimmed", () => {
    expect(validateMessageContent("  ping me when the deck is up  ")).toEqual({
      ok: true,
      content: "ping me when the deck is up",
    });
  });

  it("accepts content of exactly DISCORD_MESSAGE_LIMIT characters", () => {
    const atCap = "a".repeat(DISCORD_MESSAGE_LIMIT);
    expect(validateMessageContent(atCap)).toEqual({ ok: true, content: atCap });
  });

  it("rejects content of DISCORD_MESSAGE_LIMIT + 1 characters", () => {
    expect(validateMessageContent("a".repeat(DISCORD_MESSAGE_LIMIT + 1))).toEqual({
      ok: false,
      error: "Discord messages cap at 2000 characters.",
    });
  });
});

describe("MESSAGE_ALERT_KIND", () => {
  it("is not the tt_alerts column default, so the log stays honest", () => {
    expect(MESSAGE_ALERT_KIND).not.toBe("deadline");
    expect(MESSAGE_ALERT_KIND).toBe("message");
  });
});

/**
 * The 429 wait the compose box shows. It is tested here and nowhere else,
 * because `vitest.config.mts:20` collects only `lib/**\/*.test.ts` — a
 * formatter written inside `components/message-person.tsx` would have no test
 * at all, which is exactly why it does not live there.
 */
describe("rateLimitWait", () => {
  it("returns null when the payload carries no delay", () => {
    expect(rateLimitWait({ error: "Connect a Discord bot first." })).toBeNull();
    expect(rateLimitWait({})).toBeNull();
  });

  it("returns null, without throwing, for a payload that is not an object", () => {
    expect(() => rateLimitWait(null)).not.toThrow();
    expect(rateLimitWait(null)).toBeNull();
    expect(rateLimitWait(undefined)).toBeNull();
    expect(rateLimitWait("2000")).toBeNull();
  });

  it("ignores a delay that is not a usable positive number", () => {
    expect(rateLimitWait({ retryAfterMs: "5000" })).toBeNull();
    expect(rateLimitWait({ retryAfterMs: 0 })).toBeNull();
    expect(rateLimitWait({ retryAfterMs: -1 })).toBeNull();
    expect(rateLimitWait({ retryAfterMs: Number.NaN })).toBeNull();
  });

  it("rounds a sub-second delay up to about a second, never to zero", () => {
    expect(rateLimitWait({ retryAfterMs: 120 })).toBe("Discord asked for about a second.");
  });

  it("rounds a delay up to whole seconds", () => {
    expect(rateLimitWait({ retryAfterMs: 4200 })).toBe("Discord asked for about 5 seconds.");
  });

  it("says a long delay in minutes rather than in hundreds of seconds", () => {
    expect(rateLimitWait({ retryAfterMs: 600_000 })).toBe("Discord asked for about 10 minutes.");
  });
});
