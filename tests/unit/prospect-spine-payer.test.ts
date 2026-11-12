import { beforeEach, describe, expect, it, vi } from "vitest";

let managed = true;
vi.mock("@/lib/service/service-alert-targets.server", () => ({
  isManagedWorkspaceId: async () => managed,
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
  it("a managed workspace whose wallet refused is sent by PropLane", async () => {
    expect(await sendAsPropLaneAfterRefusal(db, { ...input, refusal: "comms_billing_insufficient" })).toEqual({ attempted: true, ok: true });
    expect(platformSend).toHaveBeenCalledTimes(1);
  });
  it("never overrides STOP or quiet hours", async () => {
    for (const refusal of ["recipient_opted_out", "quiet_hours"]) {
      expect((await sendAsPropLaneAfterRefusal(db, { ...input, refusal })).attempted).toBe(false);
    }
    expect(platformSend).not.toHaveBeenCalled();
  });
  it("a self-serve workspace stays fail-closed", async () => {
    managed = false;
    expect((await sendAsPropLaneAfterRefusal(db, { ...input, refusal: "comms_billing_insufficient" })).attempted).toBe(false);
  });
  it("a retried reply never texts twice", async () => {
    claimOk = false;
    expect(await sendAsPropLaneAfterRefusal(db, input)).toMatchObject({ attempted: true, ok: true, reason: "already_sent" });
    expect(platformSend).not.toHaveBeenCalled();
  });
  it("reports the provider reason when PropLane's own send fails", async () => {
    platformSend.mockResolvedValue({ ok: false, reason: "provider_error" });
    expect(await sendAsPropLaneAfterRefusal(db, input)).toEqual({ attempted: true, ok: false, reason: "provider_error" });
  });
});
