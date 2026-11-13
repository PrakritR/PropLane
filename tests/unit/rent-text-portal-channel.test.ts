import { beforeEach, describe, expect, it, vi } from "vitest";

const channel = vi.fn();
const sendWorkspaceText = vi.fn();
vi.mock("@/lib/resident-notice-channel.server", () => ({ residentNoticeChannel: (...a: unknown[]) => channel(...a) }));
vi.mock("@/lib/one-number/link-text.server", () => ({ sendWorkspaceText: (...a: unknown[]) => sendWorkspaceText(...a) }));
vi.mock("@/lib/one-number/link-destinations.server", () => ({ resolveWorkspaceForProperty: async () => "ws_1" }));

import { sendResidentRentText } from "@/lib/payments/rent-text-send.server";

const input = {
  ownerUserId: "mgr_1", propertyId: "p1", phone: "2065550100", body: "Rent due", purpose: "payment_reminder",
  sendClass: "transactional" as const, idempotencyKey: "k", residentUserId: "res_1", residentEmail: "r@x.com",
};

describe("rent texts honour the notice channel (web vs Messages)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendWorkspaceText.mockResolvedValue({ ok: true, outboxId: "o1" });
  });

  it("a portal-channel resident is never texted a pay link", async () => {
    channel.mockResolvedValue("portal");
    expect(await sendResidentRentText({} as never, input)).toEqual({ ok: false, error: "portal_channel_no_sms" });
    expect(sendWorkspaceText).not.toHaveBeenCalled();
  });

  it("an sms-channel resident is texted as before", async () => {
    channel.mockResolvedValue("sms");
    expect(await sendResidentRentText({} as never, input)).toEqual({ ok: true, outboxId: "o1" });
    expect(sendWorkspaceText).toHaveBeenCalledTimes(1);
  });
});
