/**
 * Step 1 Continue shows validation errors instantly: the room-occupancy refresh
 * ("Checking rooms…") runs only after the step validates. The one labeled "Lease length"
 * list and its options are driven through the real step in
 * `apply-lease-term-options-from-listing.test.tsx`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const WIZARD = read("src/components/marketing/rental-application-wizard.tsx");

describe("step 1 Continue", () => {
  it("validates (and returns on errors) before the occupancy refresh", () => {
    const body = WIZARD.slice(WIZARD.indexOf("const validateStepNow = (): boolean =>"));
    const firstCall = body.indexOf("if (!validateStepNow()) return;");
    const refresh = body.indexOf("refreshPublicApprovedRoomOccupancyForContinue(form.propertyId)");
    expect(firstCall).toBeGreaterThan(-1);
    expect(refresh).toBeGreaterThan(-1);
    expect(firstCall).toBeLessThan(refresh);
    // The spinner flag is only ever set after that first early return.
    expect(body.indexOf("setAvailabilityChecking(true)")).toBeGreaterThan(firstCall);
  });

  it("validateStepNow still toasts and scrolls to the first error", () => {
    const fn = WIZARD.slice(WIZARD.indexOf("const validateStepNow = (): boolean =>")).split("if (!validateStepNow()) return;")[0];
    expect(fn).toContain("countValidationErrors(e) > 0");
    expect(fn).toContain("scrollToFirstWizardFieldError");
  });
});
