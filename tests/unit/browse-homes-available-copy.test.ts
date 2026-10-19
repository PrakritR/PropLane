import { describe, expect, it } from "vitest";

/** Mirrors the header count in resident-housing-browse.tsx: a plain figure, blank while loading. */
function homesCountLabel(count: number, loading = false): string {
  if (loading) return "";
  return `${count} home${count === 1 ? "" : "s"}`;
}

describe("browse homes count (header figure)", () => {
  it("singularises a single match", () => {
    expect(homesCountLabel(1)).toBe("1 home");
  });

  it("pluralises multiple matches", () => {
    expect(homesCountLabel(4)).toBe("4 homes");
    expect(homesCountLabel(0)).toBe("0 homes");
  });

  it("shows nothing while loading", () => {
    expect(homesCountLabel(1, true)).toBe("");
  });
});
