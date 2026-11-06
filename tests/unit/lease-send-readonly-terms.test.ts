import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { implausibleRentReason, leaseTermsDriftFromApplication, medianOf } from "@/lib/lease-terms-drift";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

describe("lease terms drift (the server refuses a body that differs from the record)", () => {
  const record = { leaseStart: "2026-11-04", leaseEnd: "", managerRentOverride: "1100", managerSecurityDepositOverride: "250" };

  it("is empty when the lease carries the record's terms", () => {
    expect(leaseTermsDriftFromApplication({ ...record }, record)).toEqual([]);
    expect(leaseTermsDriftFromApplication({ ...record, managerRentOverride: "1100.00" }, record)).toEqual([]);
    expect(leaseTermsDriftFromApplication({ ...record, managerSecurityDepositOverride: "" }, { ...record, managerSecurityDepositOverride: "0" })).toEqual([]);
  });

  it("names every term that differs", () => {
    expect(leaseTermsDriftFromApplication({ ...record, managerRentOverride: "11100" }, record)).toEqual(["rent"]);
    expect(
      leaseTermsDriftFromApplication({ leaseStart: "2026-12-01", leaseEnd: "2027-11-30", managerRentOverride: "900", managerSecurityDepositOverride: "0" }, record),
    ).toEqual(["start", "end", "rent", "deposit"]);
    expect(leaseTermsDriftFromApplication(null, record)).toEqual(["start", "rent", "deposit"]);
  });

  it("flags an implausible rent: under $100, or over 5x the house's median room rent", () => {
    expect(implausibleRentReason(50, 1000)).toMatch(/under \$100/);
    expect(implausibleRentReason(11100, 1000)).toMatch(/5×/);
    expect(implausibleRentReason(5000, 1000)).toBeNull();
    expect(implausibleRentReason(11100, null)).toBeNull();
    expect(medianOf([1000, 1200, 900])).toBe(1000);
    expect(medianOf([1000, 1200])).toBe(1100);
    expect(medianOf([])).toBeNull();
  });
});

describe("Send lease screen wiring", () => {
  const sheet = read("src/components/portal/lease-send-sheet.tsx");

  it("has no source toggle, no file card, no confirm box and no editable terms", () => {
    for (const gone of ["SegmentedTwo", "WorkspaceFileCard", "This is the lease I", "lease-send-confirm-box", "commitTerms", "MoneyInput", "<DateField"]) {
      expect(sheet).not.toContain(gone);
    }
    expect(sheet).toContain('label="Upload a PDF instead"');
    expect(sheet).toContain('label="Edit resident"');
    expect(sheet).toContain("onEditResident");
  });

  it("no account is an informational row: Send invites and sends in one press, and an invite failure stops the send", () => {
    expect(sheet).not.toContain('blockedBy.push("invite")');
    expect(sheet).toContain("we'll email an invite with the lease");
    const invite = sheet.indexOf("await requestResidentWelcomeEmail(app)");
    expect(invite).toBeGreaterThan(-1);
    expect(invite).toBeLessThan(sheet.indexOf("await sendLeaseToResident(target.row.id"));
    expect(sheet.slice(invite, invite + 300)).toMatch(/status !== "sent"[\s\S]*setError[\s\S]*return;/);
  });

  it("keeps the PDF path", () => {
    for (const kept of ["pdfTermRows", "resolvePdfTermPicks", "confirmUploadedLeaseParseOnServer", "Use the PropLane lease instead"]) {
      expect(sheet).toContain(kept);
    }
  });

  it("the server re-reads the record's terms when a lease is first sent", () => {
    const route = read("src/app/api/portal-lease-pipeline/route.ts");
    expect(route).toContain("leaseTermsDriftFromApplication(nextRow.application, appRow.application)");
    expect(route).toContain('blocked: "terms-differ"');
  });
});
