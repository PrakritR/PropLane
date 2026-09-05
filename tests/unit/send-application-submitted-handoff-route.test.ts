import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";

/**
 * The guest wizard depends on this route for the "Create your resident account"
 * handoff. Two properties matter:
 *  - `setupHref` is returned even when email delivery is unconfigured (503), so a
 *    missing Resend key never strips the finish-screen CTA;
 *  - a caller-supplied, still-valid `setupToken` is reused verbatim (no rotation),
 *    so the emailed link matches the one already shown on the finish screen.
 */

const { ensureMock, serviceRows, smsMock } = vi.hoisted(() => ({
  ensureMock: vi.fn(),
  serviceRows: [] as Array<{ id: string; resident_email: string; row_data: unknown; manager_user_id: string | null }>,
  smsMock: vi.fn(),
}));

vi.mock("@/lib/auth/resident-setup-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/resident-setup-token")>();
  return { ...actual, ensureResidentSetupTokenForApplication: ensureMock };
});

vi.mock("@/lib/application-lifecycle-sms.server", () => ({
  notifyApplicantApplicationSms: smsMock,
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "manager_application_records") {
        return {
          select: () => ({ in: () => Promise.resolve({ data: serviceRows, error: null }) }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import { attachResidentSetupToken } from "@/lib/auth/resident-setup-token";
import { POST } from "@/app/api/portal/send-application-submitted/route";

function baseRow(): DemoApplicantRow {
  return {
    id: "PROPLANE-SEND01",
    name: "Sam Ortiz",
    property: "House",
    stage: "Submitted",
    bucket: "pending",
    detail: "Submitted",
    email: "sam@example.com",
    propertyId: "prop-1",
    application: {
      phone: "2065550142",
      smsConsent: true,
      smsConsentAt: "2026-09-04T12:00:00.000Z",
    } as never,
  };
}

function post(body: unknown) {
  return new Request("http://localhost/api/portal/send-application-submitted", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250) + 1}` },
    body: JSON.stringify(body),
  });
}

describe("POST /api/portal/send-application-submitted — setup handoff", () => {
  beforeEach(() => {
    ensureMock.mockReset();
    smsMock.mockReset();
    smsMock.mockResolvedValue({ sent: true, accepted: true });
    serviceRows.length = 0;
    vi.stubEnv("RESEND_API_KEY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns setupHref on a 503 (email not configured) and reuses the provided token without rotating", async () => {
    const { row, token } = attachResidentSetupToken(baseRow());
    serviceRows.push({ id: row.id, resident_email: row.email!, row_data: row, manager_user_id: "mgr-1" });

    const res = await POST(
      post({ email: row.email, axisId: row.id, includeSetupHandoff: true, setupToken: token }),
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { setupHref?: string; error?: string };
    expect(body.setupHref).toBe(`/auth/resident-setup?token=${token}&proplane_id=${row.id}`);
    // Reused the caller's valid token → never minted a fresh one.
    expect(ensureMock).not.toHaveBeenCalled();
    expect(smsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: "submitted",
        managerUserId: "mgr-1",
        dedupeKey: `application_submitted_confirmation_${row.id}`,
      }),
    );
  });

  it("rotates a fresh token when the caller provides none", async () => {
    const { row } = attachResidentSetupToken(baseRow());
    serviceRows.push({ id: row.id, resident_email: row.email!, row_data: row, manager_user_id: "mgr-1" });
    ensureMock.mockResolvedValue({ ok: true, token: "rotated-token", axisId: row.id, email: row.email, row });

    const res = await POST(post({ email: row.email, axisId: row.id, includeSetupHandoff: true }));

    expect(res.status).toBe(503);
    const body = (await res.json()) as { setupHref?: string };
    expect(ensureMock).toHaveBeenCalledOnce();
    expect(body.setupHref).toBe(`/auth/resident-setup?token=rotated-token&proplane_id=${row.id}`);
  });

  it("does not mark a failed SMS as sent and logs the non-PII failure reason", async () => {
    const { row, token } = attachResidentSetupToken(baseRow());
    serviceRows.push({ id: row.id, resident_email: row.email!, row_data: row, manager_user_id: "mgr-1" });
    smsMock.mockResolvedValue({ sent: false, accepted: false, error: "runtime_env_paused" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await POST(post({ email: row.email, axisId: row.id, setupToken: token }));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual(expect.objectContaining({ smsSent: false, smsAccepted: false }));
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("runtime_env_paused"));
    expect(logged).not.toHaveBeenCalledWith(expect.stringContaining(row.email!));
  });

  it("does not attempt SMS when the stored application did not opt in", async () => {
    const { row, token } = attachResidentSetupToken({
      ...baseRow(),
      application: { phone: "2065550142", smsConsent: false } as never,
    });
    serviceRows.push({ id: row.id, resident_email: row.email!, row_data: row, manager_user_id: "mgr-1" });

    const res = await POST(post({ email: row.email, axisId: row.id, setupToken: token }));

    expect(res.status).toBe(503);
    expect(smsMock).not.toHaveBeenCalled();
  });
});
