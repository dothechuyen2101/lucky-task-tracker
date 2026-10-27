import { describe, expect, it } from "vitest";

import { BOT_PERMISSIONS, botInviteUrl, serverListState } from "./discord-links";

const NOW = new Date("2026-10-16T07:39:00.000Z");

describe("the server list on Settings", () => {
  it("says when it was listed — the newest row", () => {
    const state = serverListState(
      { linked: true, tokenExpires: "2026-10-20T00:00:00.000Z", refreshedAt: ["2026-10-05T07:04:00.000Z", "2026-10-05T07:04:30.000Z", "nonsense"] },
      NOW,
    );
    expect(state).toEqual({ asOf: "2026-10-05T07:04:30.000Z", signIn: "ok", expiredAt: null });
  });

  it("says the sign-in ran out — Luka's, 2026-10-16: expired on the 8th, list from the 5th", () => {
    const state = serverListState(
      { linked: true, tokenExpires: "2026-10-08T13:45:00.000Z", refreshedAt: ["2026-10-05T07:04:00.000Z"] },
      NOW,
    );
    expect(state).toEqual({ asOf: "2026-10-05T07:04:00.000Z", signIn: "expired", expiredAt: "2026-10-08T13:45:00.000Z" });
  });

  it("says when the sign-in never gave server access, and when nothing was ever listed", () => {
    expect(serverListState({ linked: false, tokenExpires: null, refreshedAt: [] }, NOW)).toEqual({ asOf: null, signIn: "missing", expiredAt: null });
    // An unknown expiry is not read as expired: the refresh itself will say.
    expect(serverListState({ linked: true, tokenExpires: null, refreshedAt: [] }, NOW).signIn).toBe("ok");
  });
});

describe("the bot's invite link", () => {
  it("asks for the tracker's own permissions, and can lock the server", () => {
    const url = new URL(botInviteUrl("1556177760500711504", "1558354132962902077"));
    expect(url.searchParams.get("client_id")).toBe("1556177760500711504");
    expect(url.searchParams.get("permissions")).toBe(BOT_PERMISSIONS);
    expect(url.searchParams.get("guild_id")).toBe("1558354132962902077");
    expect(url.searchParams.get("disable_guild_select")).toBe("true");
  });
});
