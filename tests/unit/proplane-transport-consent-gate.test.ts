import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendClawMock, optedOutMock, quietHoursMock, sendSmsMock } = vi.hoisted(() => ({
  sendClawMock: vi.fn(async () => ({ ok: true as const, messageId: "claw1" })),
  optedOutMock: vi.fn(async () => false),
  quietHoursMock: vi.fn(() => false),
  sendSmsMock: vi.fn(async () => ({ sent: true as const, sid: "SM1" })),
}));

vi.mock("@/lib/claw-messenger.server", () => ({
  isClawMessengerConfigured: () => true,
  normalizeE164Us: (x: string) => x,
  registerClawMessengerRoute: vi.fn(async () => undefined),
  sendClawMessengerText: sendClawMock,
}));
vi.mock("@/lib/sms-consent", () => ({ isPhoneOptedOut: optedOutMock }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/twilio", () => ({ normalizeE164: (x: string) => x, sendSms: sendSmsMock }));
vi.mock("@/lib/claw-leasing-links", () => ({
  clawLeasingAgentPhoneE164: () => "+12053690702",
  isClawSharedLineBridgeEnabled: () => true,
  managerContactSmsPhoneForPublicCta: (x: string | null) => x ?? null,
}));
vi.mock("@/lib/sms/number-registration-policy", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, quietHoursBlocks: quietHoursMock };
});

import { sendPropLaneSms } from "@/lib/proplane-sms-transport.server";

beforeEach(() => {
  sendClawMock.mockClear();
  optedOutMock.mockReset().mockResolvedValue(false);
  quietHoursMock.mockReset().mockReturnValue(false);
});

describe("sendPropLaneSms consent gate on the Claw path (campaign-rejection fix)", () => {
  it("rejects a durable retired-rail reply before consent or any provider call", async () => {
    const res = await sendPropLaneSms({
      to: "+12065552222",
      text: "hi",
      prospectBurst: { burstId: "burst-retired", revision: 1, workerId: "worker", transport: "claw" },
    });
    expect(res).toEqual({ ok: false, channel: "claw", error: "retired_transport_unsupported" });
    expect(optedOutMock).not.toHaveBeenCalled();
    expect(sendClawMock).not.toHaveBeenCalled();
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("blocks an opted-out recipient BEFORE the Claw send", async () => {
    optedOutMock.mockResolvedValue(true);
    const res = await sendPropLaneSms({ to: "+12065552222", text: "hi", sendClass: "automated" });
    expect(res).toMatchObject({ ok: false, error: "recipient_opted_out" });
    expect(sendClawMock).not.toHaveBeenCalled();
  });

  it("sends when the recipient has not opted out", async () => {
    const res = await sendPropLaneSms({ to: "+12065552222", text: "hi", sendClass: "transactional" });
    expect(res.ok).toBe(true);
    expect(sendClawMock).toHaveBeenCalledTimes(1);
  });

  it("control messages (STOP/HELP replies) bypass the opt-out check", async () => {
    optedOutMock.mockResolvedValue(true);
    const res = await sendPropLaneSms({ to: "+12065552222", text: "You are unsubscribed.", sendClass: "control" });
    expect(res.ok).toBe(true);
    expect(optedOutMock).not.toHaveBeenCalled();
  });
});

describe("sendPropLaneSms quiet hours", () => {
  it("suppresses automated traffic during quiet hours but not transactional", async () => {
    quietHoursMock.mockImplementation((cls: string) => cls === "automated");

    const automated = await sendPropLaneSms({ to: "+12065552222", text: "rent reminder", sendClass: "automated" });
    expect(automated).toMatchObject({ ok: false, error: "quiet_hours" });
    expect(sendClawMock).not.toHaveBeenCalled();

    const txn = await sendPropLaneSms({ to: "+12065552222", text: "reply", sendClass: "transactional" });
    expect(txn.ok).toBe(true);
  });
});
