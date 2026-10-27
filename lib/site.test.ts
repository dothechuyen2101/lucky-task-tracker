import { describe, expect, it } from "vitest";

import { safeNextPath } from "./site";

describe("safeNextPath — where sign-in may send you afterwards", () => {
  it("keeps a path inside the app, query included", () => {
    expect(safeNextPath("/?task=abc")).toBe("/?task=abc");
    expect(safeNextPath("/settings")).toBe("/settings");
  });

  it("sends anything that leaves the app back to the board", () => {
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("https://evil.example")).toBe("/");
    expect(safeNextPath("javascript:alert(1)")).toBe("/");
    expect(safeNextPath("/ok\nLocation: x")).toBe("/");
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath("")).toBe("/");
  });
});
