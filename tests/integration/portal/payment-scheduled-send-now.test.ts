import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/payment-automation-server", () => ({
  loadManagerScheduledMessages: vi.fn(),
  loadManagerPendingCharges: vi.fn(),
  parseScheduledMessageListId: vi.fn(),
}));
vi.mock("@/lib/combined-payment-reminders", async (original) => {
  const actual = await original<typeof import("@/lib/combined-payment-reminders")>();
  return { ...actual, combineScheduledPaymentMessages: vi.fn() };
});
vi.mock("@/lib/payment-reminder-capability.server", () => ({
  loadPaymentReminderChargeForActor: vi.fn(),
  resolvePaymentReminderCapability: vi.fn(),
}));
vi.mock("@/lib/payment-reminder-delivery", () => ({
  deliverPaymentReminder: vi.fn(),
  reminderHtmlFromText: vi.fn(() => "<p>body</p>"),
}));
vi.mock("@/lib/payment-automation-settings", async (original) => {
  const actual = await original<typeof import("@/lib/payment-automation-settings")>();
  return { ...actual, loadManagerAutomationSettings: vi.fn() };
});

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadManagerScheduledMessages, loadManagerPendingCharges } from "@/lib/payment-automation-server";
import { combineScheduledPaymentMessages } from "@/lib/combined-payment-reminders";
import { loadPaymentReminderChargeForActor, resolvePaymentReminderCapability } from "@/lib/payment-reminder-capability.server";
import { loadManagerAutomationSettings, DEFAULT_MANAGER_AUTOMATION_SETTINGS } from "@/lib/payment-automation-settings";
import { deliverPaymentReminder } from "@/lib/payment-reminder-delivery";
import { encodeScheduledMessagePathId } from "@/lib/scheduled-message-path-id";
import { POST } from "@/app/api/portal/scheduled-messages/[id]/send-now/route";

const listId = "sched|bundle|resident@example.com|pre_due|3|2026-09-13T09:00|charge-1,charge-2";
const pathId = encodeScheduledMessagePathId(listId);
const charge = {
  id: "charge-1", residentEmail: "resident@example.com", residentName: "Resident",
  propertyId: "home-1", status: "pending", balanceLabel: "$100", title: "Rent",
};

describe("payment scheduled Send now workspace authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "co-manager" } } }) },
    } as never);
    const db = {
      from: vi.fn((table: string) => {
        if (table === "profile_roles") return { select: () => ({ eq: () => Promise.resolve({ data: [{ role: "manager" }] }) }) };
        if (table === "profiles") return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { full_name: "Owner", email: "owner@example.com" } }) }) }) };
        if (table === "test_workspace_members") return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
        throw new Error(`Unexpected table ${table}`);
      }),
    };
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    vi.mocked(loadManagerScheduledMessages).mockResolvedValue({ settings: DEFAULT_MANAGER_AUTOMATION_SETTINGS, messages: [] });
    vi.mocked(combineScheduledPaymentMessages).mockReturnValue([{
      id: listId, chargeId: "charge-1", bundledChargeIds: ["charge-1", "charge-2"],
      kind: "pre_due", daysBeforeDue: 3, status: "scheduled", residentEmail: "resident@example.com",
      subject: "Reminder", body: "Body", typeLabel: "3 days before", deliverViaEmail: true, deliverViaSms: false,
    } as never]);
    vi.mocked(loadManagerPendingCharges).mockResolvedValue([{ ...charge }, { ...charge, id: "charge-2" }] as never);
    vi.mocked(loadManagerAutomationSettings).mockResolvedValue(DEFAULT_MANAGER_AUTOMATION_SETTINGS);
    vi.mocked(resolvePaymentReminderCapability).mockResolvedValue({
      chargeId: "charge-1", ownerUserId: "owner-1", checkedAt: "now",
      email: { available: true, reason: null }, sms: { available: false, reason: "No number", fromNumber: null },
    });
    vi.mocked(deliverPaymentReminder).mockResolvedValue({ sent: true });
  });

  it("rejects a bundle whose charges resolve to different owners before delivery", async () => {
    vi.mocked(loadPaymentReminderChargeForActor)
      .mockResolvedValueOnce({ charge: charge as never, ownerUserId: "owner-1", propertyId: "home-1" })
      .mockResolvedValueOnce({ charge: { ...charge, id: "charge-2" } as never, ownerUserId: "owner-2", propertyId: "home-2" });
    const res = await POST(new Request("http://localhost/send-now", { method: "POST" }), { params: Promise.resolve({ id: pathId }) });
    expect(res.status).toBe(409);
    expect(loadManagerScheduledMessages).not.toHaveBeenCalled();
    expect(deliverPaymentReminder).not.toHaveBeenCalled();
  });

  it("uses the charge owner as sender for an authorized co-manager", async () => {
    vi.mocked(loadPaymentReminderChargeForActor)
      .mockImplementation(async (_db, _actor, chargeId) => ({
        charge: { ...charge, id: chargeId } as never,
        ownerUserId: "owner-1",
        propertyId: "home-1",
      }));
    const res = await POST(new Request("http://localhost/send-now", { method: "POST" }), { params: Promise.resolve({ id: pathId }) });
    expect(res.status).toBe(200);
    expect(loadManagerScheduledMessages).toHaveBeenCalledWith(expect.anything(), "owner-1", { includeHidden: true });
    expect(deliverPaymentReminder).toHaveBeenCalledWith(expect.objectContaining({ managerId: "owner-1" }));
  });

  it("refuses a balance change found immediately before delivery", async () => {
    let reads = 0;
    vi.mocked(loadPaymentReminderChargeForActor).mockImplementation(async (_db, _actor, chargeId) => {
      reads++;
      return {
        charge: { ...charge, id: chargeId, balanceLabel: reads > 2 && chargeId === "charge-2" ? "$50" : "$100" } as never,
        ownerUserId: "owner-1",
        propertyId: "home-1",
      };
    });
    const res = await POST(new Request("http://localhost/send-now", { method: "POST" }), { params: Promise.resolve({ id: pathId }) });
    expect(res.status).toBe(409);
    expect(deliverPaymentReminder).not.toHaveBeenCalled();
  });
});
