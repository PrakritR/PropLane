import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/push-notifications.server", () => ({
  sendPushToUser: vi.fn().mockResolvedValue({ sent: 1 }),
}));

vi.mock("@/lib/agent-notify.server", () => ({
  notifyManagerFromAgent: vi.fn().mockResolvedValue(undefined),
}));

// The manager notification moved off notifyManagerFromAgent onto the
// property-scoped co-manager fan-out; the test kept asserting the old call, so
// it expected a function this module no longer imports.
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({
  notifyPropertyScopedManagersFromAgent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  enqueueOwnerSms: vi.fn().mockResolvedValue({ ok: true, outboxId: "outbox-1", status: "queued", deduplicated: false }),
}));

vi.mock("@/lib/payment-reminder-occurrence.server", () => ({
  paymentReminderOccurrenceId: (managerId: string, dedupId: string) => `payment:${managerId}:${dedupId}`,
  claimPaymentReminderChannel: vi.fn().mockResolvedValue({ outcome: "claimed", token: "claim-1" }),
  resolvePaymentReminderChannel: vi.fn().mockResolvedValue(undefined),
}));


vi.mock("@/lib/observability/langfuse", () => ({
  traceSystemNotification: vi.fn(async (opts: { run: () => Promise<unknown> }) => opts.run()),
}));

