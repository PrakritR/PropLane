import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A4: a tour request is ONE turn in the workspace owner's conversation with the prospect (stamped with the house), not a
 * separate lead copy in every teammate's inbox. Teammates are told by email / text / one Team chat line instead.
 */

const appendLead = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@/lib/property-manager-inbox-thread.server", () => ({
  appendManagerPropertyLeadInboxMessage: (...args: unknown[]) => appendLead(...args),
  appendResidentPropertyManagerInboxMessage: vi.fn(async () => undefined),
}));

const recipients = [
  { userId: "owner-1", email: "owner@example.com", fullName: "Ambika", phone: null },
  { userId: "co-cedar", email: "co@example.com", fullName: "Dev", phone: null },
];
const teamLine = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({
  resolvePropertyLeadRecipientIds: vi.fn(async () => recipients.map((r) => r.userId)),
  resolveManagerRecipientProfiles: vi.fn(async () => recipients),
  postTeamNoticeLineForEvent: (...args: unknown[]) => teamLine(...args),
}));

const sendEmail = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({}), { status: 200 }));
vi.mock("@/lib/manager-outbound-identity.server", () => ({ managerOutboundFromHeader: vi.fn(async () => "PropLane <tours@example.com>") }));
process.env.RESEND_API_KEY = "re_test_key";
vi.mock("@/lib/resend-delivery.server", () => ({
  postResendEmail: (...args: unknown[]) => sendEmail(...args),
}));
vi.mock("@/lib/manager-notification-routing.server", () => ({ sendManagerNotificationSms: vi.fn(async () => ({ sent: true })) }));
vi.mock("@/lib/resident-outbound-sms.server", () => ({ sendResidentOutboundSms: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/manager-sms-messages.server", () => ({ fetchManagerSmsConversations: vi.fn() }));
vi.mock("@/lib/application-lifecycle-sms.server", () => ({ resolveExistingApplicantConversation: vi.fn() }));

import { notifyManagerTourRequest } from "@/lib/tour-notification-delivery.server";

function makeDb() {
  return {
    from: vi.fn((table: string) => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () =>
            table === "manager_property_records"
              ? { data: { id: "prop-cedar", property_data: { address: "2210 Cedar Court Ln" }, row_data: {} } }
              : { data: { id: "owner-1", email: "owner@example.com", full_name: "Ambika" } },
          ),
        })),
      })),
      upsert: vi.fn(async () => ({ data: null, error: null })),
    })),
  } as unknown as Parameters<typeof notifyManagerTourRequest>[0];
}

const inquiry = {
  id: "inq-1",
  name: "Jordan Lee",
  email: "jordan@example.com",
  managerUserId: "owner-1",
  propertyId: "prop-cedar",
  propertyTitle: "Cedar Court",
  proposedStart: "2026-11-02T19:00:00.000Z",
  proposedEnd: "2026-11-02T19:30:00.000Z",
};

describe("tour request -> one host-team thread", () => {
  beforeEach(() => {
    appendLead.mockClear();
    teamLine.mockClear();
    sendEmail.mockClear();
    sendEmail.mockImplementation(async () => new Response(JSON.stringify({}), { status: 200 }));
  });

  it("writes exactly ONE turn, into the owner's conversation, stamped with the house; no per-co-manager copies", async () => {
    const res = await notifyManagerTourRequest(makeDb(), null, inquiry);
    expect(res.ok).toBe(true);
    expect(appendLead).toHaveBeenCalledTimes(1);
    const [, ownerId, input] = appendLead.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(ownerId).toBe("owner-1");
    expect(input).toMatchObject({
      propertyId: "prop-cedar",
      propertyTitle: "Cedar Court",
      prospectEmail: "jordan@example.com",
      topic: "Tour request",
      counterpartyRole: "prospect",
    });
    // No call names the co-manager as the inbox to write into.
    expect(appendLead.mock.calls.some((c) => c[1] === "co-cedar")).toBe(false);
  });

  it("tells the co-manager instead: the email (to everyone) links to Communication and ONE Team chat line is posted, idempotent per request", async () => {
    await notifyManagerTourRequest(makeDb(), null, inquiry);
    expect(sendEmail).toHaveBeenCalled();
    const emailPayload = JSON.stringify(sendEmail.mock.calls[0]);
    expect(emailPayload).toContain("co@example.com");
    expect(emailPayload).toContain("/portal/communication/active");
    expect(teamLine).toHaveBeenCalledTimes(1);
    const [, line] = teamLine.mock.calls[0] as [unknown, { ownerManagerUserId: string; propertyId: string; excludeUserIds: string[]; teamNotice: { text: string; messageId: string } }];
    expect(line).toMatchObject({ ownerManagerUserId: "owner-1", propertyId: "prop-cedar", excludeUserIds: ["owner-1"] });
    expect(line.teamNotice.text).toContain("Tour requested");
    expect(line.teamNotice.text).toContain("Jordan Lee");
    expect(line.teamNotice.messageId).toBe("tour:inq-1:request:2026-11-02T19:00:00.000Z:2026-11-02T19:30:00.000Z:team");
  });

  it("posts no Team line when the owner is the only recipient", async () => {
    const solo = recipients.splice(1);
    try {
      await notifyManagerTourRequest(makeDb(), null, inquiry);
      expect(appendLead).toHaveBeenCalledTimes(1);
      expect(teamLine).not.toHaveBeenCalled();
    } finally {
      recipients.push(...solo);
    }
  });
});
