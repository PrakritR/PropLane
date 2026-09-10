// @vitest-environment jsdom
//
// Reported: "I signed the lease but it is still in the Manager signature tab — it should move
// to Signed."
//
// A resident can sign in TWO ways: electronically, or offline by returning the signed PDF
// (`residentReturnedSignedPdfAt`, or the thread note `leaseAwaitingManagerCountersign` reads).
// The pipeline already knew that — `leaseAwaitingManagerCountersign` and
// `hasBothLeaseSignatures` both accept either. `workflowStatusForRow` did not: it read only the
// e-signature, so once the manager countersigned an offline-signed lease the status stayed
// "Manager Signature Pending" forever.
//
// The Signed tab is `status === "Fully Signed"` (the `completed` tab; the tab LABELLED "Manager
// signature" is bucket `signed`), so that lease could never leave Manager signature no matter
// how many times the manager signed it — while `hasBothLeaseSignatures` insisted both parties
// had. Two answers to "has the resident signed" that disagree is the whole defect.
import { describe, expect, it } from "vitest";
import {
  hasBothLeaseSignatures,
  leaseAwaitingManagerCountersign,
  leaseRowMatchesManagerTab,
  normalizeLeasePipelineRow,
  RESIDENT_RETURNED_SIGNED_PDF_THREAD,
} from "@/lib/lease-pipeline-storage";

const MANAGER_SIGNATURE = { name: "Fekadu Bizuneh", signedAtIso: "2026-09-09T17:00:00.000Z" };
const RESIDENT_SIGNATURE = { name: "A Resident", signedAtIso: "2026-09-08T17:00:00.000Z" };

function row(extra: Record<string, unknown>) {
  return normalizeLeasePipelineRow({
    id: "lease-1",
    bucket: "signed",
    generatedHtml: "<html><body>lease</body></html>",
    ...extra,
  } as never);
}

describe("a countersigned lease reaches the Signed tab", () => {
  it("when the resident signed electronically", () => {
    const r = row({ managerSignature: MANAGER_SIGNATURE, residentSignature: RESIDENT_SIGNATURE });
    expect(r.status).toBe("Fully Signed");
    expect(leaseRowMatchesManagerTab(r, "completed")).toBe(true);
    expect(leaseRowMatchesManagerTab(r, "signed")).toBe(false);
  });

  it("when the resident signed offline and returned the PDF", () => {
    const r = row({
      managerSignature: MANAGER_SIGNATURE,
      residentReturnedSignedPdfAt: "2026-09-08T17:00:00.000Z",
    });
    expect(r.status).toBe("Fully Signed");
    expect(leaseRowMatchesManagerTab(r, "completed")).toBe(true);
    expect(leaseRowMatchesManagerTab(r, "signed")).toBe(false);
  });

  it("when the offline return is recorded only as a thread note", () => {
    const r = row({
      managerSignature: MANAGER_SIGNATURE,
      thread: [{ body: RESIDENT_RETURNED_SIGNED_PDF_THREAD }],
    });
    expect(r.status).toBe("Fully Signed");
    expect(leaseRowMatchesManagerTab(r, "completed")).toBe(true);
  });

  it("agrees with hasBothLeaseSignatures either way", () => {
    for (const resident of [
      { residentSignature: RESIDENT_SIGNATURE },
      { residentReturnedSignedPdfAt: "2026-09-08T17:00:00.000Z" },
    ]) {
      const r = row({ managerSignature: MANAGER_SIGNATURE, ...resident });
      expect(hasBothLeaseSignatures(r)).toBe(true);
      expect(r.status).toBe("Fully Signed");
    }
  });

  it("still waits for the manager while only the resident has signed", () => {
    const waiting = row({ residentReturnedSignedPdfAt: "2026-09-08T17:00:00.000Z" });
    expect(waiting.status).toBe("Manager Signature Pending");
    expect(leaseAwaitingManagerCountersign(waiting)).toBe(true);
    expect(leaseRowMatchesManagerTab(waiting, "signed")).toBe(true);
    expect(leaseRowMatchesManagerTab(waiting, "completed")).toBe(false);
  });

  it("leaves a voided lease voided", () => {
    const voided = row({
      managerSignature: MANAGER_SIGNATURE,
      residentReturnedSignedPdfAt: "2026-09-08T17:00:00.000Z",
      voidedAt: "2026-09-09T18:00:00.000Z",
    });
    expect(voided.status).toBe("Voided");
  });
});
