import { beforeEach, describe, expect, it, vi } from "vitest";

const sendManagerNotificationSms = vi.fn(async () => ({ sent: true }));
vi.mock("@/lib/manager-notification-routing.server", () => ({
  sendManagerNotificationSms: (...args: unknown[]) =>
    sendManagerNotificationSms(...(args as [])),
}));

const recipients: Array<{ userId: string; email: string; fullName: string | null; phone: string | null }> = [];
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({
  resolvePropertyLeadRecipientIds: vi.fn(async () => recipients.map((r) => r.userId)),
  resolveManagerRecipientProfiles: vi.fn(async () => recipients),
}));

vi.mock("@/lib/resident-outbound-sms.server", () => ({
  sendResidentOutboundSms: vi.fn(async () => ({ ok: true })),
}));

import { notifyManagerTourRequest } from "@/lib/tour-notification-delivery.server";

function makeDb() {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({
            data: { id: "admin-1", email: "admin@test.proplane.local", full_name: "admin" },
          })),
        })),
      })),
      upsert: vi.fn(async () => ({ data: null, error: null })),
    })),
  } as unknown as Parameters<typeof notifyManagerTourRequest>[0];
}

const req = new Request("http://localhost:3100/api/public/tour-inquiries");

const inquiry = {
  name: "Jordan Guest",
  email: "guest@example.com",
  managerUserId: "admin-1",
  propertyTitle: "Maple House",
  proposedStart: "2026-07-22T18:00:00.000Z",
  proposedEnd: "2026-07-22T18:30:00.000Z",
};

describe("notifyManagerTourRequest SMS leg", () => {
  beforeEach(() => {
    sendManagerNotificationSms.mockClear();
    recipients.length = 0;
  });

  it("routes every recipient through their own manager alert preference", async () => {
    recipients.push(
      { userId: "admin-1", email: "admin@test.proplane.local", fullName: "admin", phone: "+15103098345" },
      { userId: "co-1", email: "co@test.proplane.local", fullName: null, phone: "+12065551234" },
    );

    const res = await notifyManagerTourRequest(makeDb(), req, inquiry);
    expect(res.ok).toBe(true);

    const targets = sendManagerNotificationSms.mock.calls.map(
      (c) => (c[1] as { managerUserId: string }).managerUserId,
    );
    expect(targets).toEqual(["admin-1", "co-1"]);
    for (const call of sendManagerNotificationSms.mock.calls) {
      const { text, category } = call[1] as { text: string; category: string };
      expect(category).toBe("leasing");
      expect(text).toContain("new tour request");
      expect(text).toContain("Maple House");
      expect(text).toContain("Jordan Guest");
    }
  });

  it("lets the shared router decide fallback for recipients without an SMS connection", async () => {
    recipients.push(
      { userId: "admin-1", email: "admin@test.proplane.local", fullName: "admin", phone: "+15103098345" },
      { userId: "co-optout", email: "optout@test.proplane.local", fullName: null, phone: null },
    );

    const res = await notifyManagerTourRequest(makeDb(), req, inquiry);
    expect(res.ok).toBe(true);
    expect(sendManagerNotificationSms).toHaveBeenCalledTimes(2);
  });

  it("still succeeds when the router falls back to Assistant", async () => {
    sendManagerNotificationSms.mockResolvedValueOnce({ sent: false });
    recipients.push({ userId: "admin-1", email: "admin@test.proplane.local", fullName: "admin", phone: null });

    const res = await notifyManagerTourRequest(makeDb(), req, inquiry);
    expect(res.ok).toBe(true);
    expect(sendManagerNotificationSms).toHaveBeenCalledTimes(1);
  });
});
