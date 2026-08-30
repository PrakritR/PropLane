import { describe, expect, it } from "vitest";
import { snapshotJordanLee } from "@/data/manager-application-snapshots";
import { buildAiGeneratedLeaseHtml, leaseContextFromApplication } from "@/lib/generated-lease";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

function generatedLeaseHtml(ctx: Parameters<typeof buildAiGeneratedLeaseHtml>[0]): string {
  const outcome = buildAiGeneratedLeaseHtml(ctx);
  if (outcome.kind !== "generated") throw new Error(outcome.error);
  return outcome.html;
}

/**
 * Custom-fee billing must reach the LEASE ([key=custom-fee-billing], captain: "make sure it
 * updates lease aswell"). A one-time custom fee that bills must appear in the generated lease
 * charges by name and amount — a lease that omits a billed charge is a legal problem.
 */
describe("custom fees in the generated lease", () => {
  function leaseHtmlWithCustomFees(customFees: { id: string; label: string; amount: string; frequency: "one-time" | "monthly" }[]) {
    const ctx = leaseContextFromApplication(snapshotJordanLee());
    const sub = ctx.submission ?? createDefaultListingSubmission();
    return generatedLeaseHtml({
      ...ctx,
      leasedRoom: undefined,
      submission: { ...sub, customFees },
    });
  }

  it("lists a one-time custom fee's name and amount in the lease charges", () => {
    const html = leaseHtmlWithCustomFees([
      { id: "cf1", label: "Cleaning fee", amount: "125", frequency: "one-time" },
    ]);
    expect(html).toContain("Cleaning fee");
    expect(html).toContain("$125.00");
    expect(html).toContain("4. Move-In Payment Summary");
    expect(html).toMatch(/<strong>\$125\.00<\/strong> Cleaning fee/);
  });

  it("lists a monthly custom fee in the rent section as a monthly item (it now bills recurring)", () => {
    const html = leaseHtmlWithCustomFees([
      { id: "cf1", label: "Parking spot", amount: "100", frequency: "monthly" },
    ]);
    expect(html).toContain("Parking spot");
    expect(html).toMatch(/<strong>Parking spot:<\/strong> \$100\.00 \(monthly\)/);
  });

  it("lists a short-term custom fee in the short-term stay's Payment table", () => {
    const ctx = leaseContextFromApplication(snapshotJordanLee());
    const sub = ctx.submission ?? createDefaultListingSubmission();
    const html = generatedLeaseHtml({
      ...ctx,
      leasedRoom: undefined,
      application: { ...ctx.application, rentalType: "short_term", leaseStart: "2026-03-10", leaseEnd: "2026-03-16" },
      submission: {
        ...sub,
        shortTermRentalsAllowed: true,
        shortTermDailyCost: "85",
        shortTermDeposit: "100",
        customFees: [{ id: "cf1", label: "Resort fee", amount: "", frequency: "one-time", shortTermAmount: "40" }],
      },
    });
    expect(html).toContain("Resort fee");
    expect(html).toContain("$40");
  });
});
