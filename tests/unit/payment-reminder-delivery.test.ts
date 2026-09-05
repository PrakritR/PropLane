import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/push-notifications.server", () => ({
  sendPushToUser: vi.fn().mockResolvedValue({ sent: 1 }),
}));

vi.mock("@/lib/agent-notify.server", () => ({
  notifyManagerFromAgent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/resident-outbound-sms.server", () => ({
  canSendResidentOutboundSms: vi.fn(() => true),
  sendResidentOutboundSms: vi.fn().mockResolvedValue({ sent: true, channel: "managed" }),
}));

vi.mock("@/lib/stripe-household-charge-checkout.server", () => ({
  createHouseholdChargeCheckout: vi.fn(),
}));

vi.mock("@/lib/observability/langfuse", () => ({
  traceSystemNotification: vi.fn(async (opts: { run: () => Promise<unknown> }) => opts.run()),
}));

// The inbox write is another module's concern, covered by its own tests. It is
// mocked here so "delivery succeeds" is actually true: the db stub below has no
// thread-lookup chain, so the real writer throws, and the reminder now reports
// what was DELIVERED rather than what was merely allowed.
vi.mock("@/lib/portal-inbox-delivery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal-inbox-delivery")>();
  return {
    ...actual,
    deliverPortalMessageThreadSide: vi.fn().mockResolvedValue({ action: "create", threadId: "thread-1" }),
  };
});

vi.mock("@/lib/notification-preferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notification-preferences")>();
  return {
    ...actual,
    resolveChannels: vi.fn().mockResolvedValue({ inbox: true, email: true, sms: true }),
  };
});

import { sendPushToUser } from "@/lib/push-notifications.server";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { traceSystemNotification } from "@/lib/observability/langfuse";
import { sendResidentOutboundSms } from "@/lib/resident-outbound-sms.server";
import { createHouseholdChargeCheckout } from "@/lib/stripe-household-charge-checkout.server";
import { deliverPaymentReminder, reminderHtmlFromText } from "@/lib/payment-reminder-delivery";
import type { HouseholdCharge } from "@/lib/household-charges";

function makeCharge(overrides: Partial<HouseholdCharge> = {}): HouseholdCharge {
  return {
    id: "charge-1",
    kind: "rent",
    title: "July rent",
    amountLabel: "$1,200.00",
    balanceLabel: "$1,200.00",
    residentEmail: "resident@example.com",
    residentName: "Resident",
    residentUserId: "user-res-1",
    propertyId: "prop-1",
    propertyLabel: "Oak House",
    managerUserId: "mgr-1",
    status: "pending",
    createdAt: "2026-07-01T00:00:00.000Z",
    blocksLeaseUntilPaid: false,
    ...overrides,
  };
}

