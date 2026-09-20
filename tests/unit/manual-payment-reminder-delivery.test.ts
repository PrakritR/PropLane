import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/payment-reminder-occurrence.server", () => ({
  claimPaymentReminderChannel: vi.fn(),
  resolvePaymentReminderChannel: vi.fn(),
}));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms: vi.fn() }));
vi.mock("@/lib/portal-inbox-delivery", () => ({ deliverPortalMessageThreadSide: vi.fn() }));

import { claimPaymentReminderChannel, resolvePaymentReminderChannel } from "@/lib/payment-reminder-occurrence.server";
import { enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";
import { deliverPortalMessageThreadSide } from "@/lib/portal-inbox-delivery";
import { deliverManualPaymentReminder, type ManualPaymentReminderDeliveryInput } from "@/lib/manual-payment-reminder-delivery.server";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const OCCURRENCE_ID = `payment:manual:owner-1:${REQUEST_ID}`;

function input(): ManualPaymentReminderDeliveryInput {
  return {
    db: {} as never,
    ownerUserId: "owner-1",
    actorUserId: "co-manager-1",
    requestId: REQUEST_ID,
    chargeIds: ["charge-2", "charge-1"],
    propertyId: "home-1",
    recipientEmail: "Resident@Example.com",
    inboxEmail: "resident@example.com",
    recipientPhone: "+12065550142",
    residentUserId: "resident-1",
    managerEmail: "owner@example.com",
    managerName: "Owner",
    subject: "Rent due",
    text: "Two charges remain due.",
    smsText: "Two charges remain due.",
    wantEmail: true,
    wantSms: true,
    canEmailExternally: true,
    smsFromNumber: "+12065550143",
    from: "Owner <assist-owner@prop-lane.space>",
  };
}

describe("manual payment reminder occurrence delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "resend-1" }) }));
    vi.mocked(enqueueOwnerSms).mockResolvedValue({ ok: true, outboxId: "outbox-1", status: "queued", deduplicated: false });
    vi.mocked(deliverPortalMessageThreadSide).mockResolvedValue({ action: "create", threadId: "thread-1" });
    vi.mocked(resolvePaymentReminderChannel).mockResolvedValue(undefined);
    vi.mocked(claimPaymentReminderChannel).mockResolvedValue({ outcome: "claimed", token: "claim-1" });
  });

  it("uses one stable occurrence and reports queued SMS without claiming delivery", async () => {
    const result = await deliverManualPaymentReminder(input());

    expect(result).toMatchObject({
      occurrenceId: OCCURRENCE_ID,
      email: { status: "submitted", providerReference: "resend-1" },
      sms: { status: "submitted", queued: true, sent: false, outboxId: "outbox-1" },
      inbox: { status: "submitted" },
    });
    expect(claimPaymentReminderChannel).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      id: OCCURRENCE_ID,
      chargeIds: ["charge-1", "charge-2"],
      dedupIds: [`${OCCURRENCE_ID}:charge-1`, `${OCCURRENCE_ID}:charge-2`],
    }), "email");
    expect(enqueueOwnerSms).toHaveBeenCalledWith(expect.objectContaining({
      managerUserId: "owner-1", actorUserId: "co-manager-1",
      dedupeKey: `${OCCURRENCE_ID}:sms`,
    }));
    expect(deliverPortalMessageThreadSide).toHaveBeenCalledTimes(2);
  });

  it("replaying the same request does not call either provider or append inbox again", async () => {
    const states = new Map<string, string>();
    vi.mocked(claimPaymentReminderChannel).mockImplementation(async (_db, _occurrence, channel) => {
      const status = states.get(channel);
      return status ? { outcome: status, token: null } : { outcome: "claimed", token: `claim-${channel}` };
    });
    vi.mocked(resolvePaymentReminderChannel).mockImplementation(async (_db, _id, channel, _token, status) => {
      states.set(channel, status);
    });

    await deliverManualPaymentReminder(input());
    const replay = await deliverManualPaymentReminder(input());

    expect(replay.email.status).toBe("submitted");
    expect(replay.sms).toMatchObject({ queued: true, sent: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(enqueueOwnerSms).toHaveBeenCalledTimes(1);
    expect(deliverPortalMessageThreadSide).toHaveBeenCalledTimes(2);
  });

  it("holds an unknown email outcome and never blindly retries it", async () => {
    const statuses = new Map<string, string>();
    vi.mocked(claimPaymentReminderChannel).mockImplementation(async (_db, _occurrence, channel) => {
      const status = statuses.get(channel);
      return status ? { outcome: status, token: null } : { outcome: "claimed", token: `claim-${channel}` };
    });
    vi.mocked(resolvePaymentReminderChannel).mockImplementation(async (_db, _id, channel, _token, status) => {
      statuses.set(channel, status);
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout after send")));
    const first = await deliverManualPaymentReminder({ ...input(), wantSms: false });
    const replay = await deliverManualPaymentReminder({ ...input(), wantSms: false });
    expect(first.email.status).toBe("unknown");
    expect(replay.email.status).toBe("unknown");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("blocks a reused request ID with a different immutable payload", async () => {
    vi.mocked(claimPaymentReminderChannel).mockResolvedValue({ outcome: "revision_conflict", token: null });
    const result = await deliverManualPaymentReminder(input());
    expect(result.conflict).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
    expect(deliverPortalMessageThreadSide).not.toHaveBeenCalled();
  });
});
