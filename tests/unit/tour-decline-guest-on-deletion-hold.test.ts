// Declining a tour must not die on the guest's in-app inbox copy.
//
// A guest who deleted their resident portal is on a recovery hold: the
// account-recovery write guard refuses every insert into their resident inbox
// ("Account recovery decision required"). Decline awaited that insert without a
// catch, so the refusal became a 500 before the email, the SMS, or the decline
// itself — the manager saw "Could not decline tour request." and the request
// stayed pending. Confirm / Cancel / Reschedule already treat the inbox row as
// a courtesy; this pins Decline and the request acknowledgement to the same rule.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/test-workspaces/effects.server", () => ({
  captureTestWorkspaceEffectForUser: vi.fn().mockResolvedValue({ captured: false }),
}));

const appendResidentPropertyManagerInboxMessage = vi.fn();
const resolveTourSmsEligibility = vi.fn();

vi.mock("@/lib/property-manager-inbox-thread.server", () => ({
  appendResidentPropertyManagerInboxMessage: (...args: unknown[]) => appendResidentPropertyManagerInboxMessage(...args),
  appendManagerPropertyLeadInboxMessage: vi.fn(),
}));
vi.mock("@/lib/sms/tour-sms-eligibility.server", () => ({
  resolveTourSmsEligibility: (...args: unknown[]) => resolveTourSmsEligibility(...args),
}));
vi.mock("@/lib/resident-outbound-sms.server", () => ({ sendResidentOutboundSms: vi.fn() }));
vi.mock("@/lib/manager-notification-routing.server", () => ({ sendManagerNotificationSms: vi.fn() }));
vi.mock("@/lib/manager-sms-messages.server", () => ({ fetchManagerSmsConversations: vi.fn() }));
vi.mock("@/lib/application-lifecycle-sms.server", () => ({ resolveExistingApplicantConversation: vi.fn() }));
vi.mock("@/lib/observability/langfuse", () => ({ traceSystemNotification: vi.fn() }));
vi.mock("@/lib/inbound-email/reply-address.server", () => ({ buildReplyAddress: vi.fn() }));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({
  resolveManagerRecipientProfiles: vi.fn(),
  resolvePropertyLeadRecipientIds: vi.fn(),
}));

import {
  notifyTenantTourRequestReceived,
  notifyTenantTourRequestRemoved,
} from "@/lib/tour-notification-delivery.server";

const RECOVERY_GUARD_ERROR = "Could not create the resident property manager thread.";

function makeDb() {
  return {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
  };
}

const INQUIRY = {
  id: "inq-hold",
  kind: "tour",
  name: "Aarav Jain",
  email: "guest-on-hold@example.com",
  managerUserId: "mgr-owner",
  propertyId: "mgr-seed-4709a-8th-ave-ne",
  propertyTitle: "4709A 8th Ave NE",
  proposedStart: "2026-09-10T16:00:00.000Z",
  proposedEnd: "2026-09-10T16:30:00.000Z",
};

describe("tour guest notifications when the guest's inbox is frozen", () => {
  const fetchMock = vi.fn();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "re_test";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "email_1" }) });
    appendResidentPropertyManagerInboxMessage.mockRejectedValue(new Error(RECOVERY_GUARD_ERROR));
    resolveTourSmsEligibility.mockResolvedValue({ eligible: false, reason: "No phone on file." });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.RESEND_API_KEY;
  });

  it("declines and still emails the guest when the inbox copy is refused", async () => {
    const result = await notifyTenantTourRequestRemoved(makeDb() as never, null, INQUIRY, {
      start: INQUIRY.proposedStart,
      end: INQUIRY.proposedEnd,
    });

    expect(appendResidentPropertyManagerInboxMessage).toHaveBeenCalledTimes(1);
    // The email is the notification; it must go out regardless of the inbox row.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(init.body).to).toEqual([INQUIRY.email]);

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    // The skipped copy is reported, not hidden: visible in the route's response and the server log.
    expect(result.inbox).toEqual({ sent: false, error: RECOVERY_GUARD_ERROR });
    expect(warn).toHaveBeenCalledWith(
      "[tour-notification] guest inbox copy skipped",
      { inquiryId: INQUIRY.id, error: RECOVERY_GUARD_ERROR },
    );
  });

  it("still fails the decline when the email itself cannot be sent", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ message: "Email provider rejected the message." }) });

    const result = await notifyTenantTourRequestRemoved(makeDb() as never, null, INQUIRY);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Email provider rejected the message.");
  });

  it("acknowledges a new tour request when the inbox copy is refused", async () => {
    const result = await notifyTenantTourRequestReceived(makeDb() as never, null, INQUIRY, {
      start: INQUIRY.proposedStart,
      end: INQUIRY.proposedEnd,
    });

    expect(appendResidentPropertyManagerInboxMessage).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });
});
