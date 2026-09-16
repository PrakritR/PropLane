import { describe, expect, it } from "vitest";
import { formatOpenRunKindsLabel, mergeOpenRuns } from "@/lib/calendar-open-runs";

describe("calendar-open-runs", () => {
  it("merges one contiguous kind set into a single run", () => {
    expect(mergeOpenRuns({ tours: [18, 19, 20] })).toEqual([{ startSlot: 18, endSlotExclusive: 21, kinds: ["tours"] }]);
  });

  it("splits a gap in an otherwise identical kind set into two runs", () => {
    expect(mergeOpenRuns({ tours: [18, 19, 22, 23] })).toEqual([
      { startSlot: 18, endSlotExclusive: 20, kinds: ["tours"] },
      { startSlot: 22, endSlotExclusive: 24, kinds: ["tours"] },
    ]);
  });

  it("splits three runs where two kinds partially overlap: tours-only, both, services-only", () => {
    const runs = mergeOpenRuns({
      tours: [18, 19, 20],
      services: [19, 20, 21],
    });
    expect(runs).toEqual([
      { startSlot: 18, endSlotExclusive: 19, kinds: ["tours"] },
      { startSlot: 19, endSlotExclusive: 21, kinds: ["tours", "services"] },
      { startSlot: 21, endSlotExclusive: 22, kinds: ["services"] },
    ]);
  });

  it("orders kinds within a run as AVAILABILITY_KINDS does, regardless of input order", () => {
    const runs = mergeOpenRuns({ services: [10], tasks: [10], tours: [10] });
    expect(runs).toEqual([{ startSlot: 10, endSlotExclusive: 11, kinds: ["tours", "services", "tasks"] }]);
  });

  it("ignores non-finite and out-of-range slot indices", () => {
    expect(mergeOpenRuns({ tours: [-1, 48, Number.NaN, Number.POSITIVE_INFINITY, 5] })).toEqual([
      { startSlot: 5, endSlotExclusive: 6, kinds: ["tours"] },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(mergeOpenRuns({})).toEqual([]);
    expect(mergeOpenRuns({ tours: [] })).toEqual([]);
  });

  it("labels a block by its category, not the bare word Open (PLAN-0916-0041)", () => {
    // "Open" read as "not configured" to managers; a block now names its kinds.
    expect(formatOpenRunKindsLabel(["tours"])).toBe("Tours");
    expect(formatOpenRunKindsLabel(["services"])).toBe("Services");
    expect(formatOpenRunKindsLabel(["tours", "services"])).toBe("Tours · Services");
    expect(formatOpenRunKindsLabel(["tours", "services", "tasks"])).toBe("Tours · Services · Tasks");
  });

  it("falls back to Open only when a run somehow has no kinds", () => {
    expect(formatOpenRunKindsLabel([])).toBe("Open");
  });
});
