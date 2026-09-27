// C245 (U027) — the four lease pipeline tabs (Manager review · Resident
// signature · Manager signature · Signed) read as a pipeline but gave no
// sense of total progress relative to the whole pipeline. Pins the pure
// summary the tabs' own counts are turned into.
import { describe, expect, it } from "vitest";
import { computeLeasePipelineProgress } from "@/lib/lease-pipeline-storage";

describe("computeLeasePipelineProgress", () => {
  it("returns null when the pipeline is empty — nothing to summarize", () => {
    expect(
      computeLeasePipelineProgress({ manager: 0, resident: 0, signed: 0, completed: 0 }),
    ).toBeNull();
  });

  it("sums every stage into a total and reports the signed count", () => {
    const progress = computeLeasePipelineProgress({ manager: 3, resident: 2, signed: 1, completed: 6 });
    expect(progress?.total).toBe(12);
    expect(progress?.signed).toBe(6);
  });

  it("gives each stage its share of the whole pipeline, in the default stage order", () => {
    const progress = computeLeasePipelineProgress({ manager: 1, resident: 1, signed: 1, completed: 1 });
    expect(progress?.segments.map((s) => s.id)).toEqual(["manager", "resident", "signed", "completed"]);
    for (const segment of progress!.segments) {
      expect(segment.count).toBe(1);
      expect(segment.pct).toBeCloseTo(25);
    }
  });

  it("gives a stage with zero leases a zero-width segment rather than dropping it", () => {
    const progress = computeLeasePipelineProgress({ manager: 4, resident: 0, signed: 0, completed: 0 });
    const resident = progress?.segments.find((s) => s.id === "resident");
    expect(resident?.count).toBe(0);
    expect(resident?.pct).toBe(0);
    const manager = progress?.segments.find((s) => s.id === "manager");
    expect(manager?.pct).toBe(100);
  });
});
