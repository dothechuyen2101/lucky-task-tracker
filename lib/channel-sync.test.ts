import { describe, expect, it } from "vitest";

import { CHANNEL_SYNC_EVERY_MS, MAX_LOOK_BACK_MS, lastLook, planChannelSync, seedCursor, syncDue } from "./channel-sync";
import { dateToSnowflake, snowflakeToDate } from "./snowflake";

const NOW = new Date("2026-10-06T13:40:00.000Z");
const USER = "user-1";

/** A channel id that was created at `iso`. */
const createdAt = (iso: string) => dateToSnowflake(new Date(iso));

describe("syncDue", () => {
  it("lists channels every few minutes, and at once when it never has", () => {
    expect(syncDue(null, NOW)).toBe(true);
    expect(syncDue(new Date(NOW.getTime() - CHANNEL_SYNC_EVERY_MS + 1000).toISOString(), NOW)).toBe(false);
    expect(syncDue(new Date(NOW.getTime() - CHANNEL_SYNC_EVERY_MS).toISOString(), NOW)).toBe(true);
  });
});

describe("where a newly found channel starts being read", () => {
  const look = "2026-10-04T06:16:44.000Z"; // the last Refresh

  it("a channel made since the last look is read from its creation — the tags made before it was found are not lost", () => {
    // #cenri-john, made after the last Refresh (2026-10-06).
    const id = createdAt("2026-10-04T17:17:35.000Z");
    expect(seedCursor(id, look, NOW)).toBe(id);
  });

  it("a channel that existed before is read from the last look, never from its whole history", () => {
    const old = createdAt("2025-01-01T00:00:00.000Z");
    expect(snowflakeToDate(seedCursor(old, look, NOW)).toISOString()).toBe(look);
  });

  it("with no previous look at all, from now — like switching a channel on", () => {
    expect(snowflakeToDate(seedCursor(createdAt("2026-10-01T00:00:00.000Z"), null, NOW)).toISOString()).toBe(NOW.toISOString());
  });

  it("the look is the last full sync, else the newest channel row — never further back than the cap", () => {
    expect(lastLook("2026-10-06T13:35:00.000Z", "2026-10-04T06:16:44.000Z", NOW)).toBe("2026-10-06T13:35:00.000Z");
    expect(lastLook(null, look, NOW)).toBe(look);
    expect(lastLook(null, null, NOW)).toBeNull();
    expect(lastLook(null, "2026-01-01T00:00:00.000Z", NOW)).toBe(new Date(NOW.getTime() - MAX_LOOK_BACK_MS).toISOString());
  });
});

describe("planChannelSync", () => {
  const look = "2026-10-04T06:16:44.000Z";
  const task = { id: "g-task", name: "Task" };
  const rocky = { id: "g-rocky", name: "ROCKY ROUND 14" };
  const cenri = createdAt("2026-10-04T17:17:35.000Z");

  it("adds every readable channel never seen before, watched, with its cursor — a whole new server included", () => {
    const plan = planChannelSync(
      USER,
      [
        {
          guild: task,
          channels: [
            { id: "cat-1", name: "People", type: 4 },
            { id: cenri, name: "cenri-john", type: 0, parent_id: "cat-1" },
            { id: "v-1", name: "Voice", type: 2 },
            { id: "f-1", name: "guides", type: 15 },
          ],
        },
      ],
      [],
      look,
      NOW,
    );
    expect(plan.added).toEqual([
      {
        user_id: USER,
        guild_id: "g-task",
        guild_name: "Task",
        channel_id: cenri,
        channel_name: "cenri-john",
        parent_id: "cat-1",
        parent_name: "People",
        watching: true,
        last_message_id: cenri,
      },
    ]);
    expect(plan.newServers).toEqual(["g-task"]);
    expect(plan.renamed).toEqual([]);
  });

  it("leaves a known channel's switch, cursor and history alone — only its labels follow Discord", () => {
    const known = [
      { channel_id: "c-1", channel_name: "general", guild_name: "ROCKY ROUND 14", parent_id: null, parent_name: null },
      { channel_id: "c-2", channel_name: "old-name", guild_name: "ROCKY ROUND 14", parent_id: null, parent_name: null },
    ];
    const plan = planChannelSync(
      USER,
      [
        {
          guild: rocky,
          channels: [
            { id: "c-1", name: "general", type: 0 },
            { id: "c-2", name: "new-name", type: 0 },
          ],
        },
      ],
      known,
      look,
      NOW,
    );
    expect(plan.added).toEqual([]);
    expect(plan.newServers).toEqual([]);
    expect(plan.renamed).toHaveLength(1);
    expect(plan.renamed[0]).toMatchObject({ channel_id: "c-2", channel_name: "new-name" });
    expect(plan.renamed[0]).not.toHaveProperty("watching");
    expect(plan.renamed[0]).not.toHaveProperty("last_message_id");
  });

  it("a server with nothing readable is not a new server to learn a role in", () => {
    const plan = planChannelSync(USER, [{ guild: task, channels: [{ id: "v-1", name: "Voice", type: 2 }] }], [], look, NOW);
    expect(plan.newServers).toEqual([]);
    expect(plan.added).toEqual([]);
  });
});
