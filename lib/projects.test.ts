import { describe, expect, it } from "vitest";

import {
  CATEGORY_LIMIT,
  type ListedChannel,
  categoryNumber,
  chooseCategory,
  groupProjectChannels,
  projectStateOf,
} from "./projects";

const category = (id: string, name: string): ListedChannel => ({ id, name, type: 4 });
const text = (id: string, parent: string | null = null): ListedChannel => ({ id, name: `chan-${id}`, type: 0, parent_id: parent });

/** `count` text channels inside `parent`. */
function filled(parent: string, count: number): ListedChannel[] {
  return Array.from({ length: count }, (_, i) => text(`${parent}-${i}`, parent));
}

describe("categoryNumber", () => {
  it("reads the name and its overflow number, forgiving case and spacing", () => {
    expect(categoryNumber("Done projects", "done")).toBe(1);
    expect(categoryNumber("  DONE   projects ", "done")).toBe(1);
    expect(categoryNumber("Done projects 3", "done")).toBe(3);
    expect(categoryNumber("Done projects 1", "done")).toBeNull();
    expect(categoryNumber("Done projects old", "done")).toBeNull();
    expect(categoryNumber("Active projects", "done")).toBeNull();
    expect(categoryNumber(null, "active")).toBeNull();
  });
});

describe("chooseCategory", () => {
  it("creates the category the first time", () => {
    expect(chooseCategory([text("a")], "done", null)).toEqual({ create: "Done projects" });
  });

  it("uses the one already used, even renamed", () => {
    const listing = [category("c1", "Finished"), text("a")];
    expect(chooseCategory(listing, "done", "c1")).toEqual({ id: "c1", name: "Finished" });
  });

  it("finds one by its name when none is stored, or the stored one was deleted", () => {
    const listing = [category("c2", "done projects"), text("a")];
    expect(chooseCategory(listing, "done", "gone")).toEqual({ id: "c2", name: "done projects" });
  });

  it("overflows a full category into the next number, never failing the move", () => {
    const full = [category("c1", "Done projects"), ...filled("c1", CATEGORY_LIMIT)];
    expect(chooseCategory(full, "done", "c1")).toEqual({ create: "Done projects 2" });

    const second = [...full, category("c2", "Done projects 2"), ...filled("c2", 3)];
    expect(chooseCategory(second, "done", "c1")).toEqual({ id: "c2", name: "Done projects 2" });

    const both = [...full, category("c2", "Done projects 2"), ...filled("c2", CATEGORY_LIMIT)];
    expect(chooseCategory(both, "done", "c2")).toEqual({ create: "Done projects 3" });
  });

  it("never picks the other side's category", () => {
    const listing = [category("c1", "Active projects")];
    expect(chooseCategory(listing, "done", null)).toEqual({ create: "Done projects" });
    expect(chooseCategory(listing, "active", null)).toEqual({ id: "c1", name: "Active projects" });
  });
});

describe("where a channel stands", () => {
  const stored = { active_category_id: "act", done_category_id: "done" };

  it("reads the stored categories first, then the names — overflow included", () => {
    expect(projectStateOf({ parent_id: "done", parent_name: "Renamed" }, stored)).toBe("done");
    expect(projectStateOf({ parent_id: "act", parent_name: null }, stored)).toBe("active");
    expect(projectStateOf({ parent_id: "old", parent_name: "Done projects 2" }, stored)).toBe("done");
    expect(projectStateOf({ parent_id: "x", parent_name: "General" }, stored)).toBeNull();
    expect(projectStateOf({ parent_id: null, parent_name: null }, null)).toBeNull();
  });

  it("groups a server's channels, each list by name", () => {
    const channel = (name: string, parent_id: string | null, parent_name: string | null) => ({
      channel_name: name,
      parent_id,
      parent_name,
    });
    const groups = groupProjectChannels(
      [
        channel("zeta", "act", "Active projects"),
        channel("alpha", "act", "Active projects"),
        channel("old", "done", "Done projects"),
        channel("general", null, null),
      ],
      stored,
    );
    expect(groups.active.map((c) => c.channel_name)).toEqual(["alpha", "zeta"]);
    expect(groups.done.map((c) => c.channel_name)).toEqual(["old"]);
    expect(groups.other.map((c) => c.channel_name)).toEqual(["general"]);
  });
});
