import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";

const { sendEmail, sendSms, reachability, outboundFrom } = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  sendSms: vi.fn(),
  reachability: vi.fn(),
  outboundFrom: vi.fn(),
}));

vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: sendEmail }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms: sendSms }));
vi.mock("@/lib/manager-reachability-for-resident.server", () => ({ resolveManagerReachabilityForResident: reachability }));
vi.mock("@/lib/manager-outbound-identity.server", () => ({ managerOutboundFromHeader: outboundFrom }));

import {
  attachResidentSetupToken,
  ensureResidentSetupTokenForApplication,
  isResidentSetupTokenValid,
} from "@/lib/auth/resident-setup-token";
import { openApplicantRow } from "@/lib/security/applicant-identity";
import { deliverExistingResidentWelcome, deliverResidentWelcome } from "@/lib/resident-welcome.server";

const actor = { userId: "manager-1", email: "manager@example.com" };
const input = { to: "resident@example.com", residentName: "Resident", axisId: "PROPLANE-SETUP01" };

function application(overrides: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: input.axisId,
    name: input.residentName,
    email: input.to,
    property: "House",
    stage: "Approved",
    bucket: "approved",
    detail: "Approved",
    managerUserId: actor.userId,
    ...overrides,
  };
}

function database(row = application()) {
  const tokenWrite = vi.fn().mockResolvedValue({ error: null });
  const inboxWrite = vi.fn().mockResolvedValue({ error: null });
  const applicationQuery = {
    in: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({
      data: [{ id: row.id, resident_email: row.email, row_data: row, manager_user_id: actor.userId }],
      error: null,
    }),
  };
  const profileQuery = {
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { phone: "+12065550142", full_name: "Manager" }, error: null }),
  };
  const from = vi.fn((table: string) => {
    if (table === "manager_application_records") return { select: () => applicationQuery, upsert: tokenWrite };
    if (table === "portal_inbox_thread_records") return { upsert: inboxWrite };
    if (table === "profiles") return { select: () => profileQuery };
    throw new Error(`Unexpected table: ${table}`);
  });
  return { db: { from } as unknown as SupabaseClient, from, tokenWrite, inboxWrite, applicationQuery };
}

describe("resident setup token persistence", () => {
  it("returns failure without a raw credential when the database rejects the token write", async () => {
    const { db, tokenWrite, applicationQuery } = database();
    tokenWrite.mockResolvedValue({ error: { message: "write unavailable" } });

    const result = await ensureResidentSetupTokenForApplication(db, input.axisId, { managerUserId: actor.userId });

    expect(result).toEqual({ ok: false, error: "write unavailable" });
    expect(applicationQuery.eq).toHaveBeenCalledWith("manager_user_id", actor.userId);
    expect(tokenWrite).toHaveBeenCalledOnce();
  });

  it("returns a token that validates against the persisted sealed application", async () => {
    const { db, tokenWrite } = database();
    const result = await ensureResidentSetupTokenForApplication(db, input.axisId, { managerUserId: actor.userId });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const saved = tokenWrite.mock.calls[0][0];
    const persisted = openApplicantRow(saved.row_data, saved.id);
    expect(isResidentSetupTokenValid(persisted, result.token)).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(result.token);
  });

  it("reuses an already persisted valid token without requiring another write", async () => {
    const { row, token } = attachResidentSetupToken(application());
    const { db, tokenWrite } = database(row);
    tokenWrite.mockResolvedValue({ error: { message: "write unavailable" } });
    const result = await ensureResidentSetupTokenForApplication(db, row.id, {
      managerUserId: actor.userId,
      preferredToken: token,
    });

    expect(result).toMatchObject({ ok: true, token });
    expect(tokenWrite).not.toHaveBeenCalled();
  });

  it("does not fall back to an expired preferred token when replacement persistence fails", async () => {
    const { row, token } = attachResidentSetupToken(application(), { now: new Date(0), ttlMs: 1 });
    const { db, tokenWrite } = database(row);
    tokenWrite.mockResolvedValue({ error: { message: "write unavailable" } });
    const result = await ensureResidentSetupTokenForApplication(db, row.id, { preferredToken: token });

    expect(result).toEqual({ ok: false, error: "write unavailable" });
  });
});

