import { beforeEach, describe, expect, it, vi } from "vitest";

let managed = true;
vi.mock("@/lib/service/service-alert-targets.server", () => ({
  isManagedWorkspaceId: async (_db: unknown, ws: string | null) => managed && !!ws,
  serviceAlertPayerUserId: async () => "svc-owner",
}));
const platformSend = vi.fn(async (..._a: unknown[]) => ({ ok: true as const, sid: "SM1" }) as { ok: true; sid: string } | { ok: false; reason: string });
vi.mock("@/lib/one-number/lead-send.server", () => ({ sendPlatformLeadText: (...a: unknown[]) => platformSend(...a) }));
let claimOk = true;
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: claimOk }) }));

import { resolveSmsPayer, sendAsPropLaneAfterRefusal } from "@/lib/prospect-spine/payer.server";

const db = {} as never;
beforeEach(() => { managed = true; claimOk = true; platformSend.mockClear(); platformSend.mockResolvedValue({ ok: true, sid: "SM1" }); });

describe("resolveSmsPayer", () => {
  it("a managed workspace is paid by the service owner, a self-serve one by its owner", async () => {
    expect(await resolveSmsPayer(db, { ownerUserId: "client", workspaceId: "ws" })).toBe("svc-owner");
    managed = false;
    expect(await resolveSmsPayer(db, { ownerUserId: "client", workspaceId: "ws" })).toBe("client");
    expect(await resolveSmsPayer(db, { ownerUserId: "client", workspaceId: null })).toBe("client");
  });
});

describe("sendAsPropLaneAfterRefusal", () => {
  const input = { ownerUserId: "client", workspaceId: "ws", to: "+12065550188", body: "hi", claimKey: "k1" };
  const ELIGIBLE = [
    "credit_unavailable", "comms_billing_insufficient", "comms_billing_no_credit", "workspace_has_no_work_number",
    "number_missing", "number_not_active", "number_quarantined", "number_grace_expired", "provider_identity_mismatch",
  ];
  const NEVER = [
    "No conversation edit access.", "forbidden", "authorization", "That number has opted out of texts.", "recipient_opted_out",
    "opted_out", "quiet_hours", "shielded", "protected_account_shielded", "scoped_consent_missing", "communication_not_allowed",
    "communication_workspace_mismatch", "delivery_outcome_unknown", "duplicate", "empty_body", "invalid_message", "invalid_to",
    "runtime_paused", "control_plane_unreadable", "Not enough credit to send this text.", "", undefined, null,
  ];

  it.each(ELIGIBLE)("allowlisted code %s sends via PropLane for a managed workspace", async (refusalCode) => {
    expect(await sendAsPropLaneAfterRefusal(db, { ...input, refusalCode })).toEqual({ attempted: true, ok: true });
    expect(platformSend).toHaveBeenCalledTimes(1);
  });
  it.each(ELIGIBLE)("allowlisted code %s never sends for a self-serve workspace", async (refusalCode) => {
    managed = false;
    expect((await sendAsPropLaneAfterRefusal(db, { ...input, refusalCode })).attempted).toBe(false);
    expect(platformSend).not.toHaveBeenCalled();
  });
  it.each(NEVER)("code %j never falls back, even on a managed workspace", async (refusalCode) => {
    const r = await sendAsPropLaneAfterRefusal(db, { ...input, refusalCode: refusalCode as string | null | undefined });
    expect(r).toMatchObject({ attempted: false, ok: false });
    expect(platformSend).not.toHaveBeenCalled();
  });
  it("admin-owned managed workspace (owner === service owner) still falls back: managed is the is_service flag, not payer!=owner", async () => {
    expect(await sendAsPropLaneAfterRefusal(db, { ...input, ownerUserId: "svc-owner", refusalCode: "comms_billing_allowance_exhausted" })).toEqual({ attempted: true, ok: true });
    expect(platformSend).toHaveBeenCalledTimes(1);
  });
  it("self-serve workspace owned by anyone (even the service owner id) never falls back; a missing workspace fails closed", async () => {
    managed = false;
    expect(await sendAsPropLaneAfterRefusal(db, { ...input, ownerUserId: "svc-owner", refusalCode: "credit_unavailable" })).toMatchObject({ attempted: false, reason: "not_managed" });
    managed = true;
    expect(await sendAsPropLaneAfterRefusal(db, { ...input, workspaceId: null, refusalCode: "credit_unavailable" })).toMatchObject({ attempted: false });
    expect(platformSend).not.toHaveBeenCalled();
  });
  it("a retried reply never texts twice and is never reported as sent", async () => {
    claimOk = false;
    expect(await sendAsPropLaneAfterRefusal(db, { ...input, refusalCode: "credit_unavailable" })).toEqual({ attempted: true, ok: false, reason: "already_attempted" });
    expect(platformSend).not.toHaveBeenCalled();
  });
  it("reports the provider reason when PropLane's own send fails", async () => {
    platformSend.mockResolvedValue({ ok: false, reason: "provider_error" });
    expect(await sendAsPropLaneAfterRefusal(db, { ...input, refusalCode: "credit_unavailable" })).toEqual({ attempted: true, ok: false, reason: "provider_error" });
  });
  it("never throws", async () => {
    platformSend.mockRejectedValue(new Error("boom"));
    expect(await sendAsPropLaneAfterRefusal(db, { ...input, refusalCode: "credit_unavailable" })).toMatchObject({ attempted: true, ok: false });
  });
});
