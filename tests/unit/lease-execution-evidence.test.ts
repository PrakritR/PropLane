// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEASE_ESIGN_CONSENT_TEXT,
  LEASE_ESIGN_CONSENT_VERSION,
  documentFingerprintLabel,
  leaseDocumentSha256,
  signedDocumentHashesDiverge,
} from "@/lib/lease-execution-evidence";
import {
  applyLeaseSignaturesToHtml,
  getLeaseDocumentHtml,
  managerSignLease,
  normalizeLeasePipelineRow,
  readLeasePipeline,
  residentSignLease,
  seedDemoLeasePipeline,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";

const MANAGER_ID = "manager-evidence";
const LEASE_HTML = "<html><body>LEASE BODY v1</body></html>";
// A stored hash is only rendered when it is really a SHA-256 digest.
const HASH_A = "3f9ac21088d14e77" + "a".repeat(48);
const HASH_B = "b".repeat(64);

function independentSha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function baseRow(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return normalizeLeasePipelineRow({
    id: "lease_evidence",
    residentName: "Jordan Lee",
    residentEmail: "jordan.lee@example.com",
    unit: "Unit A",
    bucket: "manager",
    pdfVersion: 1,
    notes: "",
    updatedAtIso: "2026-07-01T00:00:00.000Z",
    managerUserId: MANAGER_ID,
    thread: [],
    generatedHtml: LEASE_HTML,
    generatedAtIso: "2026-07-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("lease document hashing", () => {
  it("hashes the generated HTML exactly as an independent tool would", async () => {
    expect(await leaseDocumentSha256(baseRow())).toBe(independentSha256(LEASE_HTML));
  });

  it("keeps a stored disclosure-review aside so display matches the fingerprint", async () => {
    const html =
      '<html><body><aside class="disclosure-review"><p>Review item</p></aside><p>LEASE BODY v1</p></body></html>';
    const row = baseRow({ generatedHtml: html });
    expect(getLeaseDocumentHtml(row)).toContain('class="disclosure-review"');
    expect(await leaseDocumentSha256(row)).toBe(independentSha256(html));
  });

  it("hashes the ORIGINAL uploaded PDF, not the copy carrying the certificate page", async () => {
    const originalBytes = "hello-lease";
    const originalDataUrl = `data:application/pdf;base64,${Buffer.from(originalBytes).toString("base64")}`;
    const withCertPage = `data:application/pdf;base64,${Buffer.from("hello-lease+certificate").toString("base64")}`;
    const row = baseRow({
      generatedHtml: null,
      managerUploadedPdf: { dataUrl: withCertPage, originalDataUrl, fileName: "lease.pdf", uploadedAt: "2026-07-01T00:00:00.000Z" },
    });

    expect(await leaseDocumentSha256(row)).toBe(independentSha256(originalBytes));
  });

  it("returns null when the row carries no document", async () => {
    expect(await leaseDocumentSha256(baseRow({ generatedHtml: null }))).toBeNull();
  });

  it("formats a readable fingerprint prefix and tolerates an absent hash", () => {
    expect(documentFingerprintLabel(HASH_A)).toBe("3F9A C210 88D1 4E77");
    expect(documentFingerprintLabel(null)).toBeNull();
    expect(documentFingerprintLabel(undefined)).toBeNull();
  });

  it("refuses to carry a stored value that is not a SHA-256 digest", () => {
    // row_data is client-writable and this value is printed on a legal
    // certificate, so "CAFEBABE" must never render as a fingerprint.
    const row = baseRow({
      residentSignature: {
        role: "resident",
        name: "R",
        signedAtIso: "2026-07-01T00:00:00.000Z",
        documentSha256: "cafebabe" as string,
      },
    });

    expect(row.residentSignature?.documentSha256).toBeNull();
    expect(row.documentSha256).toBeNull();
    expect(applyLeaseSignaturesToHtml(row, LEASE_HTML)).not.toContain("CAFE BABE");
  });

  it("derives the row hash from the first signature, so a replaced document cannot leave a stale one", () => {
    // A stored row-level hash is ignored: every reset path spreads `...row` and
    // nulls only the signature fields, so a carried-forward copy went stale the
    // moment the document was replaced and the row re-signed.
    const row = baseRow({
      documentSha256: "f".repeat(64),
      residentSignature: { role: "resident", name: "R", signedAtIso: "2026-07-01T00:00:00.000Z", documentSha256: HASH_A },
      managerSignature: { role: "manager", name: "M", signedAtIso: "2026-07-02T00:00:00.000Z", documentSha256: HASH_B },
    });

    expect(row.documentSha256).toBe(HASH_A);
    expect(baseRow({ residentSignature: null, managerSignature: null, documentSha256: HASH_A }).documentSha256).toBeNull();
  });

  it("treats an unrecognized consent version as no consent at all", () => {
    const row = baseRow({
      residentSignature: {
        role: "resident",
        name: "R",
        signedAtIso: "2026-07-01T00:00:00.000Z",
        consentVersion: "made-up-v9",
      },
    });

    expect(applyLeaseSignaturesToHtml(row, LEASE_HTML)).not.toContain("Consented to transact electronically");
  });

  it("flags a document that changed between the two signatures", () => {
    const diverged = baseRow({
      residentSignature: { role: "resident", name: "R", signedAtIso: "2026-07-01T00:00:00.000Z", documentSha256: HASH_A },
      managerSignature: { role: "manager", name: "M", signedAtIso: "2026-07-02T00:00:00.000Z", documentSha256: HASH_B },
    });
    const agreed = baseRow({
      residentSignature: { role: "resident", name: "R", signedAtIso: "2026-07-01T00:00:00.000Z", documentSha256: HASH_A },
      managerSignature: { role: "manager", name: "M", signedAtIso: "2026-07-02T00:00:00.000Z", documentSha256: HASH_A },
    });

    expect(signedDocumentHashesDiverge(diverged)).toBe(true);
    expect(signedDocumentHashesDiverge(agreed)).toBe(false);
    // A pre-change signature carries no hash: unknown, not divergent.
    expect(signedDocumentHashesDiverge(baseRow({ residentSignature: { role: "resident", name: "R", signedAtIso: "2026-07-01T00:00:00.000Z" } }))).toBe(false);
  });
});

describe("signature certificate", () => {
  it("shows the fingerprint, consent and provenance when present", () => {
    const row = baseRow({
      documentSha256: HASH_A,
      templateVersion: "ca-residential@1.2.0",
      executedJurisdiction: "US-CA/san_francisco",
      residentSignature: {
        role: "resident",
        name: "Jordan Lee",
        signedAtIso: "2026-07-01T00:00:00.000Z",
        documentSha256: HASH_A,
        consentVersion: LEASE_ESIGN_CONSENT_VERSION,
      },
    });

    const html = applyLeaseSignaturesToHtml(row, LEASE_HTML)!;
    expect(html).toContain(HASH_A); // full digest in the provenance list
    expect(html).toContain("3F9A C210 88D1 4E77"); // readable prefix on the signature card
    expect(html).toContain("ca-residential@1.2.0");
    expect(html).toContain("US-CA/san_francisco");
    expect(html).toContain("Consented to transact electronically");
    expect(html).toContain(LEASE_ESIGN_CONSENT_TEXT.slice(0, 40));
    // The two-signature language is load-bearing and must survive.
    expect(html).toContain("requires exactly two electronic signatures");
  });

  it("renders a pre-change lease with no provenance without errors or empty labels", () => {
    const legacy = baseRow({
      signatureName: "Jordan Lee",
      signedAtIso: "2026-06-01T00:00:00.000Z",
    });

    expect(legacy.documentSha256).toBeNull();
    expect(legacy.templateVersion).toBeNull();
    expect(legacy.executedJurisdiction).toBeNull();

    const html = applyLeaseSignaturesToHtml(legacy, LEASE_HTML)!;
    expect(html).toContain("Jordan Lee");
    expect(html).not.toContain("Document fingerprint");
    expect(html).not.toContain("Lease template:");
    expect(html).toContain("requires exactly two electronic signatures");
  });

  it("warns on the certificate when the parties signed different documents", () => {
    const row = baseRow({
      residentSignature: { role: "resident", name: "R", signedAtIso: "2026-07-01T00:00:00.000Z", documentSha256: HASH_A },
      managerSignature: { role: "manager", name: "M", signedAtIso: "2026-07-02T00:00:00.000Z", documentSha256: HASH_B },
    });

    expect(applyLeaseSignaturesToHtml(row, LEASE_HTML)).toContain("did not sign identical documents");
  });
});

describe("signing records the hash of what was signed", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState({}, "", "/portal/leases");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  });

  // Resident-side reads are unscoped (`readRaw()` with no manager id), so the
  // resident half of the flow seeds the shared store and the manager half seeds
  // the manager's, the same split the two portals have in the browser.
  const RESIDENT_SCOPE = "";

  it("stamps the resident signature with the hash of the document they were shown", async () => {
    seedDemoLeasePipeline(
      [baseRow({ bucket: "resident", status: "Resident Signature Pending", sentToResidentAt: "2026-07-01T00:00:00.000Z" })],
      RESIDENT_SCOPE,
    );

    expect(await residentSignLease("jordan.lee@example.com", "Jordan Lee", LEASE_ESIGN_CONSENT_VERSION)).toBe(true);

    const row = readLeasePipeline().find((r) => r.id === "lease_evidence")!;
    expect(row.residentSignature?.documentSha256).toBe(independentSha256(LEASE_HTML));
    expect(row.residentSignature?.consentVersion).toBe(LEASE_ESIGN_CONSENT_VERSION);
    expect(row.documentSha256).toBe(independentSha256(LEASE_HTML));
  });

  it("stamps the manager countersignature with the same hash and leaves the later agents' fields null", async () => {
    const expected = independentSha256(LEASE_HTML);
    seedDemoLeasePipeline(
      [
        baseRow({
          bucket: "signed",
          status: "Manager Signature Pending",
          sentToResidentAt: "2026-07-01T00:00:00.000Z",
          residentSignedAt: "2026-07-01T02:00:00.000Z",
          documentSha256: expected,
          residentSignature: {
            role: "resident",
            name: "Jordan Lee",
            signedAtIso: "2026-07-01T02:00:00.000Z",
            documentSha256: expected,
            consentVersion: LEASE_ESIGN_CONSENT_VERSION,
          },
        }),
      ],
      MANAGER_ID,
    );

    expect(await managerSignLease("lease_evidence", "Pat Manager", MANAGER_ID, LEASE_ESIGN_CONSENT_VERSION)).toBe(true);

    const row = readLeasePipeline(MANAGER_ID).find((r) => r.id === "lease_evidence")!;
    expect(row.status).toBe("Fully Signed");
    expect(row.managerSignature?.documentSha256).toBe(expected);
    expect(row.managerSignature?.consentVersion).toBe(LEASE_ESIGN_CONSENT_VERSION);
    expect(row.documentSha256).toBe(expected);
    expect(signedDocumentHashesDiverge(row)).toBe(false);
    // Jurisdiction and template version are written by later agents.
    expect(row.executedJurisdiction).toBeNull();
    expect(row.templateVersion).toBeNull();
  });
});