describe("deliverPaymentReminder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );
  });

  it("does not send when the charge is paid", async () => {
    const from = vi.fn();
    const result = await deliverPaymentReminder({
      db: { from } as never,
      charge: makeCharge({ status: "paid", balanceLabel: "$0.00", paidAt: "2026-07-01T00:00:00.000Z" }),
      managerId: "mgr-1",
      dedupId: "payment_reminder_test",
      managerName: "Manager",
      managerSmsFromNumber: "",
      apiKey: "",
      from: "PropLane <test@example.com>",
      subject: "Rent due in 3 days",
      text: "Your rent for July is due in 3 days.",
      html: "<p>test</p>",
      slotLabel: "3_days_before",
    });

    expect(result).toEqual({ sent: false, error: "charge_paid" });
    expect(from).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it("sends push to resident profile when delivery succeeds", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: "user-res-1" } });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockImplementation((table: string) => {
      if (table === "profiles") return { select };
      if (table === "portal_inbox_thread_records") return { upsert };
      if (table === "portal_outbound_mail_records") return { upsert };
      return { select, upsert };
    });

    const result = await deliverPaymentReminder({
      db: { from } as never,
      charge: makeCharge(),
      managerId: "mgr-1",
      dedupId: "payment_reminder_test",
      managerName: "Manager",
      managerSmsFromNumber: "",
      apiKey: "",
      from: "PropLane <test@example.com>",
      subject: "Rent due in 3 days",
      text: "Your rent for July is due in 3 days.",
      html: "<p>test</p>",
      slotLabel: "3_days_before",
    });

    expect(result.sent).toBe(true);
    expect(sendPushToUser).toHaveBeenCalledWith("user-res-1", {
      title: "Rent due in 3 days",
      body: "Your rent for July is due in 3 days.",
      url: "/resident/payments",
      data: { chargeId: "charge-1", slot: "3_days_before" },
    });
  });

  it("routes the manager notification through the shared preference-aware channel", async () => {
    const residentProfile = {
      id: "user-res-1",
      phone: null,
      phone_verified_at: null,
    };
    const managerProfile = {
      phone: "+12065550112",
      sms_forward_inbound: true,
    };
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const profileEq = vi.fn().mockImplementation((column: string, value: string) => ({
      maybeSingle: vi.fn().mockResolvedValue({
        data: column === "email" ? residentProfile : value === "mgr-1" ? managerProfile : residentProfile,
      }),
    }));
    const profileSelect = vi.fn().mockReturnValue({ eq: profileEq });
    const from = vi.fn().mockImplementation((table: string) => {
      if (table === "profiles") return { select: profileSelect };
      if (table === "portal_inbox_thread_records" || table === "portal_outbound_mail_records") {
        return { upsert };
      }
      return { select: profileSelect, upsert };
    });

    await deliverPaymentReminder({
      db: { from } as never,
      charge: makeCharge(),
      managerId: "mgr-1",
      dedupId: "payment_reminder_managed_test",
      managerName: "Manager",
      managerSmsFromNumber: "+12065550111",
      apiKey: "",
      from: "PropLane <test@example.com>",
      subject: "Rent due in 3 days",
      text: "Your rent for July is due in 3 days.",
      html: "<p>test</p>",
      slotLabel: "3_days_before",
    });

    expect(notifyManagerFromAgent).toHaveBeenCalledWith(expect.anything(), {
      landlordId: "mgr-1",
      subject: "Payment reminder sent",
      text: "Rent due in 3 days was sent to resident@example.com.",
      category: "payment_reminders",
      url: "/portal/payments",
    });
  });

  it("adds an ownership-scoped hosted checkout URL to payment reminder SMS", async () => {
    vi.mocked(createHouseholdChargeCheckout).mockResolvedValue({
      ok: true,
      mode: "hosted",
      url: "https://checkout.stripe.test/session",
      sessionId: "cs_test_1",
      amountCents: 120000,
      subtotalCents: 120000,
      processingFeeCents: 0,
      axisFeeCents: 0,
      platformFeeCents: 0,
      totalCents: 120000,
      paymentMethod: "ach",
      chargeIds: ["charge-1"],
    });
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const maybeSingle = vi.fn().mockResolvedValue({
      data: { id: "user-res-1", phone: "+12065550113", phone_verified_at: "2026-07-01T00:00:00.000Z" },
    });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockImplementation((table: string) =>
      table === "profiles" ? { select } : { upsert },
    );

    await deliverPaymentReminder({
      db: { from } as never,
      charge: makeCharge(),
      managerId: "mgr-1",
      dedupId: "payment_reminder_sms_link",
      managerName: "Manager",
      managerSmsFromNumber: "+12065550111",
      apiKey: "",
      from: "PropLane <test@example.com>",
      subject: "Rent due",
      text: "Your July rent is due.",
      html: "<p>test</p>",
      slotLabel: "due_date",
      managerDeliverViaSms: true,
    });

    expect(createHouseholdChargeCheckout).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-res-1",
      userEmail: "resident@example.com",
      chargeIds: ["charge-1"],
      mode: "hosted",
      paymentMethod: "ach",
      expectedManagerUserId: "mgr-1",
      appOrigin: "http://localhost:3000",
    });
    expect(sendResidentOutboundSms).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Pay securely: https://checkout.stripe.test/session"),
      }),
    );
    expect(traceSystemNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "payment_reminder",
        managerUserId: "mgr-1",
        recipientUserId: "user-res-1",
        entityId: "charge-1",
        cadence: "due_date",
      }),
    );
  });

  it("still sends a text-only SMS when checkout creation fails", async () => {
    vi.mocked(createHouseholdChargeCheckout).mockRejectedValueOnce(new Error("Stripe unavailable"));
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const maybeSingle = vi.fn().mockResolvedValue({
      data: { id: "user-res-1", phone: "+12065550113", phone_verified_at: "2026-07-01T00:00:00.000Z" },
    });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockImplementation((table: string) =>
      table === "profiles" ? { select } : { upsert },
    );

    await deliverPaymentReminder({
      db: { from } as never,
      charge: makeCharge(),
      managerId: "mgr-1",
      dedupId: "payment_reminder_sms_fallback",
      managerName: "Manager",
      managerSmsFromNumber: "+12065550111",
      apiKey: "",
      from: "PropLane <test@example.com>",
      subject: "Rent due",
      text: "Your July rent is due.",
      html: "<p>test</p>",
      slotLabel: "due_date",
      managerDeliverViaSms: true,
    });

    expect(sendResidentOutboundSms).toHaveBeenCalledWith(
      expect.objectContaining({ text: "(Rent due)\nYour July rent is due." }),
    );
  });

  it("escapes HTML in reminder bodies", () => {
    const html = reminderHtmlFromText("Hi <script>alert(1)</script>\nAmount & due");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Amount &amp; due");
    expect(html).not.toContain("<script>");
  });
});
