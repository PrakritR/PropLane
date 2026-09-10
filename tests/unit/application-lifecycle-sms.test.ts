import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock, conversationsMock } = vi.hoisted(() => ({ sendMock: vi.fn(), conversationsMock: vi.fn() }));

vi.mock("@/lib/resident-outbound-sms.server", () => ({
  canSendResidentOutboundSms: vi.fn(() => false),
  sendResidentOutboundSms: sendMock,
}));
vi.mock("@/lib/manager-sms-messages.server", () => ({ fetchManagerSmsConversations: conversationsMock }));

import { notifyApplicantApplicationSms, resolveExistingApplicantConversation } from "@/lib/application-lifecycle-sms.server";

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
    conversationsMock.mockResolvedValue({ residents: [], workNumber: "+12065550100" });
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

  it("preserves one exact prospect thread but declines an ambiguous same-phone role pair", () => {
    const rows = [
      { ownerManagerUserId: "manager-1", phone: "+12065550142", conversationKey: "manager-1:prospect:+12065550142", counterpartyRole: "prospect", messages: [{ direction: "inbound", fromPhone: "+12065550142", toPhone: "+12065550100" }] },
    ] as never;
    expect(resolveExistingApplicantConversation(rows, { managerUserId: "manager-1", applicantPhone: "(206) 555-0142", workNumber: "+12065550100" }))
      .toEqual({ kind: "matched", conversation: { conversationKey: "manager-1:prospect:+12065550142", counterpartyRole: "prospect" } });
    expect(resolveExistingApplicantConversation([
      ...rows,
      { ownerManagerUserId: "manager-1", phone: "+12065550142", conversationKey: "manager-1:applicant:+12065550142", counterpartyRole: "applicant", messages: [{ direction: "inbound", fromPhone: "+12065550142", toPhone: "+12065550100" }] },
    ] as never, { managerUserId: "manager-1", applicantPhone: "+12065550142", workNumber: "+12065550100" })).toEqual({ kind: "ambiguous" });
    expect(resolveExistingApplicantConversation(rows, { managerUserId: "manager-1", applicantPhone: "+12065559999", workNumber: "+12065550100" })).toEqual({ kind: "missing" });
  });

  it("does not send when the exact work-number conversation is unavailable", async () => {
    conversationsMock.mockResolvedValue({ residents: [], workNumber: "+12065550100" });
    await expect(notifyApplicantApplicationSms(db() as never, {
      event: "approved", applicantEmail: "applicant@example.com", applicantPhone: "+12065550142", managerUserId: "manager-1",
    })).resolves.toMatchObject({ sent: false, error: "conversation_not_found" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("passes a server-resolved existing prospect identity without accepting a changed phone", async () => {
    conversationsMock.mockResolvedValue({ workNumber: "+12065550100", residents: [{
      ownerManagerUserId: "manager-1", phone: "+12065550142", conversationKey: "manager-1:prospect:+12065550142", counterpartyRole: "prospect", messages: [{ direction: "inbound", fromPhone: "+12065550142", toPhone: "+12065550100" }],
    }] });
    await notifyApplicantApplicationSms(db() as never, {
      event: "approved", applicantEmail: "applicant@example.com", applicantPhone: "+12065550142", managerUserId: "manager-1",
    });
    expect(sendMock).toHaveBeenLastCalledWith(expect.objectContaining({ openThread: expect.objectContaining({
      conversationKey: "manager-1:prospect:+12065550142", counterpartyRole: "prospect",
    }) }));
  });

  it("uses a portal next step instead of claiming an unselected setup email", async () => {
    conversationsMock.mockResolvedValue({ workNumber: "+12065550100", residents: [{
      ownerManagerUserId: "manager-1", phone: "+12065550142", conversationKey: "manager-1:prospect:+12065550142", counterpartyRole: "prospect", messages: [{ direction: "inbound", fromPhone: "+12065550142", toPhone: "+12065550100" }],
    }] });
    await notifyApplicantApplicationSms(db() as never, {
      event: "approved", applicantEmail: "applicant@example.com", applicantPhone: "+12065550142", managerUserId: "manager-1", setupEmailSelected: false,
    });
    const message = String(sendMock.mock.calls[0]?.[0]?.text ?? "");
    expect(message).toContain("Next steps: https://");
    expect(message).not.toContain("Check your email");
  });
});
