import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const amendment = readFileSync(join(process.cwd(), "src/lib/lease-amendment.server.ts"), "utf8");
const payments = readFileSync(join(process.cwd(), "src/lib/lease-renewal-payments.ts"), "utf8");
const route = readFileSync(join(process.cwd(), "src/app/api/manager/amend-lease/route.ts"), "utf8");

function sliceExport(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf("\nexport ", start + 1);
  return next === -1 ? src.slice(start) : src.slice(start, next);
}

describe("New terms never write listing advertised rent", () => {
  it("renewLease does not patch listingSubmission room monthlyRent", () => {
    const renew = sliceExport(amendment, "renewLease");
    expect(renew).not.toContain("listingSubmission");
    expect(renew).not.toMatch(/rooms\s*\.map/);
    expect(renew).toContain("pendingRenewal");
    expect(renew).toContain("externallySignedLease: false");
    expect(renew).toContain("managerUploadedPdf: null");
  });

  it("applySignedLeaseRenewal writes application rent only", () => {
    expect(payments).toContain("signedMonthlyRent");
    expect(payments).toContain("managerRentOverride");
    expect(payments).not.toMatch(/listingSubmission\s*:/);
    expect(payments).toContain("updatePendingRentAmountForResident");
  });

  it("amend-lease route refuses listing-rent fields", () => {
    expect(route).toContain("listingMonthlyRent");
    expect(route).toContain("New terms do not change the house listing price.");
  });
});
