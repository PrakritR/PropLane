import { describe, expect, it, vi } from "vitest";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  reportResidentLeaseIssue,
  residentLeaseIssueAllowed,
} from "@/lib/lease-issue-report.server";

vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalInboxMessage: vi.fn(async () => ({ ok: true, recipientCount: 1 })),
}));

import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";

function lease(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return {
    id: "lease-1",
    residentEmail: "resident@test.com",
    residentName: "Resident Test",
    propertyId: "prop-1",
    unit: "Room 2",
    status: "Resident Signature Pending",
    bucket: "resident",
    generatedHtml: "<p>Lease</p>",
    managerUserId: "mgr-1",
    ...overrides,
  } as LeasePipelineRow;
}

describe("residentLeaseIssueAllowed", () => {
  it("allows reporting while the lease waits on resident signature", () => {
    expect(residentLeaseIssueAllowed(lease())).toBe(true);
  });

  it("refuses after the resident has already signed", () => {
    expect(
      residentLeaseIssueAllowed(
        lease({
          residentSignature: { role: "resident", name: "Resident", signedAtIso: "2026-09-05T00:00:00.000Z" },
        }),
      ),
    ).toBe(false);
  });
});

describe("reportResidentLeaseIssue", () => {
  it("moves the lease to manager review and notifies the manager", async () => {
    const row = lease();
    const update = vi.fn().mockResolvedValue({ error: null });
    const db = {
      from: vi.fn((table: string) => {
        if (table === "portal_lease_pipeline_records") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: row.id,
                      row_data: row,
                      manager_user_id: "mgr-1",
                      property_id: "prop-1",
                      resident_email: "resident@test.com",
                    },
                    error: null,
                  }),
                }),
              }),
            }),
            update: (payload: unknown) => ({
              eq: () => ({
                eq: async () => {
                  update(payload);
                  return { error: null };
                },
              }),
            }),
          };
        }
        if (table === "manager_property_records") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { row_data: { title: "4709A 8th Ave NE" } }, error: null }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      }),
    };

    const result = await reportResidentLeaseIssue(db as never, {
      residentUserId: "user-1",
      residentEmail: "resident@test.com",
      residentName: "Resident Test",
      leaseId: row.id,
      message: "Move-in date should be Oct 1.",
    });

    expect(result).toEqual({ ok: true });
    expect(update).toHaveBeenCalledOnce();
    const updated = (update.mock.calls[0]![0] as { row_data: LeasePipelineRow }).row_data;
    expect(updated.bucket).toBe("manager");
    expect(updated.status).toBe("Manager Review");
    expect(updated.thread?.at(-1)?.body).toContain("Move-in date should be Oct 1.");
    expect(deliverPortalInboxMessage).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        toUserIds: ["mgr-1"],
        eventCategory: "leases",
        subject: expect.stringContaining("Lease issue reported"),
      }),
    );
  });
});
