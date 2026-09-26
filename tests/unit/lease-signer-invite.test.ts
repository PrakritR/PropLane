import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: vi.fn() }));
vi.mock("@/lib/manager-outbound-identity.server", () => ({
  managerOutboundFromHeader: vi.fn(async () => "PropLane <notify@proplane.test>"),
}));

import { postResendEmail } from "@/lib/resend-delivery.server";
import { classifySignerInviteRole, sendLeaseSignerInvite } from "@/lib/lease-signer-invite.server";

/**
 * C278 — the Sign step's optional representative / legal representative /
 * guarantor fields become invite-by-email. Integrator review flagged a
 * signed-in resident being able to send a from-PropLane email to any address
 * with an arbitrary role and their own chosen display name, unthrottled —
 * this covers each closed hole: role classified against a fixed allowlist
 * (never the caller's raw string), resident name sourced only from the
 * trusted lease row and sanitized, and both a per-resident and a
 * per-(lease, role) rate limit.
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

let uniqueSeq = 0;
/** A fresh resident/lease id pair per call, so rate-limit buckets from one test never bleed into another. */
function freshInput(overrides: Partial<Parameters<typeof sendLeaseSignerInvite>[1]> = {}) {
  uniqueSeq += 1;
  return {
    residentUserId: `user-${uniqueSeq}`,
    residentEmail: `resident${uniqueSeq}@test.com`,
    leaseId: `lease-${uniqueSeq}`,
    roleLabel: "Licensee's representative (optional)",
    inviteEmail: "rep@example.com",
    ...overrides,
  };
}

describe("classifySignerInviteRole", () => {
  it("matches the wizard's three known optional-signer fields, case-insensitively", () => {
    expect(classifySignerInviteRole("Licensee's representative (optional)")).toEqual({ id: "representative", label: "Representative" });
    expect(classifySignerInviteRole("licensee's LEGAL REPRESENTATIVE (optional)")).toEqual({
      id: "legal_representative",
      label: "Legal representative",
    });
    expect(classifySignerInviteRole("Personal guarantee of payment — guarantor name (optional)")).toEqual({
      id: "guarantor",
      label: "Guarantor",
    });
  });

  it("checks legal representative before the plainer representative pattern", () => {
    // "legal representative" also contains the substring "representative" — the more
    // specific pattern must win, or every legal-rep field would be misfiled.
    expect(classifySignerInviteRole("Legal representative")?.id).toBe("legal_representative");
  });

  it("refuses anything outside the fixed allowlist", () => {
    expect(classifySignerInviteRole("Licensee signature")).toBeNull();
    expect(classifySignerInviteRole("Emergency contact")).toBeNull();
    expect(classifySignerInviteRole("")).toBeNull();
    expect(classifySignerInviteRole("   ")).toBeNull();
  });
});

