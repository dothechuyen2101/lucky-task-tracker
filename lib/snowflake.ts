/**
 * Discord snowflake arithmetic. Pure, no fetch, no secrets — split out of
 * `lib/discord.ts` so the settings page can seed a channel's poll cursor in the
 * browser without pulling the REST client (and its bot-token-shaped API) into
 * the client bundle.
 */

/** Discord's epoch, 2015-01-01T00:00:00Z. Snowflakes count milliseconds from here. */
const DISCORD_EPOCH = 1420070400000n;

export function snowflakeToDate(id: string): Date {
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
}

/**
 * A snowflake that sorts as if it were created at `date`. Used to seed a
 * channel's cursor at the moment it is switched on, so tracking starts from
 * "now" rather than back-filling the channel's entire history.
 */
export function dateToSnowflake(date: Date): string {
  return String((BigInt(date.getTime()) - DISCORD_EPOCH) << 22n);
}

export function jumpUrl(guildId: string | null, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId ?? "@me"}/${channelId}/${messageId}`;
}
