import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  send: vi.fn(),
  plan: vi.fn(),
  billing: vi.fn(),
  reserve: vi.fn(),
  finish: vi.fn(),
  ownerNumber: vi.fn(),
  suppression: vi.fn(),
  scopedConsent: vi.fn(),
  consent: vi.fn(),
  logMessage: vi.fn(),
}));

vi.mock("@/lib/sms/prospect-sms-burst.server", () => ({
  durableProspectSmsEnabled: mocks.enabled,
}));
vi.mock("@/lib/twilio", () => ({ sendSms: mocks.send }));
vi.mock("@/lib/comms-billing/wallet.server", () => ({
  commsPlanBudget: mocks.plan,
  reserveCommsCredit: mocks.reserve,
  finishCommsCredit: mocks.finish,
}));
vi.mock("@/lib/comms-billing/eligibility.server", () => ({
  evaluateManagerCommsBillingGate: mocks.billing,
}));
vi.mock("@/lib/sms/manager-workspace-role.server", () => ({
  resolveOwnerSendNumberRow: mocks.ownerNumber,
}));
vi.mock("@/lib/sms/number-registration-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms/number-registration-policy")>()),
  evaluateManagerSmsNumberSendability: () => ({ sendable: true }),
  quietHoursBlocks: () => false,
}));
vi.mock("@/lib/sms-consent", () => ({
  readSmsSuppressionState: mocks.suppression,
  readScopedSmsConsentState: mocks.scopedConsent,
}));
vi.mock("@/lib/sms/application-consent.server", () => ({
  ensureApplicationScopedSmsConsent: mocks.consent,
}));
vi.mock("@/lib/manager-sms-messages.server", () => ({
  logManagerSmsMessage: mocks.logMessage,
}));

const MANAGER_ID = "manager-1";
const OUTBOX_ID = "outbox-booking-1";
const ATTEMPT_ID = "attempt-booking-1";

const bookingRow = {
  id: OUTBOX_ID,
  manager_user_id: MANAGER_ID,
  actor_user_id: MANAGER_ID,
  recipient_user_id: null,
  recipient_email: "prospect@example.com",
  recipient_phone: "+15550001111",
  body: "Your tour is confirmed for Thursday at 10:00 AM.",
  send_class: "control",
  purpose: "prospect_tour_booking_confirmation",
  conversation_key: `${MANAGER_ID}:prospect:+15550001111`,
  counterparty_role: "prospect",
  property_id: "property-1",
  recipient_timezone: "America/Los_Angeles",
  dedupe_key: "tour-booking-confirmation:booking-1",
  trace_id: null,
  segment_count: 1,
  prospect_burst_id: null,
  prospect_burst_revision: null,
  prospect_burst_worker_id: null,
  prospect_tour_reminder_id: null,
  prospect_tour_booking_confirmation_id: "booking-1",
  transport: "twilio",
  transport_from_number: null,
};

function queryFor(table: string) {
  let inserted = false;
  const query: Record<string, unknown> = {};
  const terminal = () => {
    if (table === "sms_runtime_config") {
      return { data: { mode: "automatic", pilot_manager_user_ids: [MANAGER_ID] }, error: null };
    }
    if (table === "manager_sms_numbers") {
      return {
        data: {
          manager_user_id: MANAGER_ID,
          phone_number: "+15550009999",
          phone_number_sid: "PN-SINK",
          messaging_service_sid: "MG-SINK",
          campaign_sid: "CA-SINK",
          provision_state: "active",
          registration_state: "approved",
          registration_ref: "manager-registration",
          attachment_state: "attached",
          number_registration_state: "registered",
          grace_started_at: null,
          grace_expires_at: null,
          quarantined_at: null,
          quarantine_reason: null,
        },
        error: null,
      };
    }
    if (table === "sms_delivery_attempts") {
      return inserted
        ? { data: { id: ATTEMPT_ID }, error: null }
        : { data: [], error: null };
    }
    if (table === "sms_outbox") {
      return { data: { id: OUTBOX_ID }, error: null };
    }
    return { data: null, error: null };
  };
  const self = () => query;
  query.select = self;
  query.update = self;
  query.insert = () => {
    inserted = true;
    return query;
  };
  query.eq = self;
  query.is = self;
  query.lt = self;
  query.gt = self;
  query.order = self;
  query.limit = self;
  query.maybeSingle = async () => terminal();
  query.single = async () => terminal();
  query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(terminal()).then(resolve, reject);
  return query;
}

