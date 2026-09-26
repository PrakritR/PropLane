import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: vi.fn() }));
vi.mock("@/lib/manager-outbound-identity.server", () => ({
  managerOutboundFromHeader: vi.fn(async () => "PropLane <notify@proplane.test>"),
}));

import { postResendEmail } from "@/lib/resend-delivery.server";
import { sendLeaseSignerInvite } from "@/lib/lease-signer-invite.server";

/**
 * C278 — the Sign step's optional representative / legal representative /
 * guarantor fields become invite-by-email. This covers the server-side
 * contract: only the resident who owns the lease, only while it is actually
 * open on the lease-first Sign step, only with a real email, and the send
 * itself never touches the lease row (no new table, no new auth surface).
 */

function lease(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return {
    id: "lease-1",
    residentEmail: "resident@test.com",
    residentName: "Resident Test",
    propertyId: "prop-1",
    unit: "Room 2",
    status: "Resident Signature Pending",
    bucket: "resident",
    leaseFirst: true,
    generatedHtml: "<p>Lease</p>",
    managerUserId: "mgr-1",
    ...overrides,
  } as LeasePipelineRow;
}

function dbFor(row: LeasePipelineRow, identity: { managerUserId?: string; residentEmail?: string; residentUserId?: string } = {}) {
  return {
    from: vi.fn((table: string) => {
      if (table === "portal_lease_pipeline_records") {
        return {
          select: () => ({
            eq: () => ({
              or: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: row.id,
                    row_data: row,
                    manager_user_id: identity.managerUserId ?? "mgr-1",
                    resident_email: identity.residentEmail ?? "resident@test.com",
                    resident_user_id: identity.residentUserId ?? "user-1",
                  },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };
}

const baseInput = {
  residentUserId: "user-1",
  residentEmail: "resident@test.com",
  residentName: "Resident Test",
  leaseId: "lease-1",
  roleLabel: "Licensee's representative",
  inviteEmail: "rep@example.com",
};

describe("sendLeaseSignerInvite", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.RESEND_API_KEY;
  });

  it("sends a one-way notice email and never writes to the lease row", async () => {
    process.env.RESEND_API_KEY = "test-key";
    vi.mocked(postResendEmail).mockResolvedValue(new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));
    const db = dbFor(lease());

    const result = await sendLeaseSignerInvite(db as never, baseInput);

    expect(result).toEqual({ ok: true });
    expect(postResendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "user-1",
        payload: expect.objectContaining({
          to: ["rep@example.com"],
          subject: expect.stringContaining("Licensee's representative"),
          text: expect.stringContaining("Resident Test"),
        }),
      }),
    );
    // The only Supabase call is the read that verifies ownership — no update, no new table.
    expect((db.from as ReturnType<typeof vi.fn>).mock.calls.every(([table]) => table === "portal_lease_pipeline_records")).toBe(true);
  });

  it("refuses an invalid email without sending anything", async () => {
    process.env.RESEND_API_KEY = "test-key";
    const db = dbFor(lease());

    const result = await sendLeaseSignerInvite(db as never, { ...baseInput, inviteEmail: "not-an-email" });

    expect(result).toEqual({ ok: false, error: "Enter a valid email to invite." });
    expect(postResendEmail).not.toHaveBeenCalled();
  });

  it("refuses a lease belonging to another resident", async () => {
    process.env.RESEND_API_KEY = "test-key";
    const db = dbFor(lease(), { residentUserId: "other-user", residentEmail: "resident@test.com" });

    const result = await sendLeaseSignerInvite(db as never, baseInput);

    expect(result).toEqual({ ok: false, error: "Lease not found." });
    expect(postResendEmail).not.toHaveBeenCalled();
  });

  it("refuses once the resident has already signed", async () => {
    process.env.RESEND_API_KEY = "test-key";
    const db = dbFor(
      lease({ residentSignature: { role: "resident", name: "Resident Test", signedAtIso: "2026-09-05T00:00:00.000Z" } }),
    );

    const result = await sendLeaseSignerInvite(db as never, baseInput);

    expect(result).toEqual({ ok: false, error: "This lease is not open for signing right now." });
    expect(postResendEmail).not.toHaveBeenCalled();
  });

  it("refuses a lease that never went through the lease-first flow", async () => {
    process.env.RESEND_API_KEY = "test-key";
    const db = dbFor(lease({ leaseFirst: undefined }));

    const result = await sendLeaseSignerInvite(db as never, baseInput);

    expect(result).toEqual({ ok: false, error: "This lease is not open for signing right now." });
  });

  it("refuses when email delivery is not configured", async () => {
    const db = dbFor(lease());

    const result = await sendLeaseSignerInvite(db as never, baseInput);

    expect(result).toEqual({ ok: false, error: "Email delivery is not configured." });
    expect(postResendEmail).not.toHaveBeenCalled();
  });
});
