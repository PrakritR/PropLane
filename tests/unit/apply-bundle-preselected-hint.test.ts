/**
 * AXI-166 — "it was automatically on (whole house lease)-8000. It should give me
 * the option of which one I want to pick or have it for none."
 *
 * Nothing in the client auto-selects a bundle; it arrives pre-filled from an
 * "Apply for this bundle" link (`?bundle=`), which is intended. The way out of a
 * pre-filled field is the field's own "None" option, which names what applying
 * without the bundle means. It is NOT a muted sentence under the control —
 * AGENTS.md § "Never generate subtext" forbids that anywhere in the product, so
 * the helper paragraph that used to sit there is gone and must not grow back.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const steps = readFileSync(
  path.join(process.cwd(), "src/components/marketing/rental-wizard-steps.tsx"),
  "utf8",
);

const bundleField = () => steps.split('data-wizard-field="bundleId"')[1]?.slice(0, 2600) ?? "";

describe("lease bundle field", () => {
  it("keeps a None option that opts out of the bundle", () => {
    const select = bundleField();
    expect(select).toContain('<option value="">');
    expect(select).toContain("apply for individual rooms");
  });

  it("names the way out on the None option itself, for a by-room and a standard lease", () => {
    const select = bundleField();
    expect(select).toContain("standard lease");
    expect(select).toContain("standard short-term stay");
  });

  it("carries no subtext paragraph under the label", () => {
    const field = bundleField();
    const beforeSelect = field.split("<Select")[0] ?? "";
    expect(beforeSelect).toContain("<Label");
    expect(beforeSelect).not.toMatch(/<p[\s>]/);
  });

  it("never auto-selects a bundle on a property or lease-term change", () => {
    // Both handlers clear it; only an explicit link param or a click sets one.
    expect(steps).toContain('bundleId: ""');
    expect(steps).toContain("keepBundle");
  });
});
