import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const charges = readFileSync(join(process.cwd(), "src/lib/household-charges.ts"), "utf8");
const payments = readFileSync(join(process.cwd(), "src/lib/lease-renewal-payments.ts"), "utf8");
const markSigned = readFileSync(join(process.cwd(), "src/lib/lease-mark-signed.client.ts"), "utf8");
const panel = readFileSync(join(process.cwd(), "src/components/portal/pro-leases-pipeline-panel.tsx"), "utf8");

function sliceFunction(src: string, name: string): string {
  const start = src.indexOf(`export function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf("\nexport function ", start + 1);
  return next === -1 ? src.slice(start) : src.slice(start, next);
}

describe("New terms reprice future rent only", () => {
  it("updatePendingRentAmountForResident touches pending rent rows only", () => {
    const fn = sliceFunction(charges, "updatePendingRentAmountForResident");
    expect(fn).toContain('r.status === "pending"');
    expect(fn).toContain('r.kind === "rent"');
    expect(fn).not.toContain('"paid"');
  });

  it("applySignedLeaseRenewal waits for both signatures and pendingRenewal", () => {
    expect(payments).toContain("if (!hasBothLeaseSignatures(leaseRow)) return false");
    expect(payments).toContain("leaseRow?.pendingRenewal");
    expect(payments).toContain("Paid / settled charges are left alone");
  });

  it("mark-signed and manager countersign both apply pending renewal", () => {
    expect(markSigned).toContain("applySignedLeaseRenewal");
    expect(markSigned).toContain("pendingRenewal");
    expect(panel).toContain("applySignedLeaseRenewal");
  });
});
