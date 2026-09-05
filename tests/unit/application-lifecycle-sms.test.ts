import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("@/lib/resident-outbound-sms.server", () => ({
  canSendResidentOutboundSms: vi.fn(() => false),
  sendResidentOutboundSms: sendMock,
}));

import { notifyApplicantApplicationSms } from "@/lib/application-lifecycle-sms.server";

function db() {
  return {
    from: (table: string) => {
      if (table !== "profiles") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
        }),
      };
    },
  };
}

describe("application lifecycle SMS", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ sent: false, accepted: true, channel: "twilio", error: "queued" });
  });

  it("uses the manager-scoped durable outbox even when the profile sender cache is empty", async () => {
    await expect(
      notifyApplicantApplicationSms(db() as never, {
        event: "submitted",
        applicantEmail: "applicant@example.com",
        applicantPhone: "+12065550142",
        managerUserId: "manager-1",
        axisId: "PROPLANE-123",
        dedupeKey: "application_submitted_confirmation_PROPLANE-123",
      }),
    ).resolves.toEqual({ sent: false, accepted: true, error: "queued" });

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "application_submitted_notification",
        dedupeKey: "application_submitted_confirmation_PROPLANE-123",
        sendClass: "transactional",
        openThread: expect.objectContaining({
          managerUserId: "manager-1",
          counterpartyRole: "applicant",
        }),
      }),
    );
  });
});
