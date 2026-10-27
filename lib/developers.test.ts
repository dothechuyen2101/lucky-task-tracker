import { describe, expect, it } from "vitest";

import { devListsFor, hiddenDevelopers, nextSortOrder, shownDevelopers, sortDevelopers, statusCounts, statusLabel } from "./developers";
import { displayNameOf } from "./members";
import type { DevEditor, Developer } from "./types/database";

const LUKA = "user-luka";
const OTHER = "user-other";
const NAUKHAIZ = "user-naukhaiz";

let seq = 0;
function dev(overrides: Partial<Developer> = {}): Developer {
  seq += 1;
  return {
    id: `dev-${seq}`,
    owner_id: LUKA,
    name: `Dev ${seq}`,
    discord_user_id: null,
    working_on: "",
    status: "idle",
    sort_order: seq,
    created_at: "2026-10-05T09:00:00.000Z",
    updated_at: "2026-10-05T09:00:00.000Z",
    updated_by_name: null,
    ...overrides,
  };
}

function editor(overrides: Partial<DevEditor> = {}): DevEditor {
  seq += 1;
  return {
    id: `editor-${seq}`,
    owner_id: LUKA,
    discord_user_id: "999999999999999999",
    name: "Naukhaiz",
    owner_name: "Lucky35",
    created_at: "2026-10-05T09:00:00.000Z",
    ...overrides,
  };
}

describe("devListsFor", () => {
  it("shows the owner their own list, with who keeps it", () => {
    const rows = [dev({ name: "Minh" }), dev({ name: "Bao" })];
    const keeps = editor();
    const [own] = devListsFor(LUKA, rows, [keeps], { ownListAnyway: false });
    expect(own).toMatchObject({ ownerId: LUKA, title: "Your developers", mine: true, editors: [keeps] });
    expect(own.developers.map((d) => d.name)).toEqual(["Minh", "Bao"]);
  });

  it("shows an empty list of their own only to someone who hands out work", () => {
    expect(devListsFor(LUKA, [], [], { ownListAnyway: true })).toHaveLength(1);
    expect(devListsFor(NAUKHAIZ, [], [], { ownListAnyway: false })).toEqual([]);
  });

  it("shows the person named to keep a list that list, by whose it is — and not its editors", () => {
    const rows = [dev({ name: "Minh" }), dev({ owner_id: OTHER, name: "Someone else's" })];
    const lists = devListsFor(NAUKHAIZ, rows, [editor()], { ownListAnyway: false });
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ ownerId: LUKA, title: "Lucky35's developers", mine: false, editors: [] });
    expect(lists[0].developers.map((d) => d.name)).toEqual(["Minh"]);
  });
});

describe("the list's order and counts", () => {
  it("runs in the order set, then by name", () => {
    const rows = [dev({ name: "C", sort_order: 1 }), dev({ name: "B", sort_order: 0 }), dev({ name: "A", sort_order: 1 })];
    expect(sortDevelopers(rows).map((d) => d.name)).toEqual(["B", "A", "C"]);
    expect(nextSortOrder(rows)).toBe(2);
    expect(nextSortOrder([])).toBe(0);
  });

  it("counts each state", () => {
    const counts = statusCounts([dev({ status: "working" }), dev({ status: "working" }), dev({ status: "blocked" })]);
    expect(counts).toEqual({ working: 2, blocked: 1, review: 0, idle: 0, off: 0 });
    expect(statusLabel("review")).toBe("In review");
  });
});

describe("hidden developers (2026-10-12)", () => {
  it("a hidden row is off the list, and listed apart so it can be shown again", () => {
    const rows = [dev({ name: "Umer" }), dev({ name: "Automated", hidden_at: "2026-10-12T09:00:00.000Z" })];
    expect(shownDevelopers(rows).map((r) => r.name)).toEqual(["Umer"]);
    expect(hiddenDevelopers(rows).map((r) => r.name)).toEqual(["Automated"]);
  });
});

describe("displayNameOf", () => {
  it("is the name a person goes by, not their handle", () => {
    expect(displayNameOf("Rea (@rea031999)")).toBe("Rea");
    expect(displayNameOf("@tomsmith4754")).toBe("tomsmith4754");
    expect(displayNameOf("Cenri")).toBe("Cenri");
  });
});