describe("welcome delivery requires a persisted setup credential", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RESEND_API_KEY", "unit-test-key");
    sendEmail.mockImplementation(async () => new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    sendSms.mockResolvedValue({ ok: true });
    reachability.mockResolvedValue({ email: "", phone: "" });
    outboundFrom.mockResolvedValue("Manager <manager@example.com>");
  });
  afterEach(() => vi.unstubAllEnvs());

  for (const [label, deliver] of [
    ["approved applicant", deliverResidentWelcome],
    ["manager-added resident", deliverExistingResidentWelcome],
  ] as const) {
    it(`stops every delivery for a ${label} when token persistence fails`, async () => {
      const { db, tokenWrite, inboxWrite, from } = database(application({ residentUserId: "existing-auth-user" }));
      tokenWrite.mockResolvedValue({ error: { message: "write unavailable" } });

      const result = await deliver(db, actor, input);

      expect(result).toMatchObject({ ok: false, status: 503, mailtoHref: "" });
      expect(sendEmail).not.toHaveBeenCalled();
      expect(sendSms).not.toHaveBeenCalled();
      expect(inboxWrite).not.toHaveBeenCalled();
      expect(reachability).not.toHaveBeenCalled();
      expect(from.mock.calls.every(([table]) => table === "manager_application_records")).toBe(true);
    });

    it(`does not fabricate a setup invitation for a missing ${label} application`, async () => {
      const { db, tokenWrite, inboxWrite, applicationQuery } = database();
      applicationQuery.limit.mockResolvedValue({ data: [], error: null });

      const result = await deliver(db, actor, input);

      expect(result).toMatchObject({ ok: false, status: 503, mailtoHref: "" });
      expect(tokenWrite).not.toHaveBeenCalled();
      expect(sendEmail).not.toHaveBeenCalled();
      expect(sendSms).not.toHaveBeenCalled();
      expect(inboxWrite).not.toHaveBeenCalled();
    });

    it(`sends a working link for a ${label} after successful persistence`, async () => {
      const { db, tokenWrite, inboxWrite } = database(application({ residentUserId: "existing-auth-user" }));

      const result = await deliver(db, actor, input);

      expect(result).toMatchObject({ ok: true, id: "email-1", skipped: false });
      const text = sendEmail.mock.calls[0][0].payload.text as string;
      const link = new URL(text.match(/https?:\/\/\S+\/auth\/resident-setup\?\S+/)![0]);
      const saved = tokenWrite.mock.calls[0][0];
      expect(isResidentSetupTokenValid(openApplicantRow(saved.row_data, saved.id), link.searchParams.get("token")!)).toBe(true);
      expect(link.searchParams.get("proplane_id")).toBe(input.axisId);
      expect(inboxWrite).toHaveBeenCalledTimes(2);
    });
  }

  it("does not send a broken setup link by SMS to a placeholder-email tenant", async () => {
    const row = application({ email: "resident@import.proplane.local", manuallyAdded: true });
    const { db, tokenWrite, inboxWrite } = database(row);
    tokenWrite.mockResolvedValue({ error: { message: "write unavailable" } });

    const result = await deliverExistingResidentWelcome(db, actor, {
      ...input,
      to: row.email!,
      residentPhone: "+12065550142",
      channels: { viaEmail: false, viaSms: true, viaInbox: false },
    });

    expect(result).toMatchObject({ ok: false, status: 503, mailtoHref: "" });
    expect(sendSms).not.toHaveBeenCalled();
    expect(inboxWrite).not.toHaveBeenCalled();
  });
});
