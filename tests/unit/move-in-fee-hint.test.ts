import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MOVE_IN_FEE_HINT } from "@/components/portal/pro-add-listing-form";

/**
 * PRP-320: landlords did not know what to put in "Move-in fee", so every
 * Move-in fee label in the add-property wizard carries one shared explainer.
 * The three instances (short-term, per-room, per-bundle) must all use it —
 * a fourth copy of the field added without the hint is the regression.
 */
describe("Move-in fee explainer (PRP-320)", () => {
  const source = readFileSync("src/components/portal/pro-add-listing-form.tsx", "utf8");

  it("says what the fee is for and that it is optional", () => {
    expect(MOVE_IN_FEE_HINT).toMatch(/one-time/i);
    expect(MOVE_IN_FEE_HINT).toMatch(/leave blank/i);
    expect(MOVE_IN_FEE_HINT.length).toBeLessThan(120);
  });

  it("is on every Move-in fee label, with none left bare", () => {
    const labels = source.match(/<FieldLabel[^>]*>Move-in fee<\/FieldLabel>/g) ?? [];
    expect(labels.length).toBeGreaterThanOrEqual(3);
    for (const label of labels) {
      expect(label).toContain("hint={MOVE_IN_FEE_HINT}");
    }
  });
});
