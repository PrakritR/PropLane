/**
 * `sendResidentOutboundSms` carries the workspace pin of a text about ONE house to the transport (so the dispatcher
 * sends from that workspace's line and bills its owner), never mirrors when asked not to, and returns the outbox row
 * a queued/deferred text can be followed by.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sends: [] as Array<Record<string, unknown>>,
  result: { ok: true, sid: "SM1", channel: "twilio" } as Record<string, unknown>,
  mirrored: [] as unknown[],
  opened: [] as unknown[],
}));

vi.mock("@/lib/proplane-sms-transport.server", () => ({
  isClawTransportEnabled: () => false,
  sendPropLaneSms: async (args: Record<string, unknown>) => {
    h.sends.push(args);
    return h.result;
  },
}));
vi.mock("@/lib/claw-resident-messaging.server", () => ({
  openClawResidentThread: async (args: unknown) => void h.opened.push(args),
  mirrorAutomatedResidentSmsToManager: async (args: unknown) => void h.mirrored.push(args),
}));
vi.mock("@/lib/sms-consent", () => ({ isPhoneOptedOut: async () => false }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));

import { sendResidentOutboundSms } from "@/lib/resident-outbound-sms.server";

beforeEach(() => {
  h.sends = [];
  h.mirrored = [];
  h.opened = [];
  h.result = { ok: true, sid: "SM1", channel: "twilio" };
});

const base = {
  to: "2065550101",
  text: "Water off Thursday",
  openThread: { managerUserId: "owner-1", residentUserId: "res-1", residentEmail: "r@example.com", topic: "general" as const },
};

describe("sendResidentOutboundSms: a text about one house", () => {
  it("passes the house, workspace, actor and pinned line to the transport; the log identity is the OWNER", async () => {
    await sendResidentOutboundSms({
      ...base,
      fromNumber: "+12065550222",
      propertyId: "h-b",
      workspaceId: "ws-b",
      actorUserId: "mate-1",
      selectedWorkLineId: "num-b",
      recipientUserId: "res-1",
      mirrorToManager: false,
    });
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toMatchObject({
      propertyId: "h-b",
      workspaceId: "ws-b",
      actorUserId: "mate-1",
      selectedWorkLineId: "num-b",
      recipientUserId: "res-1",
      log: { managerUserId: "owner-1", residentUserId: "res-1" },
    });
  });

  it("omits the pin when it is not given, exactly as before", async () => {
    await sendResidentOutboundSms({ ...base });
    for (const key of ["propertyId", "workspaceId", "actorUserId", "selectedWorkLineId", "recipientUserId"]) {
      expect(h.sends[0]).not.toHaveProperty(key);
    }
  });

  it("does not carbon-copy the manager when mirrorToManager is false", async () => {
    await sendResidentOutboundSms({ ...base, mirrorToManager: false });
    expect(h.mirrored).toHaveLength(0);
    await sendResidentOutboundSms({ ...base, mirrorToManager: true });
    expect(h.mirrored).toHaveLength(1);
  });

  it("returns the outbox row of a text that was only accepted", async () => {
    h.result = { ok: false, error: "deferred", durablyAccepted: true, outboxId: "ob-1", outboxStatus: "deferred" };
    const result = await sendResidentOutboundSms({ ...base });
    expect(result).toMatchObject({ sent: false, accepted: true, outboxId: "ob-1", outboxStatus: "deferred" });
  });
});