describe("sendLeaseSignerInvite", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.RESEND_API_KEY;
  });

  it("sends a one-way notice email using only the canonical role label", async () => {
    process.env.RESEND_API_KEY = "test-key";
    vi.mocked(postResendEmail).mockResolvedValue(new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));
    const input = freshInput();
    const db = dbFor(lease(), { residentUserId: input.residentUserId, residentEmail: input.residentEmail });

    const result = await sendLeaseSignerInvite(db as never, input);

    expect(result).toEqual({ ok: true });
    expect(postResendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: input.residentUserId,
        payload: expect.objectContaining({
          to: ["rep@example.com"],
          // The canonical label, never the raw "(optional)"-suffixed field text.
          subject: expect.stringContaining("Representative"),
          text: expect.stringContaining("Resident Test"),
        }),
      }),
    );
    const [[call]] = vi.mocked(postResendEmail).mock.calls;
    expect(call.payload.subject).not.toContain("optional");
    expect(call.payload.text).not.toContain("optional");
  });

  it("refuses a role outside the fixed allowlist without sending or touching the database", async () => {
    process.env.RESEND_API_KEY = "test-key";
    const input = freshInput({ roleLabel: "Emergency contact" });
    const db = dbFor(lease());

    const result = await sendLeaseSignerInvite(db as never, input);

    expect(result).toEqual({ ok: false, error: "This field cannot be invited by email." });
    expect(postResendEmail).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it("refuses an invalid email without sending anything", async () => {
    process.env.RESEND_API_KEY = "test-key";
    const input = freshInput({ inviteEmail: "not-an-email" });
    const db = dbFor(lease());

    const result = await sendLeaseSignerInvite(db as never, input);

    expect(result).toEqual({ ok: false, error: "Enter a valid email to invite." });
    expect(postResendEmail).not.toHaveBeenCalled();
  });

  it("refuses a lease belonging to another resident", async () => {
    process.env.RESEND_API_KEY = "test-key";
    const input = freshInput();
    const db = dbFor(lease(), { residentUserId: "other-user", residentEmail: input.residentEmail });

    const result = await sendLeaseSignerInvite(db as never, input);

    expect(result).toEqual({ ok: false, error: "Lease not found." });
    expect(postResendEmail).not.toHaveBeenCalled();
  });

  it("refuses once the resident has already signed", async () => {
    process.env.RESEND_API_KEY = "test-key";
    const input = freshInput();
    const db = dbFor(
      lease({ residentSignature: { role: "resident", name: "Resident Test", signedAtIso: "2026-09-05T00:00:00.000Z" } }),
      { residentUserId: input.residentUserId, residentEmail: input.residentEmail },
    );

    const result = await sendLeaseSignerInvite(db as never, input);

    expect(result).toEqual({ ok: false, error: "This lease is not open for signing right now." });
    expect(postResendEmail).not.toHaveBeenCalled();
  });

  it("refuses a lease that never went through the lease-first flow", async () => {
    process.env.RESEND_API_KEY = "test-key";
    const input = freshInput();
    const db = dbFor(lease({ leaseFirst: undefined }), { residentUserId: input.residentUserId, residentEmail: input.residentEmail });

    const result = await sendLeaseSignerInvite(db as never, input);

    expect(result).toEqual({ ok: false, error: "This lease is not open for signing right now." });
  });

  it("refuses when email delivery is not configured", async () => {
    const input = freshInput();
    const db = dbFor(lease(), { residentUserId: input.residentUserId, residentEmail: input.residentEmail });

    const result = await sendLeaseSignerInvite(db as never, input);

    expect(result).toEqual({ ok: false, error: "Email delivery is not configured." });
    expect(postResendEmail).not.toHaveBeenCalled();
  });

  it("strips URLs and newlines from the resident's name and caps its length before it reaches the email", async () => {
    process.env.RESEND_API_KEY = "test-key";
    vi.mocked(postResendEmail).mockResolvedValue(new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));
    const input = freshInput();
    const maliciousName = `Click http://evil.example/phish\nnow ${"A".repeat(200)}`;
    const db = dbFor(lease({ residentName: maliciousName }), { residentUserId: input.residentUserId, residentEmail: input.residentEmail });

    const result = await sendLeaseSignerInvite(db as never, input);

    expect(result).toEqual({ ok: true });
    const [[call]] = vi.mocked(postResendEmail).mock.calls;
    expect(call.payload.subject).not.toContain("http");
    expect(call.payload.text).not.toContain("http");
    expect(call.payload.subject).not.toContain("\n");
    // The 200-char run is truncated well before it all comes through (capped at 100).
    expect(call.payload.text).not.toContain("A".repeat(200));
    expect(call.payload.text.match(/A+/)?.[0]?.length ?? 0).toBeLessThanOrEqual(100);
  });

  it("never sources the resident's name from the caller — only the lease row's own residentName field", async () => {
    process.env.RESEND_API_KEY = "test-key";
    vi.mocked(postResendEmail).mockResolvedValue(new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));
    const input = freshInput();
    // Even if a caller tried to pass a display name, the function signature has no such
    // field any more — this asserts the lease row's name is what actually appears.
    const db = dbFor(lease({ residentName: "Trusted Lease Name" }), {
      residentUserId: input.residentUserId,
      residentEmail: input.residentEmail,
    });

    await sendLeaseSignerInvite(db as never, input);

    const [[call]] = vi.mocked(postResendEmail).mock.calls;
    expect(call.payload.text).toContain("Trusted Lease Name");
  });

  it("blocks the 6th invite from one resident within 24 hours", async () => {
    process.env.RESEND_API_KEY = "test-key";
    vi.mocked(postResendEmail).mockResolvedValue(new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));
    const residentUserId = "rate-user-1";
    const residentEmail = "rate1@test.com";

    for (let i = 0; i < 5; i++) {
      const input = freshInput({ residentUserId, residentEmail, inviteEmail: `rep${i}@example.com` });
      const db = dbFor(lease({ id: input.leaseId }), { residentUserId, residentEmail });
      const result = await sendLeaseSignerInvite(db as never, input);
      expect(result).toEqual({ ok: true });
    }

    const sixthInput = freshInput({ residentUserId, residentEmail });
    const sixthDb = dbFor(lease({ id: sixthInput.leaseId }), { residentUserId, residentEmail });
    const sixthResult = await sendLeaseSignerInvite(sixthDb as never, sixthInput);

    expect(sixthResult).toEqual({
      ok: false,
      error: "You can send at most 5 invites in 24 hours. Try again later.",
      status: 429,
    });
  });

  it("blocks a second invite for the same lease and role within 24 hours, even for a different email", async () => {
    process.env.RESEND_API_KEY = "test-key";
    vi.mocked(postResendEmail).mockResolvedValue(new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));
    const input = freshInput();
    const db = dbFor(lease({ id: input.leaseId }), { residentUserId: input.residentUserId, residentEmail: input.residentEmail });
    const first = await sendLeaseSignerInvite(db as never, input);
    expect(first).toEqual({ ok: true });

    const second = await sendLeaseSignerInvite(db as never, { ...input, inviteEmail: "someone-else@example.com" });

    expect(second).toEqual({
      ok: false,
      error: "An invite for representative on this lease was already sent in the last 24 hours.",
      status: 429,
    });
  });

  it("allows a second invite for the SAME lease under a DIFFERENT role", async () => {
    process.env.RESEND_API_KEY = "test-key";
    vi.mocked(postResendEmail).mockResolvedValue(new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));
    const input = freshInput();
    const db = dbFor(lease({ id: input.leaseId }), { residentUserId: input.residentUserId, residentEmail: input.residentEmail });
    const first = await sendLeaseSignerInvite(db as never, input);
    expect(first).toEqual({ ok: true });

    const second = await sendLeaseSignerInvite(db as never, {
      ...input,
      roleLabel: "Licensee's legal representative (optional)",
      inviteEmail: "legalrep@example.com",
    });

    expect(second).toEqual({ ok: true });
  });
});
