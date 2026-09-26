// @vitest-environment jsdom
//
// C066 — the lease record page needs an Audit trail: who signed, when, and
// the document fingerprint. The hash was already computed
// (`row.documentSha256`, per-signature `documentSha256`) but never rendered
// anywhere. `leaseAuditTrailFacts` is the pure derivation the UI renders
// (`pro-leases-pipeline-panel.tsx`'s lease-document tab and its Overview
// card) — pinned here directly rather than through a full component render.
import { describe, expect, it } from "vitest";
import { leaseAuditTrailFacts } from "@/lib/lease-execution-evidence";
import { normalizeLeasePipelineRow, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";

const HASH_A = "3f9ac21088d14e77" + "a".repeat(48);
const HASH_B = "b".repeat(64);

function baseRow(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return normalizeLeasePipelineRow({
    id: "lease_audit",
    residentName: "Jordan Lee",
    residentEmail: "jordan.lee@example.com",
    unit: "Unit A",
    bucket: "manager",
    pdfVersion: 1,
    notes: "",
    updatedAtIso: "2026-07-01T00:00:00.000Z",
    thread: [],
    generatedHtml: "<html><body>LEASE BODY</body></html>",
    generatedAtIso: "2026-07-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("leaseAuditTrailFacts", () => {
  it("returns null for a row with nothing to attest yet", () => {
    expect(leaseAuditTrailFacts(baseRow())).toBeNull();
  });

  it("surfaces the document fingerprint once one is recorded", () => {
    const row = baseRow({
      residentSignature: { role: "resident", name: "Jordan Lee", signedAtIso: "2026-07-02T00:00:00.000Z", documentSha256: HASH_A },
    });
    const facts = leaseAuditTrailFacts(row);
    expect(facts).not.toBeNull();
    const fingerprint = facts!.find((f) => f.label === "Document fingerprint");
    expect(fingerprint?.value).toBeTruthy();
    expect(fingerprint?.value).not.toContain(HASH_A); // readable prefix label, never the raw digest
  });

  it("surfaces template and jurisdiction when populated", () => {
    const facts = leaseAuditTrailFacts(
      baseRow({ templateVersion: "ca-residential@1.2.0", executedJurisdiction: "US-CA/san_francisco" }),
    );
    expect(facts).toEqual(
      expect.arrayContaining([
        { label: "Template", value: "ca-residential@1.2.0" },
        { label: "Jurisdiction", value: "US-CA/san_francisco" },
      ]),
    );
  });

  it("warns and shows BOTH fingerprints when the two parties signed different documents", () => {
    const row = baseRow({
      residentSignature: { role: "resident", name: "Jordan Lee", signedAtIso: "2026-07-02T00:00:00.000Z", documentSha256: HASH_A },
      managerSignature: { role: "manager", name: "Pat Manager", signedAtIso: "2026-07-03T00:00:00.000Z", documentSha256: HASH_B },
    });
    const facts = leaseAuditTrailFacts(row)!;
    expect(facts.some((f) => f.label === "Manager signed fingerprint")).toBe(true);
    expect(facts.some((f) => f.label === "Resident signed fingerprint")).toBe(true);
    expect(facts.some((f) => f.label === "Fingerprint warning")).toBe(true);
  });

  it("never shows the divergence warning when both parties signed the same document", () => {
    const row = baseRow({
      residentSignature: { role: "resident", name: "Jordan Lee", signedAtIso: "2026-07-02T00:00:00.000Z", documentSha256: HASH_A },
      managerSignature: { role: "manager", name: "Pat Manager", signedAtIso: "2026-07-03T00:00:00.000Z", documentSha256: HASH_A },
    });
    const facts = leaseAuditTrailFacts(row)!;
    expect(facts.some((f) => f.label === "Fingerprint warning")).toBe(false);
  });
});
