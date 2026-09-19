import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/analytics/posthog", () => ({
  track: vi.fn(),
}));

vi.mock("@/lib/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sent: false }),
}));

vi.mock("@/lib/auth/admin-preview", () => ({
  isAdminUser: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/auth/manager-lease-scope", () => ({
  collectLinkedPropertyIdsForUser: vi.fn().mockResolvedValue(new Set<string>()),
}));

vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalMessageThreadSide: vi.fn().mockResolvedValue({ action: "create", threadId: "test-thread" }),
}));

vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: vi.fn().mockResolvedValue({ kind: "normal" }),
}));

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { collectLinkedPropertyIdsForUser } from "@/lib/auth/manager-lease-scope";
import { POST as sendPaymentReminder } from "@/app/api/portal/send-payment-reminder/route";

const MANAGER_ID = "manager-1";

function paidCharge() {
  return {
    id: "hc_paid_1",
    createdAt: "2026-06-01T00:00:00.000Z",
    residentEmail: "resident@test.com",
    residentName: "Resident",
    residentUserId: null,
    propertyId: "prop-1",
    propertyLabel: "Test Property",
    managerUserId: MANAGER_ID,
    kind: "rent",
    title: "June rent",
    amountLabel: "$1000.00",
    balanceLabel: "$0.00",
    status: "paid",
    paidAt: "2026-06-15T00:00:00.000Z",
    blocksLeaseUntilPaid: false,
    dueDateLabel: "Jun 1, 2026",
  };
}

function unpaidCharge() {
  return {
    ...paidCharge(),
    id: "hc_unpaid_1",
    status: "pending",
    paidAt: undefined,
    balanceLabel: "$1000.00",
  };
}

describe("POST /api/portal/send-payment-reminder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: MANAGER_ID, email: "manager@test.com" } },
        }),
      },
    } as never);
  });

  function mockManagerDb(charge: ReturnType<typeof unpaidCharge> | ReturnType<typeof paidCharge>) {
    const chargeMaybeSingle = vi.fn().mockResolvedValue({
      data: { row_data: charge, manager_user_id: MANAGER_ID },
    });
    const profileMaybeSingle = vi.fn().mockResolvedValue({
      data: { role: "manager", full_name: "Manager", email: "manager@test.com", sms_from_number: "" },
    });
    const residentMaybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: "resident-1",
        email: charge.residentEmail,
        phone: "+15105794001",
      },
    });
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const eq = vi.fn().mockImplementation((col: string, val: string) => {
      if (col === "id" && val === charge.id) return { maybeSingle: chargeMaybeSingle };
      if (col === "id" && val === MANAGER_ID) return { maybeSingle: profileMaybeSingle };
      if (col === "email") return { maybeSingle: residentMaybeSingle };
      return { maybeSingle: profileMaybeSingle };
    });
    const select = vi.fn().mockReturnValue({ eq });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "portal_inbox_thread_records" || table === "portal_outbound_mail_records") {
          return { upsert };
        }
        return { select };
      }),
    } as never);
  }

  it("requires chargeId", async () => {
    const profileMaybeSingle = vi.fn().mockResolvedValue({
      data: { role: "manager", full_name: "Manager", email: "manager@test.com", sms_from_number: "" },
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: profileMaybeSingle }) }),
      }),
    } as never);

    const req = new Request("http://localhost/api/portal/send-payment-reminder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ residentEmail: "victim@example.com" }),
    });
    const res = await sendPaymentReminder(req);
    expect(res.status).toBe(400);
  });

  it("rejects residents", async () => {
    const profileMaybeSingle = vi.fn().mockResolvedValue({
      data: { role: "resident", full_name: "Resident", email: "resident@test.com", sms_from_number: "" },
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: profileMaybeSingle }) }),
      }),
    } as never);

    const req = new Request("http://localhost/api/portal/send-payment-reminder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chargeId: "hc_unpaid_1" }),
    });
    const res = await sendPaymentReminder(req);
    expect(res.status).toBe(403);
  });

  it("rejects another manager's charge", async () => {
    const chargeMaybeSingle = vi.fn().mockResolvedValue({
      data: { row_data: unpaidCharge(), manager_user_id: "other-manager" },
    });
    const profileMaybeSingle = vi.fn().mockResolvedValue({
      data: { role: "manager", full_name: "Manager", email: "manager@test.com", sms_from_number: "" },
    });
    const eq = vi.fn().mockImplementation((_col: string, val: string) => {
      if (val === "hc_unpaid_1") return { maybeSingle: chargeMaybeSingle };
      return { maybeSingle: profileMaybeSingle };
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq }) }),
    } as never);

    const req = new Request("http://localhost/api/portal/send-payment-reminder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chargeId: "hc_unpaid_1" }),
    });
    const res = await sendPaymentReminder(req);
    expect(res.status).toBe(404);
  });

  it("rejects reminders for a paid charge", async () => {
    mockManagerDb(paidCharge());

    const req = new Request("http://localhost/api/portal/send-payment-reminder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chargeId: "hc_paid_1", residentEmail: "resident@test.com" }),
    });
    const res = await sendPaymentReminder(req);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("charge_paid");
  });

  it("allows a co-manager linked to the charge property", async () => {
    const charge = { ...unpaidCharge(), residentEmail: "resident@axis.local" };
    const chargeMaybeSingle = vi.fn().mockResolvedValue({
      data: { row_data: charge, manager_user_id: "other-manager" },
    });
    const profileMaybeSingle = vi.fn().mockResolvedValue({
      data: { role: "manager", full_name: "Co Manager", email: "comanager@test.com", sms_from_number: "" },
    });
    const residentMaybeSingle = vi.fn().mockResolvedValue({ data: null });
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const eq = vi.fn().mockImplementation((col: string, val: string) => {
      if (col === "id" && val === "hc_unpaid_1") return { maybeSingle: chargeMaybeSingle };
      if (col === "email") return { maybeSingle: residentMaybeSingle };
      return { maybeSingle: profileMaybeSingle };
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "portal_inbox_thread_records" || table === "portal_outbound_mail_records") {
          return { upsert };
        }
        return { select: vi.fn().mockReturnValue({ eq }) };
      }),
    } as never);
    vi.mocked(collectLinkedPropertyIdsForUser).mockResolvedValue(new Set(["prop-1"]));

    const req = new Request("http://localhost/api/portal/send-payment-reminder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chargeId: "hc_unpaid_1" }),
    });
    const res = await sendPaymentReminder(req);
    expect(res.status).toBe(200);
  });

  it("allows reminders for an unpaid charge with a demo address", async () => {
    const charge = { ...unpaidCharge(), residentEmail: "resident@axis.local" };
    mockManagerDb(charge);

    const req = new Request("http://localhost/api/portal/send-payment-reminder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chargeId: "hc_unpaid_1", residentEmail: "resident@axis.local" }),
    });
    const res = await sendPaymentReminder(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; skipped?: boolean };
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(true);
  });
});
