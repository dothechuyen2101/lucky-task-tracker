/**
 * Discord URLs the UI builds. Pure and client-safe — no token ever touches
 * this file.
 */

/**
 * The invite link for a user's own bot.
 *
 * Permissions integer 68672 = View Channels (1024) + Send Messages (2048) +
 * Add Reactions (64) + Read Message History (65536). The bot reads messages,
 * answers every tag with ✅ or 👀 so the sender knows it was read (Lucky35,
 * 2026-09-29), and replies to commands and questions in the channel. DMs need no
 * guild permission at all. Nothing in this scope lets it manage a server,
 * delete anything, or mention @everyone — which matters, because the person
 * pasting this link into their company's Discord is trusting it.
 */
export const BOT_PERMISSIONS = "68672";

/**
 * `BOT_PERMISSIONS` + Manage Channels (16) = 68688 — asked for ONLY by the
 * invite on Settings' "Project channels", for someone who wants the tracker to
 * move finished project channels into a "Done projects" category (Lucky35,
 * 2026-10-04). Manage Channels can also delete channels, so it is never part
 * of the ordinary invite: a server that does not use the feature never grants
 * it. The tracker itself only creates the two categories and moves channels
 * between them.
 */
export const PROJECT_BOT_PERMISSIONS = "68688";

export function botInviteUrl(applicationId: string, guildId?: string, { manageChannels = false } = {}): string {
  const params = new URLSearchParams({
    client_id: applicationId,
    permissions: manageChannels ? PROJECT_BOT_PERMISSIONS : BOT_PERMISSIONS,
    scope: "bot",
  });

  // Pre-select the server and lock the picker, so "invite it here" means here
  // and the user cannot land the bot in the wrong place by mis-clicking a
  // dropdown they did not expect.
  if (guildId) {
    params.set("guild_id", guildId);
    params.set("disable_guild_select", "true");
  }

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/** Discord's CDN icon for a server, or null when it has none set. */
export function guildIconUrl(guildId: string, icon: string | null): string | null {
  return icon ? `https://cdn.discordapp.com/icons/${guildId}/${icon}.png?size=64` : null;
}

export const DEVELOPER_PORTAL_URL = "https://discord.com/developers/applications";

/** Straight to the "create an application" dialog, not the list. */
export const NEW_APPLICATION_URL = "https://discord.com/developers/applications?new_application=true";

/**
 * A bot's user id and its application id are the same snowflake, so once a
 * token is connected we can deep-link the user into their own app's pages
 * rather than telling them to go and find it.
 */
export function botTabUrl(applicationId: string): string {
  return `https://discord.com/developers/applications/${applicationId}/bot`;
}

export function oauthTabUrl(applicationId: string): string {
  return `https://discord.com/developers/applications/${applicationId}/oauth2`;
}

/**
 * Opens the bot's profile, where "Message" starts a DM with it. The bot must
 * share a server with you for Discord to offer that.
 */
export function botProfileUrl(botUserId: string): string {
  return `https://discord.com/users/${botUserId}`;
}

/**
 * True for a link to a message in a DM (`/channels/@me/…`). Only the two
 * people in that DM can open it — so the assignee of a task given by DM to
 * the giver's bot is never shown it as "Open in Discord".
 */
export function isDmLink(url: string | null | undefined): boolean {
  return typeof url === "string" && url.includes("/channels/@me/");
}

/**
 * Whether Settings' "Your servers" list can still be trusted. It is read with
 * the person's OWN Discord sign-in token, which Supabase hands over once, at
 * sign-in, and which Discord expires after about a week. After that the list
 * cannot refresh, and it used to go on showing the last one it had as if it
 * were current — so a server Luka was made owner of on 2026-10-16 was
 * "nowhere to be found", with nothing on the page saying why.
 *
 * `asOf`: when the newest row was listed (null: never). `signIn`: "ok", or
 * "expired" (the token ran out at `expiredAt`), or "missing" (the sign-in
 * never included server access). Pure: `now` is passed in.
 */
export type ServerListState = {
  asOf: string | null;
  signIn: "ok" | "expired" | "missing";
  expiredAt: string | null;
};

export function serverListState(
  input: { linked: boolean; tokenExpires: string | null; refreshedAt: readonly string[] },
  now: Date,
): ServerListState {
  let asOf: string | null = null;
  for (const at of input.refreshedAt) {
    if (Number.isFinite(Date.parse(at)) && (asOf === null || Date.parse(at) > Date.parse(asOf))) asOf = at;
  }
  if (!input.linked) return { asOf, signIn: "missing", expiredAt: null };
  const expires = input.tokenExpires ? Date.parse(input.tokenExpires) : NaN;
  if (Number.isFinite(expires) && expires <= now.getTime()) return { asOf, signIn: "expired", expiredAt: input.tokenExpires };
  return { asOf, signIn: "ok", expiredAt: null };
}
