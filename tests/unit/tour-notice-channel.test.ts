import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Web vs Messages for tours: a tour inquiry records the channel it was made on, and every outcome notice to the
 * guest (received, confirmed, rescheduled, cancelled, removed) follows it - email + the resident portal inbox
 * with a /resident link for a portal tour (no text, whatever the consent), today's consent-gated text for a tour
 * made by text. The delivery edges are stood in for.
 */
vi.mock("server-only", () => ({}));
const eligibility = vi.fn(async () => ({ eligible: true as const, phoneE164: "+12065550142", conversationKey: "conv-1" }));
vi.mock("@/lib/sms/tour-sms-eligibility.server", () => ({ resolveTourSmsEligibility: (...a: unknown[]) => eligibility(...(a as [])) }));
const sendSms = vi.fn(async (..._args: unknown[]) => ({ sent: true, accepted: true }));
vi.mock("@/lib/resident-outbound-sms.server", () => ({ sendResidentOutboundSms: (...a: unknown[]) => sendSms(...a) }));
const inbox: Array<Record<string, unknown>> = [];
vi.mock("@/lib/property-manager-inbox-thread.server", () => ({
  appendResidentPropertyManagerInboxMessage: vi.fn(async (_db: unknown, input: Record<string, unknown>) => { inbox.push(input); }),
  appendManagerPropertyLeadInboxMessage: vi.fn(async () => undefined),
}));
vi.mock("@/lib/portal-inbox-delivery", () => ({ deliverPortalMessageThreadSide: vi.fn(async () => undefined) }));
const mail: Array<{ payload: { text: string; to: string[] } }> = [];
vi.mock("@/lib/resend-delivery.server", () => ({
  postResendEmail: vi.fn(async (input: { payload: { text: string; to: string[] } }) => {
    mail.push(input);
    return new Response("{}", { status: 200 });
  }),
}));
vi.mock("@/lib/manager-outbound-identity.server", () => ({ managerOutboundFromHeader: async () => "PropLane <work@proplane.test>" }));
vi.mock("@/lib/inbound-email/reply-address.server", () => ({ buildReplyAddress: () => "reply@proplane.test" }));
vi.mock("@/lib/manager-notification-routing.server", () => ({ sendManagerNotificationSms: vi.fn(async () => ({ sent: true })) }));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({ resolveManagerRecipientProfiles: vi.fn(async () => []), resolvePropertyLeadRecipientIds: vi.fn(async () => []) }));
vi.mock("@/lib/manager-sms-messages.server", () => ({ fetchManagerSmsConversations: vi.fn() }));
vi.mock("@/lib/application-lifecycle-sms.server", () => ({ resolveExistingApplicantConversation: vi.fn() }));
vi.mock("@/lib/tour-events.server", () => ({ emitTourManagerEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/observability/langfuse", () => ({ traceSystemNotification: async (input: { run: () => Promise<unknown> }) => input.run() }));

import {
  notifyTenantTourCanceled,
  notifyTenantTourConfirmed,
  notifyTenantTourRequestReceived,
  notifyTenantTourRequestRemoved,
  notifyTenantTourRescheduled,
} from "@/lib/tour-notification-delivery.server";

const db = {
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { id: "mgr-1", email: "owner@proplane.test", full_name: "Ambika", property_data: { address: "12 Cedar St" } } }),
        or: () => ({ limit: async () => ({ data: [] }) }),
      }),
    }),
  }),
} as never;

const row = (over: Record<string, unknown> = {}) => ({
  id: "tour-1", name: "Priya", email: "priya@example.com", phone: "+12065550142", smsConsent: true,
  managerUserId: "mgr-1", propertyId: "prop-1", propertyTitle: "Cedar Court",
  proposedStart: "2026-10-25T18:00:00.000Z", proposedEnd: "2026-10-25T18:30:00.000Z", ...over,
});
const window = { start: "2026-10-25T18:00:00.000Z", end: "2026-10-25T18:30:00.000Z", managerUserId: "mgr-1" };
const moved = { start: "2026-10-26T18:00:00.000Z", end: "2026-10-26T18:30:00.000Z" };

beforeEach(() => {
  vi.clearAllMocks();
  inbox.length = 0;
  mail.length = 0;
  process.env.RESEND_API_KEY = "re_test";
});

describe.each([
  ["received", (inquiry: Record<string, unknown>) => notifyTenantTourRequestReceived(db, null, inquiry as never)],
  ["confirmed", (inquiry: Record<string, unknown>) => notifyTenantTourConfirmed(db, null, inquiry as never, window)],
  ["rescheduled", (inquiry: Record<string, unknown>) => notifyTenantTourRescheduled(db, null, inquiry as never, { window: { ...moved, managerUserId: "mgr-1" }, previousWindow: window })],
  ["cancelled", (inquiry: Record<string, unknown>) => notifyTenantTourCanceled(db, null, inquiry as never, window)],
  ["removed", (inquiry: Record<string, unknown>) => notifyTenantTourRequestRemoved(db, null, inquiry as never)],
])("tour %s", (_name, notify) => {
  it("a portal tour is told by email + the resident portal, with a /resident link, and is never texted", async () => {
    await notify(row({ noticeChannel: "portal" }));
    expect(sendSms).not.toHaveBeenCalled();
    expect(mail).toHaveLength(1);
    expect(mail[0]!.payload.text).toContain("https://proplane.ai/resident/tour");
    expect(mail[0]!.payload.text).not.toMatch(/sms:|tel:|\/l\//);
  });

  it("a tour made by text (or one with no recorded channel) keeps today's consent-gated text", async () => {
    await notify(row({ noticeChannel: "sms" }));
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(mail[0]?.payload.text ?? "").not.toContain("See it in your portal");
    sendSms.mockClear();
    await notify(row());
    expect(sendSms).toHaveBeenCalledTimes(1);
  });
});

describe("the portal inbox copy of a confirmed or changed tour carries the same link", () => {
  it("confirmed", async () => {
    await notifyTenantTourConfirmed(db, null, row({ noticeChannel: "portal" }) as never, window);
    expect(String(inbox[0]!.body)).toContain("https://proplane.ai/resident/tour");
  });
  it("rescheduled and cancelled", async () => {
    await notifyTenantTourRescheduled(db, null, row({ noticeChannel: "portal" }) as never, { window: { ...moved, managerUserId: "mgr-1" }, previousWindow: window });
    await notifyTenantTourCanceled(db, null, row({ noticeChannel: "portal" }) as never, window);
    expect(inbox.map((m) => String(m.body).includes("/resident/tour"))).toEqual([true, true]);
  });
});
