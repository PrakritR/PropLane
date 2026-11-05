import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  provider: vi.fn(),
  db: null as unknown,
  holdOwner: "manager-1",
  quoteCurrent: vi.fn(),
  canReply: vi.fn(),
  suppression: vi.fn(),
  consent: vi.fn(),
  reserve: vi.fn(),
  finish: vi.fn(),
}));

vi.mock("@/lib/twilio-client.server", () => ({ createTwilioRestClient: () => ({ messages: { create: mocks.provider } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => mocks.db }));
vi.mock("@/lib/sms/sms-test-transport.server", () => ({ captureSmsTestDelivery: () => false }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({ captureTestWorkspaceEffectForUser: async () => ({ captured: false }) }));
vi.mock("@/lib/protected-accounts.server", () => ({ isShieldedRecipient: async () => false }));
// These cases compose the vendor dispatcher with the real shared-number hold verification.
vi.mock("@/lib/one-number/shared-line-number.server", () => ({ isConfiguredSharedNumber: async (_db: unknown, phone: string) => phone === "+12065550999" }));
vi.mock("@/lib/vendor-sourcing.server", () => ({
  vendorQuoteSmsIsCurrent: mocks.quoteCurrent,
  sourcingConversationCanReply: mocks.canReply,
}));
vi.mock("@/lib/sms/manager-workspace-role.server", () => ({
  resolveOwnerSendNumberRow: vi.fn(async () => ({ data: {
    manager_user_id: "manager-1", phone_number: "+12065550999", phone_number_sid: "PN1",
    messaging_service_sid: "MG1", campaign_sid: "CP1", provision_state: "active",
    registration_state: "registered", registration_ref: null, attachment_state: null,
    number_registration_state: null, grace_started_at: null, grace_expires_at: null,
    quarantined_at: null, quarantine_reason: null,
  }, error: null })),
}));
vi.mock("@/lib/twilio", () => ({ sendSms: mocks.send, normalizeE164: (value: string) => value }));
vi.mock("@/lib/sms-consent", () => ({
  readSmsSuppressionState: mocks.suppression,
  readScopedSmsConsentState: vi.fn(async () => ({ ok: true, state: "granted" })),
}));
vi.mock("@/lib/sms/application-consent.server", () => ({ ensureApplicationScopedSmsConsent: mocks.consent }));
vi.mock("@/lib/sms/number-registration-policy", () => ({
  estimateSmsSegments: () => ({ segmentCount: 1 }),
  evaluateManagerSmsNumberSendability: () => ({ sendable: true }),
  quietHoursBlocks: () => false,
}));
vi.mock("@/lib/comms-billing/eligibility.server", () => ({ evaluateManagerCommsBillingGate: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/comms-billing/rates", () => ({ isCommsPaygBillingEnabled: () => false, unitPriceCentsForMeter: () => 3 }));
vi.mock("@/lib/comms-billing/wallet.server", () => ({
  commsPlanBudget: vi.fn(async () => ({ allowance: 100, legacy: 100 })),
  reserveCommsCredit: mocks.reserve,
  finishCommsCredit: mocks.finish,
}));
vi.mock("@/lib/manager-sms-messages.server", () => ({ logManagerSmsMessage: vi.fn(async () => true) }));
vi.mock("@/lib/sms/prospect-sms-burst.server", () => ({ durableProspectSmsEnabled: () => true }));

import { dispatchOwnerSmsOutbox } from "@/lib/sms/owner-sms-dispatcher.server";

type Row = Record<string, unknown>;

function fixture(purpose: "vendor_quote_request" | "vendor_conversation") {
  const aiReply = purpose === "vendor_conversation";
  const outbox: Row = {
    id: "outbox-1", manager_user_id: "manager-1", actor_user_id: "manager-1",
    recipient_user_id: "vendor-1", recipient_email: null, recipient_phone: "+12065550123",
    body: "Can you help with this service?", send_class: aiReply ? "transactional" : "automated",
    purpose, conversation_key: "manager-1:vendor:vendor-1", counterparty_role: "vendor",
    property_id: null, recipient_timezone: "America/Los_Angeles",
    dedupe_key: aiReply ? "vendor_ai:session-1:turn-1" : "vendor-quote:service-1:user:vendor-1",
    trace_id: null, segment_count: 1, status: "claimed", lease_owner: "worker-1",
    lease_expires_at: "2999-01-01T00:00:00.000Z", dispatch_started_at: null,
    provider_message_sid: null, selected_work_line_id: null, prospect_tour_reminder_id: null,
  };
  const attempt: Row = { id: "attempt-1", outbox_id: outbox.id, attempt_number: 1, state: "submitting" };

  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let update: Row | null = null;
    let inserted: Row | null = null;
    let selectedLineQuery = false;
    const query: Record<string, unknown> = {};
    const self = () => query;
    const matches = (row: Row) => filters.every((filter) => filter(row));
    const apply = () => {
      if (table === "sms_outbox" && update && matches(outbox)) { Object.assign(outbox, update); return true; }
      if (table === "sms_delivery_attempts" && update && matches(attempt)) { Object.assign(attempt, update); return true; }
      return false;
    };
    const value = () => {
      if (table === "manager_sms_numbers") return { manager_user_id: "platform-owner" };
      if (table === "manager_comms_usage_events") return { manager_user_id: mocks.holdOwner, meter: "sms_outbound_segment", quantity: 1, credit_state: "reserved" };
      if (table === "sms_runtime_config") return { mode: "enabled", pilot_manager_user_ids: ["manager-1"] };
      if (table === "agent_sessions") return { id: "session-1", work_order_id: "service-1", vendor_directory_id: "directory-1", vendor_phone_e164: "+12065550123", user_id: "vendor-1", vendor_user_id: "vendor-1" };
      if (table === "sms_outbox") return matches(outbox) ? outbox : null;
      if (table === "sms_delivery_attempts") return matches(attempt) ? attempt : null;
      return null;
    };
    Object.assign(query, {
      select: self,
      neq: self,
      eq(column: string, expected: unknown) { filters.push((row: Row) => row[column] === expected); return query; },
      in(column: string, expected: unknown[]) { selectedLineQuery = table === "sms_outbox"; filters.push((row: Row) => expected.includes(row[column])); return query; },
      is(column: string, expected: unknown) { filters.push((row: Row) => row[column] === expected); return query; },
      gt(column: string, expected: string) { filters.push((row: Row) => String(row[column] ?? "") > expected); return query; },
      lt(column: string, expected: string) { filters.push((row: Row) => String(row[column] ?? "") < expected); return query; },
      order: self,
      limit: self,
      update(payload: Row) { update = payload; return query; },
      insert(payload: Row) { inserted = payload; return query; },
      maybeSingle: async () => {
        const updated = apply();
        return { data: update ? (updated ? (table === "sms_outbox" ? outbox : attempt) : null) : value(), error: null };
      },
      single: async () => {
        if (table === "sms_delivery_attempts" && inserted) Object.assign(attempt, inserted);
        return { data: table === "sms_delivery_attempts" ? attempt : value(), error: null };
      },
      then(resolve: (result: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        apply();
        let data: unknown = value();
        if (selectedLineQuery && !update) data = [{ id: outbox.id, selected_work_line_id: null }];
        if (table === "sms_outbox" && filters.length === 0 && !update) data = [{ ...outbox }];
        if (table === "sms_delivery_attempts" && !update) data = [];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    });
    return query;
  };

  const db = {
    from,
    rpc: vi.fn(async (name: string) => {
      if (name === "claim_sms_outbox") return { data: [{ ...outbox }], error: null };
      if (name === "spend_sms_outbox_segment_budget") return { data: true, error: null };
      return { data: null, error: null };
    }),
  } as never;
  return { db, outbox, attempt };
}

describe("vendor SMS dispatch final policy fence", () => {
  beforeEach(() => {
    vi.stubEnv("SMS_RUNTIME_ENABLED", "1");
    vi.stubEnv("SMS_OUTBOX_SCHEDULER_READY", "1");
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG1");
    vi.stubEnv("TWILIO_CAMPAIGN_SID", "CP1");
    mocks.db = null;
    mocks.holdOwner = "manager-1";
    mocks.provider.mockReset().mockResolvedValue({ sid: "SM-vendor" });
    mocks.send.mockReset().mockResolvedValue({ sent: true, sid: "SM-vendor" });
    mocks.quoteCurrent.mockReset().mockResolvedValue(true);
    mocks.canReply.mockReset().mockResolvedValue(true);
    mocks.suppression.mockReset().mockResolvedValue({ ok: true, optedOut: false });
    mocks.consent.mockReset().mockResolvedValue({ ok: true, granted: true });
    mocks.finish.mockReset().mockResolvedValue(undefined);
    mocks.reserve.mockReset().mockImplementation(async () => ({ allowed: true, duplicate: false, state: "reserved" }));
  });

  it.each(["manager pause", "last quote rejected"])("blocks a claimed quote opening after %s following credit reservation", async () => {
    const { db, outbox, attempt } = fixture("vendor_quote_request");
    mocks.quoteCurrent
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, db)).resolves.toMatchObject({ submitted: 0, blocked: 1 });

    expect(mocks.quoteCurrent).toHaveBeenCalledTimes(2);
    expect(mocks.quoteCurrent.mock.calls[1]?.[1]).toMatchObject({
      managerUserId: "manager-1", recipientUserId: "vendor-1", recipientPhone: "+12065550123",
      conversationKey: "manager-1:vendor:vendor-1", counterpartyRole: "vendor",
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith(db, "manager-1", "sms_outbound:outbox-1", true);
    expect(outbox).toMatchObject({ status: "blocked", blocked_reason: "vendor_sourcing_stopped" });
    expect(attempt).toMatchObject({ state: "pre_dispatch_failed" });
  });

  it("blocks a quote opening when STOP arrives after credit reservation", async () => {
    const { db, outbox, attempt } = fixture("vendor_quote_request");
    mocks.suppression
      .mockResolvedValueOnce({ ok: true, optedOut: false })
      .mockResolvedValueOnce({ ok: true, optedOut: true });

    await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, db)).resolves.toMatchObject({ submitted: 0, blocked: 1 });

    expect(mocks.suppression).toHaveBeenCalledTimes(2);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith(db, "manager-1", "sms_outbound:outbox-1", true);
    expect(outbox).toMatchObject({ status: "blocked", blocked_reason: "recipient_opted_out" });
    expect(attempt).toMatchObject({ state: "pre_dispatch_failed" });
  });

  it("blocks a vendor AI reply when the manager pauses the job after credit reservation", async () => {
    const { db, outbox, attempt } = fixture("vendor_conversation");
    mocks.canReply.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, db)).resolves.toMatchObject({ submitted: 0, blocked: 1 });

    expect(mocks.canReply).toHaveBeenCalledTimes(2);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith(db, "manager-1", "sms_outbound:outbox-1", true);
    expect(outbox).toMatchObject({ status: "blocked", blocked_reason: "vendor_sourcing_conversation_stopped" });
    expect(attempt).toMatchObject({ state: "pre_dispatch_failed" });
  });

  it("blocks a vendor AI reply when STOP arrives after credit reservation", async () => {
    const { db, outbox, attempt } = fixture("vendor_conversation");
    mocks.suppression
      .mockResolvedValueOnce({ ok: true, optedOut: false })
      .mockResolvedValueOnce({ ok: true, optedOut: true });

    await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, db)).resolves.toMatchObject({ submitted: 0, blocked: 1 });

    expect(mocks.suppression).toHaveBeenCalledTimes(2);
    expect(mocks.canReply).toHaveBeenCalledTimes(2);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith(db, "manager-1", "sms_outbound:outbox-1", true);
    expect(outbox).toMatchObject({ status: "blocked", blocked_reason: "recipient_opted_out" });
    expect(attempt).toMatchObject({ state: "pre_dispatch_failed" });
  });

  it("blocks a vendor AI reply whose outbox recipient no longer matches the session identity", async () => {
    const { db, outbox } = fixture("vendor_conversation");
    outbox.recipient_user_id = "vendor-2";

    await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, db)).resolves.toMatchObject({ submitted: 0, blocked: 1 });

    expect(mocks.canReply).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(outbox).toMatchObject({ status: "blocked", blocked_reason: "vendor_sourcing_conversation_stopped" });
  });

  it("uses a fresh credit reservation for an explicitly rearmed unsent intent", async () => {
    const { db, outbox } = fixture("vendor_quote_request");
    outbox.sourcing_retry_generation = 1;
    await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, db)).resolves.toMatchObject({ submitted: 1 });
    expect(mocks.reserve).toHaveBeenCalledWith(db, expect.objectContaining({ idempotencyKey: "sms_outbound:outbox-1:sourcing-retry:1" }));
    expect(mocks.finish).toHaveBeenCalledWith(db, "manager-1", "sms_outbound:outbox-1:sourcing-retry:1");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it.each(["vendor_quote_request", "vendor_conversation"] as const)("submits a current %s once", async (purpose) => {
    const { db, outbox } = fixture(purpose);

    await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, db)).resolves.toMatchObject({ submitted: 1, blocked: 0 });

    if (purpose === "vendor_quote_request") expect(mocks.quoteCurrent).toHaveBeenCalledTimes(2);
    else expect(mocks.canReply).toHaveBeenCalledTimes(2);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith("+12065550123", outbox.body, expect.any(String), expect.objectContaining({ expectedPayerUserId: "manager-1", creditReservationKey: "sms_outbound:outbox-1" }));
    expect(mocks.finish).toHaveBeenCalledWith(db, "manager-1", "sms_outbound:outbox-1");
    expect(outbox).toMatchObject({ status: "submitted", provider_message_sid: "SM-vendor" });
  });

  it.each(["vendor_quote_request", "vendor_conversation"] as const)("composes %s with shared-number payer verification and final refusals", async (purpose) => {
    const transport = await vi.importActual<typeof import("@/lib/twilio")>("@/lib/twilio");
    mocks.send.mockImplementation(transport.sendSms);
    let f = fixture(purpose);
    mocks.db = f.db;
    await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, f.db)).resolves.toMatchObject({ submitted: 1 });
    expect(mocks.provider).toHaveBeenCalledTimes(1);

    for (const refusal of ["foreign payer", "STOP", "stopped sourcing"] as const) {
      mocks.provider.mockClear();
      mocks.holdOwner = refusal === "foreign payer" ? "foreign-manager" : "manager-1";
      mocks.suppression.mockReset().mockResolvedValue({ ok: true, optedOut: false });
      mocks.quoteCurrent.mockReset().mockResolvedValue(true);
      mocks.canReply.mockReset().mockResolvedValue(true);
      if (refusal === "STOP") mocks.suppression.mockResolvedValueOnce({ ok: true, optedOut: false }).mockResolvedValueOnce({ ok: true, optedOut: true });
      if (refusal === "stopped sourcing") (purpose === "vendor_quote_request" ? mocks.quoteCurrent : mocks.canReply).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      f = fixture(purpose);
      mocks.db = f.db;
      await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, f.db)).resolves.toMatchObject({ submitted: 0, blocked: 1 });
      expect(mocks.provider, refusal).not.toHaveBeenCalled();
    }
  });
});
