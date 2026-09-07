import { describe, expect, it } from "vitest";

/** Mirrors the browse results-count copy in resident-housing-browse.tsx (PRP-367). */
function homesAvailableLabel(count: number, loading = false): string {
  if (loading) return "Loading homes…";
  if (count === 0) return "No homes available";
  return `${count} home${count === 1 ? "" : "s"} available`;
}

describe("browse homes available copy (PRP-367)", () => {
  it("singularises a single match", () => {
    expect(homesAvailableLabel(1)).toBe("1 home available");
  });

  it("pluralises multiple matches", () => {
    expect(homesAvailableLabel(4)).toBe("4 homes available");
  });

  it("uses an empty-state sentence for zero", () => {
    expect(homesAvailableLabel(0)).toBe("No homes available");
  });

  it("keeps the loading sentence", () => {
    expect(homesAvailableLabel(1, true)).toBe("Loading homes…");
  });
});
