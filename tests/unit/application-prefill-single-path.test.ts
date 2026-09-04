import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const WIZARD = "src/components/marketing/rental-application-wizard.tsx";

/**
 * PRP-180: two lanes closed PRP-120 independently, leaving the apply wizard
 * with TWO prefill implementations and two field lists. Consolidated onto the
 * opt-in, email-scoped one.
 *
 * The deleted path was not merely redundant, it was unsafe: it snapshotted the
 * applicant's personal info into ONE GLOBAL localStorage key
 * ("axis:rental-application:profile-prefill:v1") with no per-account scoping,
 * and merged it automatically on open. On a shared device — a leasing office
 * kiosk, a family laptop — the next applicant's blank wizard would silently
 * fill with the previous person's legal name, date of birth, driver's licence,
 * address, employer, income, and references. No button press required.
 *
 * The surviving path reads applications belonging to THIS email (server route,
 * with the local rows filtered by email as a fallback) and only ever fills when
 * the applicant taps the step-2 button.
 */
describe("PRP-180: exactly one application-prefill path", () => {
  it("has no second prefill module", () => {
    expect(existsSync(join(process.cwd(), "src/lib/rental-application/application-profile-prefill.ts"))).toBe(false);
  });

  it("wires only the opt-in autofill into the wizard", () => {
    const wizard = read(WIZARD);
    expect(wizard).toContain("@/lib/rental-application/resident-application-autofill");
    expect(wizard).not.toContain("application-profile-prefill");
    // Prefill happens on an explicit tap, never in the state initializer.
    expect(wizard).toContain("handleApplySavedAutofill");
  });

  it("keeps no unscoped browser snapshot of applicant PII", () => {
    const wizard = read(WIZARD);
    expect(wizard).not.toContain("profile-prefill:v1");
    // The surviving reader is email-scoped by name and by signature.
    const autofill = read("src/lib/rental-application/resident-application-autofill.ts");
    expect(autofill).toContain("latestAutofillProfileFromLocalRows(email: string)");
  });

  it("keeps one field list, so a new application question cannot be added to only half of it", () => {
    const autofill = read("src/lib/rental-application/resident-application-autofill.ts");
    const lists = autofill.match(/export const \w*AUTOFILL_KEYS/g) ?? [];
    expect(lists).toHaveLength(1);
  });
});