// This suite drives the raw Resend HTTP call through the durable claim/resolve
// path — not test-workspace routing, covered by its own tests — so the
// shared `postResendEmail` boundary's capture checks are stubbed "not
// captured" here, leaving the stubbed global `fetch` below as the one thing
// under test.
vi.mock("@/lib/sms/sms-test-transport.server", () => ({
  captureSmsTestDelivery: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/test-workspaces/effects.server", () => ({
  captureTestWorkspaceEffectForUser: vi.fn().mockResolvedValue({ captured: false }),
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
import { notifyPropertyScopedManagersFromAgent } from "@/lib/co-manager-notification-recipients.server";
import { traceSystemNotification } from "@/lib/observability/langfuse";
import { enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";
import { claimPaymentReminderChannel, resolvePaymentReminderChannel } from "@/lib/payment-reminder-occurrence.server";
import { deliverPortalMessageThreadSide } from "@/lib/portal-inbox-delivery";
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
    vi.mocked(claimPaymentReminderChannel).mockResolvedValue({ outcome: "claimed", token: "claim-1" });
    vi.mocked(resolvePaymentReminderChannel).mockResolvedValue(undefined);
    vi.mocked(enqueueOwnerSms).mockResolvedValue({ ok: true, outboxId: "outbox-1", status: "queued", deduplicated: false });
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
    vi.stubEnv("SMS_RUNTIME_ENABLED", "1");
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
    expect(deliverPortalMessageThreadSide).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scope: "axis_portal_inbox_manager_v1",
      folder: "sent",
      fallbackId: "payment_auto_reminder_sent_payment_reminder_test",
    }));
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

    expect(notifyPropertyScopedManagersFromAgent).toHaveBeenCalledWith(expect.anything(), {
      ownerManagerUserId: "mgr-1",
      // Scoped to the charge's property and the payments module, so a
      // co-manager without that grant is not notified about it.
      propertyId: "prop-1",
      module: "payments",
      subject: "Payment reminder sent",
      text: "Rent due in 3 days was sent to resident@example.com.",
      category: "payment_reminders",
      url: "/portal/payments",
      idempotencyKey: "payment_reminder_managed_test",
    });
  });

  it("adds the resident's in-app Payments link to payment reminder SMS — never a hosted Stripe URL", async () => {
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

    expect(enqueueOwnerSms).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Pay in PropLane: http://localhost:3000/resident/payments/pending"),
      }),
    );
    const smsCall = vi.mocked(enqueueOwnerSms).mock.calls[0]![0];
    expect(smsCall.body).not.toMatch(/checkout\.stripe\.com/i);
    expect(smsCall.body).not.toMatch(/connect\.stripe\.com/i);
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

  it("omits the pay link for a non-payments reminder category", async () => {
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
      dedupId: "payment_reminder_sms_lease",
      managerName: "Manager",
      managerSmsFromNumber: "+12065550111",
      apiKey: "",
      from: "PropLane <test@example.com>",
      subject: "Lease reminder",
      text: "Your lease needs attention.",
      html: "<p>test</p>",
      slotLabel: "due_date",
      managerDeliverViaSms: true,
      eventCategory: "leases",
    });

    expect(enqueueOwnerSms).toHaveBeenCalledWith(
      expect.objectContaining({ body: "(Lease reminder)\nYour lease needs attention." }),
    );
  });

  it("resumes only a confirmed failed SMS channel after email and inbox submitted", async () => {
    const statuses = new Map<string, string>();
    vi.mocked(claimPaymentReminderChannel).mockImplementation(async (_db, _occurrence, channel) => {
      const status = statuses.get(channel);
      return status === "submitted"
        ? { outcome: "submitted", token: null }
        : { outcome: "claimed", token: `claim-${channel}` };
    });
    vi.mocked(resolvePaymentReminderChannel).mockImplementation(async (_db, _id, channel, _token, status) => {
      statuses.set(channel, status);
    });
    vi.mocked(enqueueOwnerSms)
      .mockResolvedValueOnce({ ok: false, error: "recipient_opted_out" })
      .mockResolvedValueOnce({ ok: true, outboxId: "outbox-2", status: "queued", deduplicated: false });
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const maybeSingle = vi.fn().mockResolvedValue({
      data: { id: "user-res-1", phone: "+12065550113", phone_verified_at: "2026-07-01T00:00:00.000Z" },
    });
    const from = vi.fn().mockImplementation((table: string) =>
      table === "profiles" ? { select: () => ({ eq: () => ({ maybeSingle }) }) } : { upsert },
    );
    const args = {
      db: { from } as never,
      charge: makeCharge(),
      managerId: "mgr-1",
      dedupId: "payment_reminder_retry",
      managerName: "Manager",
      managerSmsFromNumber: "+12065550111",
      apiKey: "test-key",
      from: "PropLane <test@example.com>",
      subject: "Rent due",
      text: "Your July rent is due.",
      html: "<p>test</p>",
      slotLabel: "due_date",
      managerDeliverViaSms: true,
    };

    const first = await deliverPaymentReminder(args);
    const second = await deliverPaymentReminder(args);

    expect(first).toEqual({ sent: true, error: "partial_delivery" });
    expect(second).toEqual({ sent: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(enqueueOwnerSms).toHaveBeenCalledTimes(2);
    expect(enqueueOwnerSms).toHaveBeenCalledWith(expect.objectContaining({
      purpose: "payment_reminder",
      dedupeKey: "payment:mgr-1:payment_reminder_retry:sms",
    }));
    const aliases = upsert.mock.calls.filter((call) => Array.isArray(call[0]));
    expect(aliases[0]?.[0]?.[0]?.row_data.deliveryComplete).toBe(false);
    expect(aliases[1]?.[0]?.[0]?.row_data.deliveryComplete).toBe(true);
  });

  it("holds an unknown email outcome instead of submitting it again", async () => {
    const statuses = new Map<string, string>();
    vi.mocked(claimPaymentReminderChannel).mockImplementation(async (_db, _occurrence, channel) => {
      const status = statuses.get(channel);
      return status ? { outcome: status, token: null } : { outcome: "claimed", token: `claim-${channel}` };
    });
    vi.mocked(resolvePaymentReminderChannel).mockImplementation(async (_db, _id, channel, _token, status) => {
      statuses.set(channel, status);
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection reset")));
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const maybeSingle = vi.fn().mockResolvedValue({ data: null });
    const from = vi.fn().mockImplementation((table: string) =>
      table === "profiles" ? { select: () => ({ eq: () => ({ maybeSingle }) }) } : { upsert },
    );
    const args = {
      db: { from } as never,
      charge: makeCharge(),
      managerId: "mgr-1",
      dedupId: "payment_reminder_unknown",
      managerName: "Manager",
      managerSmsFromNumber: "",
      apiKey: "test-key",
      from: "PropLane <test@example.com>",
      subject: "Rent due",
      text: "Your July rent is due.",
      html: "<p>test</p>",
      slotLabel: "due_date",
      managerDeliverViaInbox: false,
    };
    await deliverPaymentReminder(args);
    await deliverPaymentReminder(args);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(statuses.get("email")).toBe("unknown");
  });

  it("escapes HTML in reminder bodies", () => {
    const html = reminderHtmlFromText("Hi <script>alert(1)</script>\nAmount & due");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Amount &amp; due");
    expect(html).not.toContain("<script>");
  });
});
