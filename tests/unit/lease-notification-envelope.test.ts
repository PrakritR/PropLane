import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://prop-lane.space" }));

import { buildDurableLeaseTransitionEnvelope } from "@/lib/domain-action-events.server";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

function lease(patch: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return {
    id: "lease-1", residentName: "Aarav Jain", residentEmail: "aarav@example.com",
    residentUserId: "11111111-1111-4111-8111-111111111111", unit: "Jain Home",
    roomChoice: "Room 1", stageLabel: "Resident Signature", updated: "now", bucket: "signed",
    pdfVersion: 1, notes: "", updatedAtIso: "2026-09-08T10:00:00.000Z",
    status: "Manager Signature Pending", residentSignature: { name: "Aarav Jain", signedAtIso: "2026-09-08T10:00:00.000Z", documentHash: "hash" },
    ...patch,
  } as LeasePipelineRow;
}

const actor = { userId: "22222222-2222-4222-8222-222222222222", email: "manager@example.com" };

describe("durable lease notification envelope", () => {
  it("queues the manager only after the resident signature and includes the exact sign URL", () => {
    const next = lease();
    const event = buildDurableLeaseTransitionEnvelope({ managerUserId: actor.userId, previous: lease({ residentSignature: null }), lease: next, actor });
    expect(event?.eventType).toBe("lease_signed_by_resident");
    expect(event?.deliveries.find((row) => row.audience === "manager")?.rendered).toMatchObject({
      text: expect.stringContaining("https://prop-lane.space/portal/leases/signed/lease-1"),
      smsText: expect.stringContaining("Aarav Jain signed the lease for Jain Home · Room 1"),
    });
  });

  it("fully signed outranks the half-sign transition and links the resident to the executed copy", () => {
    const previous = lease({ managerSignature: null, fullySignedAt: null });
    const next = lease({
      managerSignature: { name: "Manager", signedAtIso: "2026-09-08T11:00:00.000Z", documentHash: "hash" },
      fullySignedAt: "2026-09-08T11:00:00.000Z", status: "Fully Signed", bucket: "completed",
    });
    const event = buildDurableLeaseTransitionEnvelope({ managerUserId: actor.userId, previous, lease: next, actor });
    expect(event?.eventType).toBe("lease_signed");
    expect(event?.deliveries.find((row) => row.audience === "resident")?.rendered.text)
      .toContain("https://prop-lane.space/resident/documents/lease/lease-1");
    expect(event?.deliveries.find((row) => row.audience === "manager")?.rendered.text)
      .toContain("https://prop-lane.space/portal/leases/completed/lease-1");
  });

  it("does not create a signature notification without a signature transition", () => {
    expect(buildDurableLeaseTransitionEnvelope({ managerUserId: actor.userId, previous: lease(), lease: lease(), actor })).toBeNull();
  });
});
