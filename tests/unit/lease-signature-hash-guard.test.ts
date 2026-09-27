/**
 * Part 3 hotfix, defect 3 (server half): `newSignatureHashMismatch` is the
 * server-side check behind the 409 "This lease changed after you opened it.
 * Reload it and sign again." — the signature hash reported by the client must
 * match what the SERVER actually has stored, not merely be present.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newSignatureHashMismatch } from "@/lib/lease-signature-hash-guard";
import { normalizeLeasePipelineRow, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Of(text: string): string {
  return hashBytes(new TextEncoder().encode(text));
}

function row(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return normalizeLeasePipelineRow({
    id: "lease_hash_guard",
    residentName: "Jordan Lee",
    residentEmail: "jordan.lee@example.com",
    unit: "Unit A",
    bucket: "resident",
    status: "Resident Signature Pending",
    pdfVersion: 1,
    notes: "",
    updatedAtIso: "2026-09-24T00:00:00.000Z",
    generatedHtml: "<p>Lease v1</p>",
    thread: [],
    ...overrides,
  });
}

describe("newSignatureHashMismatch", () => {
  it("refuses a NEW signature whose reported hash does not match the stored document", () => {
    const stored = row();
    const next = row({
      residentSignature: { role: "resident", name: "Jordan Lee", signedAtIso: "2026-09-24T01:00:00Z", documentSha256: "a".repeat(64) },
    });
    expect(newSignatureHashMismatch(stored, next, hashBytes)).toBe(true);
  });

  it("accepts a NEW signature whose reported hash matches the stored document exactly", () => {
    const stored = row();
    const next = row({
      residentSignature: {
        role: "resident",
        name: "Jordan Lee",
        signedAtIso: "2026-09-24T01:00:00Z",
        documentSha256: sha256Of("<p>Lease v1</p>"),
      },
    });
    expect(newSignatureHashMismatch(stored, next, hashBytes)).toBe(false);
  });

  it("does not judge a resend or re-sign — that is leaseSignatureWriteRefusal's job", () => {
    const existingSig = { role: "resident" as const, name: "Jordan Lee", signedAtIso: "2026-09-24T01:00:00Z", documentSha256: "a".repeat(64) };
    const stored = row({ residentSignature: existingSig });
    // A second signature with a bogus hash over the SAME already-signed row —
    // the write-refusal guard blocks this shape before the hash check ever
    // runs, so this function must not ALSO refuse it (never double-report).
    const next = row({ residentSignature: { ...existingSig, signedAtIso: "2026-09-24T02:00:00Z", documentSha256: "b".repeat(64) } });
    expect(newSignatureHashMismatch(stored, next, hashBytes)).toBe(false);
  });

  it("does not refuse an absent hash — WebCrypto being unavailable is honest, not forged", () => {
    const stored = row();
    const next = row({
      residentSignature: { role: "resident", name: "Jordan Lee", signedAtIso: "2026-09-24T01:00:00Z" },
    });
    expect(newSignatureHashMismatch(stored, next, hashBytes)).toBe(false);
  });

  it("does not refuse when the stored row has no document bytes to compare against", () => {
    const stored = row({ generatedHtml: null });
    const next = row({
      generatedHtml: null,
      residentSignature: { role: "resident", name: "Jordan Lee", signedAtIso: "2026-09-24T01:00:00Z", documentSha256: "a".repeat(64) },
    });
    expect(newSignatureHashMismatch(stored, next, hashBytes)).toBe(false);
  });

  it("checks the manager's countersignature the same way", () => {
    const stored = row({
      bucket: "signed",
      status: "Manager Signature Pending",
      residentSignature: { role: "resident", name: "Jordan Lee", signedAtIso: "2026-09-24T01:00:00Z", documentSha256: sha256Of("<p>Lease v1</p>") },
    });
    const mismatched = row({
      ...stored,
      managerSignature: { role: "manager", name: "Pat Manager", signedAtIso: "2026-09-24T02:00:00Z", documentSha256: "c".repeat(64) },
    });
    expect(newSignatureHashMismatch(stored, mismatched, hashBytes)).toBe(true);

    const matched = row({
      ...stored,
      managerSignature: { role: "manager", name: "Pat Manager", signedAtIso: "2026-09-24T02:00:00Z", documentSha256: sha256Of("<p>Lease v1</p>") },
    });
    expect(newSignatureHashMismatch(stored, matched, hashBytes)).toBe(false);
  });

  it("returns false with no stored row (a new row has nothing to have changed since)", () => {
    const next = row({
      residentSignature: { role: "resident", name: "Jordan Lee", signedAtIso: "2026-09-24T01:00:00Z", documentSha256: "a".repeat(64) },
    });
    expect(newSignatureHashMismatch(null, next, hashBytes)).toBe(false);
    expect(newSignatureHashMismatch(undefined, next, hashBytes)).toBe(false);
  });
});
