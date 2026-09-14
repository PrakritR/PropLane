/**
 * `leaseCanBeMarkedSignedOffPlatform` is the ONE decision behind "Mark as
 * signed": the detail footer, the list's selection bar and the mark-signed
 * route all read it. This pins the window it opens — no execution evidence of
 * any kind on the row — across every status × signature combination.
 */
import { describe, expect, it } from "vitest";
import { leaseCanBeMarkedSignedOffPlatform } from "@/lib/lease-execution-evidence";

const resident = { role: "resident" as const, name: "Luna Testerson", signedAtIso: "2026-09-13T02:00:00.000Z" };
const manager = { role: "manager" as const, name: "Pat Manager", signedAtIso: "2026-09-13T03:00:00.000Z" };

function row(overrides: Parameters<typeof leaseCanBeMarkedSignedOffPlatform>[0] extends infer T ? Partial<T> : never) {
  return {
    bucket: "manager" as const,
    status: "Manager Review" as const,
    managerSignature: null,
    residentSignature: null,
    signatureName: null,
    signedAtIso: null,
    fullySignedAt: null,
    voidedAt: null,
    residentReturnedSignedPdfAt: null,
    ...overrides,
  };
}

describe("leaseCanBeMarkedSignedOffPlatform", () => {
  it("opens for Draft, Manager Review and an unsigned Resident Signature Pending lease", () => {
    expect(leaseCanBeMarkedSignedOffPlatform(row({ status: "Draft" }))).toBe(true);
    expect(leaseCanBeMarkedSignedOffPlatform(row({ status: "Manager Review" }))).toBe(true);
    expect(leaseCanBeMarkedSignedOffPlatform(row({ bucket: "resident", status: "Resident Signature Pending" }))).toBe(true);
  });

  it("closes the moment the resident has signed, electronically or by returning a PDF", () => {
    expect(
      leaseCanBeMarkedSignedOffPlatform(row({ bucket: "signed", status: "Manager Signature Pending", residentSignature: resident })),
    ).toBe(false);
    expect(leaseCanBeMarkedSignedOffPlatform(row({ bucket: "resident", residentSignature: resident }))).toBe(false);
    // Legacy signature fields count as a signature too.
    expect(leaseCanBeMarkedSignedOffPlatform(row({ signatureName: "Luna Testerson", signedAtIso: resident.signedAtIso }))).toBe(false);
    expect(
      leaseCanBeMarkedSignedOffPlatform(
        row({ bucket: "signed", status: "Manager Signature Pending", residentReturnedSignedPdfAt: "2026-09-13T02:00:00.000Z" }),
      ),
    ).toBe(false);
  });

  it("closes on a manager signature, on fullySignedAt alone, and on a void", () => {
    expect(leaseCanBeMarkedSignedOffPlatform(row({ managerSignature: manager }))).toBe(false);
    // `fullySignedAt` with no signature object is still an execution claim (`leaseClaimsExecution`).
    expect(leaseCanBeMarkedSignedOffPlatform(row({ fullySignedAt: "2026-09-13T03:00:00.000Z" }))).toBe(false);
    expect(leaseCanBeMarkedSignedOffPlatform(row({ status: "Voided", voidedAt: "2026-09-13T04:00:00.000Z" }))).toBe(false);
    expect(leaseCanBeMarkedSignedOffPlatform(row({ voidedAt: "2026-09-13T04:00:00.000Z" }))).toBe(false);
  });

  it("never reopens a Fully Signed lease", () => {
    expect(
      leaseCanBeMarkedSignedOffPlatform(
        row({ bucket: "signed", status: "Fully Signed", residentSignature: resident, managerSignature: manager, fullySignedAt: manager.signedAtIso }),
      ),
    ).toBe(false);
  });

  it("stays closed for Admin Review and for the signed bucket without a signature object", () => {
    expect(leaseCanBeMarkedSignedOffPlatform(row({ status: "Admin Review" }))).toBe(false);
    expect(leaseCanBeMarkedSignedOffPlatform(row({ bucket: "signed", status: "Manager Signature Pending" }))).toBe(false);
  });
});