function createDb(boundary: ReturnType<typeof vi.fn>, row = bookingRow) {
  return {
    from: vi.fn((table: string) => queryFor(table)),
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "claim_sms_outbox") return { data: [row], error: null };
      if (name === "begin_prospect_tour_booking_confirmation_submission_v2") {
        boundary(name, args);
        return { data: { outcome: "started", costs_reserved: true }, error: null };
      }
      if (name === "begin_prospect_tour_reminder_submission") {
        boundary(name, args);
        return { data: "started", error: null };
      }
      if (name === "prospect_tour_reminder_submission_is_current") {
        boundary(name, args);
        return { data: true, error: null };
      }
      if (name === "apply_sms_delivery_status") return { data: true, error: null };
      return { data: true, error: null };
    }),
  } as never;
}

describe("owner dispatcher tour booking confirmation boundary", () => {
  beforeEach(() => {
    mocks.enabled.mockReset();
    mocks.send.mockReset();
    mocks.plan.mockReset();
    mocks.billing.mockReset();
    mocks.reserve.mockReset();
    mocks.finish.mockReset();
    mocks.ownerNumber.mockReset();
    mocks.suppression.mockReset();
    mocks.scopedConsent.mockReset();
    mocks.logMessage.mockReset();
    mocks.enabled.mockReturnValue(true);
    mocks.plan.mockResolvedValue({ allowance: 1500, legacy: 1500 });
    mocks.billing.mockResolvedValue({ allowed: true });
    mocks.reserve.mockResolvedValue({ allowed: true, duplicate: false, state: "reserved" });
    mocks.finish.mockResolvedValue(undefined);
    mocks.ownerNumber.mockResolvedValue({ data: {
      manager_user_id: MANAGER_ID,
      phone_number: "+15550009999",
      phone_number_sid: "PN-SINK",
      messaging_service_sid: "MG-SINK",
      campaign_sid: "CA-SINK",
      provision_state: "active",
      registration_state: "approved",
      registration_ref: "manager-registration",
      attachment_state: "attached",
      number_registration_state: "registered",
      grace_started_at: null,
      grace_expires_at: null,
      quarantined_at: null,
      quarantine_reason: null,
    }, error: null });
    mocks.suppression.mockResolvedValue({ ok: true, optedOut: false });
    mocks.scopedConsent.mockResolvedValue({ ok: true, state: "granted" });
    mocks.consent.mockResolvedValue({ ok: true, granted: true });
    mocks.logMessage.mockResolvedValue(true);
    mocks.send.mockResolvedValue({ sent: true, sid: "SM-SINK-1" });
    vi.stubEnv("SMS_RUNTIME_ENABLED", "1");
    vi.stubEnv("SMS_OUTBOX_SCHEDULER_READY", "1");
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG-SINK");
    vi.stubEnv("TWILIO_CAMPAIGN_SID", "CA-SINK");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the booking-keyed final fence before the provider sink", async () => {
    const boundary = vi.fn();
    const db = createDb(boundary);
    const { dispatchOwnerSmsOutbox } = await import("@/lib/sms/owner-sms-dispatcher.server");

    const result = await dispatchOwnerSmsOutbox({ workerId: "worker-booking-1" }, db);

    expect(result).toMatchObject({ ok: true, claimed: 1, submitted: 1, blocked: 0, unknown: 0 });
    expect(boundary).toHaveBeenCalledTimes(1);
    expect(boundary).toHaveBeenCalledWith(
      "begin_prospect_tour_booking_confirmation_submission_v2",
      expect.objectContaining({
        p_booking_id: "booking-1",
        p_outbox_id: OUTBOX_ID,
        p_attempt_id: ATTEMPT_ID,
        p_outbox_worker_id: "worker-booking-1",
        p_allowance: 1500,
        p_legacy_allowance: 1500,
      }),
    );
    expect(db.rpc).not.toHaveBeenCalledWith("begin_sms_outbox_submission", expect.anything());
    expect(mocks.send).toHaveBeenCalledWith(
      bookingRow.recipient_phone,
      bookingRow.body,
      "+15550009999",
      { skipOptOutCheck: true, creditReservationKey: `sms_outbound:${OUTBOX_ID}` },
    );
  });

  it("does not retry an accepted-but-unknown provider outcome", async () => {
    const boundary = vi.fn();
    const db = createDb(boundary);
    mocks.send.mockResolvedValue({ sent: false, error: "Twilio accepted request but response was lost" });
    const { dispatchOwnerSmsOutbox } = await import("@/lib/sms/owner-sms-dispatcher.server");

    const result = await dispatchOwnerSmsOutbox({ workerId: "worker-unknown-provider" }, db);

    expect(result).toMatchObject({ ok: true, claimed: 1, submitted: 0, unknown: 1 });
    expect(boundary).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it("blocks a booking confirmation when scoped consent is revoked before dispatch", async () => {
    const boundary = vi.fn();
    const revokedRow = { ...bookingRow, send_class: "transactional" };
    const db = createDb(boundary, revokedRow);
    mocks.consent.mockResolvedValue({ ok: true, granted: false });
    const { dispatchOwnerSmsOutbox } = await import("@/lib/sms/owner-sms-dispatcher.server");

    const result = await dispatchOwnerSmsOutbox({ workerId: "worker-revoked-consent" }, db);

    expect(result).toMatchObject({ ok: true, claimed: 1, submitted: 0, blocked: 1, unknown: 0 });
    expect(boundary).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("rechecks a prospect reminder after budget and credit awaits before provider submission", async () => {
    const reminderRow = {
      ...bookingRow,
      id: "outbox-reminder-1",
      send_class: "automated",
      purpose: "prospect_tour_followup",
      conversation_key: `${MANAGER_ID}:prospect:+15550001111`,
      property_id: "property-1",
      dedupe_key: "prospect-tour-reminder:reminder-1",
      prospect_tour_reminder_id: "reminder-1",
      prospect_tour_booking_confirmation_id: null,
    };
    const boundary = vi.fn();
    const db = createDb(boundary, reminderRow);
    db.rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "claim_sms_outbox") return { data: [reminderRow], error: null };
      if (name === "begin_prospect_tour_reminder_submission") {
        boundary(name, args);
        return { data: "started", error: null };
      }
      if (name === "prospect_tour_reminder_submission_is_current") {
        boundary(name, args);
        return { data: false, error: null };
      }
      return { data: true, error: null };
    }) as never;
    const { dispatchOwnerSmsOutbox } = await import("@/lib/sms/owner-sms-dispatcher.server");

    const result = await dispatchOwnerSmsOutbox({ workerId: "worker-reminder-1" }, db);

    expect(result).toMatchObject({ ok: true, claimed: 1, submitted: 0, blocked: 1, unknown: 0 });
    expect(boundary).toHaveBeenCalledWith(
      "prospect_tour_reminder_submission_is_current",
      expect.objectContaining({
        p_reminder_id: "reminder-1",
        p_outbox_id: "outbox-reminder-1",
        p_outbox_worker_id: "worker-reminder-1",
        p_manager_user_id: MANAGER_ID,
        p_conversation_key: reminderRow.conversation_key,
        p_recipient_phone_e164: reminderRow.recipient_phone,
        p_property_id: reminderRow.property_id,
      }),
    );
    expect(mocks.finish).toHaveBeenCalledWith(db, MANAGER_ID, "sms_outbound:outbox-reminder-1", true);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("submits a prospect reminder only after its final durable fence remains current", async () => {
    const reminderRow = {
      ...bookingRow,
      id: "outbox-reminder-current",
      send_class: "automated",
      purpose: "prospect_tour_followup",
      conversation_key: `${MANAGER_ID}:prospect:+15550001111`,
      property_id: "property-1",
      dedupe_key: "prospect-tour-reminder:reminder-current",
      prospect_tour_reminder_id: "reminder-current",
      prospect_tour_booking_confirmation_id: null,
    };
    const boundary = vi.fn();
    const db = createDb(boundary, reminderRow);
    const { dispatchOwnerSmsOutbox } = await import("@/lib/sms/owner-sms-dispatcher.server");

    const result = await dispatchOwnerSmsOutbox({ workerId: "worker-reminder-current" }, db);

    expect(result).toMatchObject({ ok: true, claimed: 1, submitted: 1, blocked: 0, unknown: 0 });
    expect(boundary).toHaveBeenCalledWith(
      "prospect_tour_reminder_submission_is_current",
      expect.objectContaining({ p_reminder_id: "reminder-current" }),
    );
    expect(mocks.send).toHaveBeenCalledOnce();
  });
});
