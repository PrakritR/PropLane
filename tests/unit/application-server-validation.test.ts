import { describe, expect, it, vi } from "vitest";

import type { DemoApplicantRow } from "@/data/demo-portal";

/**
 * `POST /api/manager-applications` accepted the whole row from the client and
 * checked only the id, the email ownership and the bucket. Nothing server-side
 * required a name, a date of birth, income, references, consent or a signature
 * — every "required field" lived in `validateRentalWizardStep`, in the browser
 * (PRP-202). A scripted or malformed submission therefore landed in the
 * manager's queue looking legitimate, and approval generates charges and a
 * lease.
 */
const property = vi.hoisted(() => ({ row: null as Record<string, unknown> | null }));

vi.mock("@supabase/supabase-js", () => ({}));

function fakeDb() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: property.row, error: null }) }),
      }),
    }),
  } as never;
}

import { validateSubmittedApplication } from "@/lib/rental-application/validate-submission.server";

const LISTING = {
  id: "prop-1",
  property_data: { listingSubmission: { v: 1, rooms: [], bathrooms: [], allowedLeaseTerms: ["12_months"] } },
};

function row(over: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return { id: "AXIS-1", email: "a@example.com", bucket: "pending", propertyId: "prop-1", ...over } as DemoApplicantRow;
}

describe("validateSubmittedApplication", () => {
  it("declines to judge a row with no wizard payload", async () => {
    // An infrastructure gap, not an applicant mistake — refusing a real
    // submission over one would be worse than the hole this closes.
    property.row = LISTING;
    await expect(validateSubmittedApplication(fakeDb(), row({ application: undefined }))).resolves.toBeNull();
  });

  it("declines to judge when the listing cannot be resolved server-side", async () => {
    property.row = null;
    await expect(
      validateSubmittedApplication(fakeDb(), row({ application: { propertyId: "prop-1" } as never })),
    ).resolves.toBeNull();
  });

  it("rejects an empty application that the client would have refused", async () => {
    property.row = LISTING;
    const result = await validateSubmittedApplication(
      fakeDb(),
      row({ application: { propertyId: "prop-1" } as never }),
    );
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      // Field-level, so the client can point at what is missing rather than
      // showing a generic refusal.
      expect(Object.keys(result.errors).length).toBeGreaterThan(0);
      expect(typeof result.firstStep).toBe("number");
    }
  });
});

describe("the submit paths use it", () => {
  it("both call it, and skip a draft", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const file of [
      "src/lib/auth/guest-application-upsert.ts",
      "src/lib/auth/link-resident-on-application-submit.ts",
    ]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source).toContain("validateSubmittedApplication(db");
      // A half-finished draft is not a failed application — the applicant is
      // still in it.
      expect(source).toContain("isDraftShapedApplicationRow(params.row)");
    }
  });

  it("the client submit gate validates the Review step, where a custom question can live", async () => {
    // This used to assert the wizard's own `for (const s of activeSteps)` loop (PRP-202: a
    // required custom question mapped to Review sits past step 9, so a hardcoded 1..9 never
    // validated it). That loop is gone — the client and the server now share ONE validator,
    // which is strictly better than two implementations agreeing by luck. What still has to
    // hold is the INTENT, so it is asserted against the shared list rather than a code shape.
    const { SUBMIT_VALIDATION_STEPS } = await import("@/lib/rental-application/validate-application-submit");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    const REVIEW_STEP = 10;
    expect(SUBMIT_VALIDATION_STEPS).toContain(REVIEW_STEP);

    const wizard = readFileSync(
      join(process.cwd(), "src/components/marketing/rental-application-wizard.tsx"),
      "utf8",
    );
    expect(wizard).toContain("validateResidentApplicationSubmit");
    // The old bug in its most literal form must not come back.
    expect(wizard).not.toContain("for (let s = 1; s <= 9; s++)");
  });
});
