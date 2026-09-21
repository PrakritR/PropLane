/**
 * "Send now" must put the reminder on the SAME channel cron would have.
 *
 * The card and the cron job both honour a per-reminder channel override; this
 * route read the automation defaults unconditionally. A manager who pointed one
 * reminder at SMS and then tapped "Send now" on that very reminder got an email
 * and no text — the opposite of what the card said, and of what would have
 * happened had they simply waited.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
const loadManagerScheduledMessages = vi.fn();
const loadManagerPendingCharges = vi.fn();
const loadManagerAutomationSettings = vi.fn();
const deliverPaymentReminder = vi.fn();
const loadPaymentReminderChargeForActor = vi.fn();
const resolvePaymentReminderCapability = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: () => getUser() } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data:
              table === "profiles"
                ? { role: "manager", full_name: "Dana Doe", email: "dana@example.com", sms_from_number: "+15550100" }
                : null,
          }),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: table === "profile_roles" ? [{ role: "manager" }] : [] }).then(resolve),
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/payment-automation-server", () => ({
  loadManagerScheduledMessages: (...a: unknown[]) => loadManagerScheduledMessages(...a),
  loadManagerPendingCharges: (...a: unknown[]) => loadManagerPendingCharges(...a),
  parseScheduledMessageListId: () => ({ chargeId: "hc-1", kind: "pre_due", daysBeforeDue: 3 }),
}));
vi.mock("@/lib/payment-automation-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payment-automation-settings")>();
  return {
    ...actual,
    loadManagerAutomationSettings: (...a: unknown[]) => loadManagerAutomationSettings(...a),
  };
});
vi.mock("@/lib/scheduled-message-path-id", () => ({
  decodeScheduledMessagePathId: (id: string) => id,
}));
vi.mock("@/lib/payment-reminder-delivery", () => ({
  deliverPaymentReminder: (...a: unknown[]) => deliverPaymentReminder(...a),
  reminderHtmlFromText: (text: string) => text,
}));
vi.mock("@/lib/payment-reminder-capability.server", () => ({
  loadPaymentReminderChargeForActor: (...a: unknown[]) => loadPaymentReminderChargeForActor(...a),
  resolvePaymentReminderCapability: (...a: unknown[]) => resolvePaymentReminderCapability(...a),
}));
vi.mock("@/lib/manager-outbound-identity.server", () => ({
  managerOutboundFromHeader: async () => "PropLane <test@example.com>",
}));

const route = await import("@/app/api/portal/scheduled-messages/[id]/send-now/route");

const MESSAGE_ID = "smsg_hc-1_pre_due_3";

function baseMessage(extra: Record<string, unknown>) {
  return {
    id: MESSAGE_ID,
    chargeId: "hc-1",
    kind: "pre_due",
    daysBeforeDue: 3,
    sendAt: new Date().toISOString(),
    residentEmail: "resident@example.com",
    residentName: "Rey Resident",
    subject: "Rent due soon",
    body: "Your rent is due in 3 days.",
    status: "scheduled",
    managerUserId: "mgr-1",
    typeLabel: "3 days before due",
    ...extra,
  };
}

function post() {
  return route.POST(new Request("http://localhost/x", { method: "POST" }), {
    params: Promise.resolve({ id: MESSAGE_ID }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: "mgr-1", user_metadata: { role: "manager" } } } });
  const charge = {
    id: "hc-1",
    propertyId: "property-1",
    residentEmail: "resident@example.com",
    status: "pending",
    title: "Rent",
    amountLabel: "$1,000.00",
    balanceLabel: "$1,000.00",
  };
  loadManagerPendingCharges.mockResolvedValue([charge]);
  loadPaymentReminderChargeForActor.mockResolvedValue({
    charge,
    ownerUserId: "mgr-1",
    propertyId: "property-1",
  });
  resolvePaymentReminderCapability.mockResolvedValue({
    chargeId: "hc-1",
    ownerUserId: "mgr-1",
    checkedAt: new Date().toISOString(),
    email: { available: true, reason: null },
    sms: { available: true, reason: null, fromNumber: "+15550100" },
  });
  loadManagerAutomationSettings.mockResolvedValue({
    paymentReminderDeliverViaEmail: true,
    paymentReminderDeliverViaSms: false,
    paymentReminderDeliverViaInbox: true,
  });
  deliverPaymentReminder.mockResolvedValue({ sent: true });
});

describe("POST send-now", () => {
  it("uses the reminder's own channel over the automation default", async () => {
    loadManagerScheduledMessages.mockResolvedValue({
      messages: [baseMessage({ deliverViaEmail: false, deliverViaSms: true })],
    });

    const res = await post();

    expect(res.status).toBe(200);
    expect(deliverPaymentReminder).toHaveBeenCalledWith(
      expect.objectContaining({ managerDeliverViaEmail: false, managerDeliverViaSms: true }),
    );
  });

  it("falls back to the automation default when the reminder has no channel of its own", async () => {
    loadManagerScheduledMessages.mockResolvedValue({ messages: [baseMessage({})] });

    await post();

    expect(deliverPaymentReminder).toHaveBeenCalledWith(
      expect.objectContaining({ managerDeliverViaEmail: true, managerDeliverViaSms: false }),
    );
  });

  it("honours an explicit false rather than re-enabling the default", async () => {
    loadManagerAutomationSettings.mockResolvedValue({
      paymentReminderDeliverViaEmail: true,
      paymentReminderDeliverViaSms: true,
      paymentReminderDeliverViaInbox: true,
    });
    loadManagerScheduledMessages.mockResolvedValue({
      messages: [baseMessage({ deliverViaEmail: true, deliverViaSms: false })],
    });

    await post();

    expect(deliverPaymentReminder).toHaveBeenCalledWith(
      expect.objectContaining({ managerDeliverViaSms: false }),
    );
  });
});
