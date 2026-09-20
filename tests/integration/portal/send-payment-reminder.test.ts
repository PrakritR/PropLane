import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  linkedOwnerScopeForModule: vi.fn(),
}));

vi.mock("@/lib/payments/property-payout-owner.server", () => ({
  resolvePropertyPayoutOwner: vi.fn(),
}));

vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalMessageThreadSide: vi.fn().mockResolvedValue({ action: "create", threadId: "test-thread" }),
}));

vi.mock("@/lib/manual-payment-reminder-delivery.server", () => ({ deliverManualPaymentReminder: vi.fn() }));

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { linkedOwnerScopeForModule } from "@/lib/auth/co-manager-module-scope";
import { resolvePropertyPayoutOwner } from "@/lib/payments/property-payout-owner.server";
import { GET as checkPaymentReminder, POST as sendPaymentReminder } from "@/app/api/portal/send-payment-reminder/route";
import { deliverManualPaymentReminder } from "@/lib/manual-payment-reminder-delivery.server";

const MANAGER_ID = "manager-1";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

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
    vi.stubEnv("RESEND_API_KEY", "test-resend-key");
    vi.mocked(deliverManualPaymentReminder).mockResolvedValue({
      occurrenceId: `payment:manual:${MANAGER_ID}:${REQUEST_ID}`,
      conflict: false,
      email: { status: "skipped" },
      sms: { status: "skipped", sent: false, queued: false },
      inbox: { status: "submitted" },
    });
    vi.mocked(resolvePropertyPayoutOwner).mockResolvedValue({ ok: true, ownerUserId: MANAGER_ID });
    vi.mocked(linkedOwnerScopeForModule).mockResolvedValue({
      ownerIds: new Set(),
      propertyIds: new Set(),
      propertyIdsByOwner: new Map(),
    });
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: MANAGER_ID, email: "manager@test.com" } },
        }),
      },
    } as never);
  });

  afterEach(() => vi.unstubAllEnvs());

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

  it("requires a stable client request ID before claiming any channel", async () => {
    mockManagerDb(unpaidCharge());
    const res = await sendPaymentReminder(new Request("http://localhost/api/portal/send-payment-reminder", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chargeId: "hc_unpaid_1" }),
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_request_id");
    expect(deliverManualPaymentReminder).not.toHaveBeenCalled();
  });

  it("returns accepted-but-queued SMS as pending without claiming it was sent", async () => {
    mockManagerDb(unpaidCharge());
    vi.mocked(deliverManualPaymentReminder).mockResolvedValue({
      occurrenceId: `payment:manual:${MANAGER_ID}:${REQUEST_ID}`,
      conflict: false,
      email: { status: "submitted" },
      sms: { status: "submitted", sent: false, queued: true, outboxId: "outbox-1" },
      inbox: { status: "submitted" },
    });
    const res = await sendPaymentReminder(new Request("http://localhost/api/portal/send-payment-reminder", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chargeId: "hc_unpaid_1", requestId: REQUEST_ID }),
    }));
    const data = await res.json();
    expect(res.status).toBe(202);
    expect(data).toMatchObject({ ok: true, status: "pending", smsQueued: true, smsSent: false });
  });

  it("holds a request with an in-flight claim instead of reporting full success", async () => {
    mockManagerDb(unpaidCharge());
    vi.mocked(deliverManualPaymentReminder).mockResolvedValue({
      occurrenceId: `payment:manual:${MANAGER_ID}:${REQUEST_ID}`,
      conflict: false,
      email: { status: "claimed" },
      sms: { status: "skipped", sent: false, queued: false },
      inbox: { status: "submitted" },
    });
    const res = await sendPaymentReminder(new Request("http://localhost/api/portal/send-payment-reminder", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chargeId: "hc_unpaid_1", requestId: REQUEST_ID }),
    }));
    const data = await res.json();
    expect(res.status).toBe(202);
    expect(data).toMatchObject({ ok: false, status: "pending" });
  });

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
      body: JSON.stringify({ chargeId: "hc_unpaid_1", requestId: REQUEST_ID }),
    });
    const res = await sendPaymentReminder(req);
    expect(res.status).toBe(403);
  });

  it("rejects another manager's charge", async () => {
    vi.mocked(resolvePropertyPayoutOwner).mockResolvedValue({ ok: true, ownerUserId: "other-manager" });
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
      body: JSON.stringify({ chargeId: "hc_unpaid_1", requestId: REQUEST_ID }),
    });
    const res = await sendPaymentReminder(req);
    expect(res.status).toBe(404);
  });

  it("denies a co-manager who can read payments but cannot send Communication", async () => {
    vi.mocked(resolvePropertyPayoutOwner).mockResolvedValue({ ok: true, ownerUserId: "other-manager" });
    mockManagerDb(unpaidCharge());
    const granted = {
      ownerIds: new Set(["other-manager"]),
      propertyIds: new Set(["prop-1"]),
      propertyIdsByOwner: new Map([["other-manager", new Set(["prop-1"])]]),
    };
    vi.mocked(linkedOwnerScopeForModule).mockImplementation(async (_db, _actor, module) =>
      module === "payments"
        ? granted
        : { ownerIds: new Set(), propertyIds: new Set(), propertyIdsByOwner: new Map() },
    );

    const res = await checkPaymentReminder(new Request("http://localhost/api/portal/send-payment-reminder?chargeId=hc_unpaid_1"));
    expect(res.status).toBe(404);
  });

  it("rejects a charge whose property owner cannot be resolved", async () => {
    vi.mocked(resolvePropertyPayoutOwner).mockResolvedValue({ ok: false, reason: "lookup_failed" });
    mockManagerDb(unpaidCharge());

    const res = await checkPaymentReminder(new Request("http://localhost/api/portal/send-payment-reminder?chargeId=hc_unpaid_1"));
    expect(res.status).toBe(404);
  });

  it("rejects a bundled reminder when an additional charge cannot be authorized", async () => {
    mockManagerDb(unpaidCharge());
    const req = new Request("http://localhost/api/portal/send-payment-reminder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chargeId: "hc_unpaid_1", chargeIds: ["hc_unpaid_1", "another-owner-charge"], requestId: REQUEST_ID }),
    });
    const res = await sendPaymentReminder(req);
    expect(res.status).toBe(409);
  });

  it("rejects reminders for a paid charge", async () => {
    mockManagerDb(paidCharge());

    const req = new Request("http://localhost/api/portal/send-payment-reminder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chargeId: "hc_paid_1", residentEmail: "resident@test.com", requestId: REQUEST_ID }),
    });
    const res = await sendPaymentReminder(req);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("charge_paid");
  });

  it("allows a co-manager linked to the charge property", async () => {
    vi.mocked(resolvePropertyPayoutOwner).mockResolvedValue({ ok: true, ownerUserId: "other-manager" });
    const charge = { ...unpaidCharge(), residentEmail: "resident@example.com" };
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
    vi.mocked(linkedOwnerScopeForModule).mockResolvedValue({
      ownerIds: new Set(["other-manager"]),
      propertyIds: new Set(["prop-1"]),
      propertyIdsByOwner: new Map([["other-manager", new Set(["prop-1"])]]),
    });

    const req = new Request("http://localhost/api/portal/send-payment-reminder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chargeId: "hc_unpaid_1", requestId: REQUEST_ID }),
    });
    const res = await sendPaymentReminder(req);
    expect(res.status).toBe(200);
  });

  it("explains that external email is disabled for a demo address", async () => {
    const charge = { ...unpaidCharge(), residentEmail: "resident@axis.local" };
    mockManagerDb(charge);

    const req = new Request("http://localhost/api/portal/send-payment-reminder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chargeId: "hc_unpaid_1", residentEmail: "resident@axis.local", requestId: REQUEST_ID }),
    });
    const res = await sendPaymentReminder(req);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok?: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/test accounts/i);
    expect(deliverManualPaymentReminder).not.toHaveBeenCalled();
  });
});
