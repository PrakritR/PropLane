import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendSms: vi.fn(),
  log: vi.fn(),
  readSuppression: vi.fn(),
}));

vi.mock("@/lib/twilio", () => ({
  sendSms: mocks.sendSms,
  normalizeE164: (phone: string) => phone.startsWith("+") ? phone : `+1${phone.replace(/\D/g, "")}`,
}));
vi.mock("@/lib/manager-sms-messages.server", () => ({ logManagerSmsMessage: mocks.log }));
vi.mock("@/lib/sms/manager-sms-entitlement.server", () => ({
  getEffectiveManagerSmsEntitlement: vi.fn(async () => ({ eligible: true, reason: "included" })),
}));
vi.mock("@/lib/sms/application-consent.server", () => ({
  ensureApplicationScopedSmsConsent: vi.fn(async () => ({ ok: true, granted: true })),
}));
vi.mock("@/lib/sms-consent", () => ({
  readSmsSuppressionState: mocks.readSuppression,
  normalizeConsentPhone: (phone: string) => phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""),
}));
vi.mock("@/lib/sms/number-registration-policy", () => ({
  estimateSmsSegments: vi.fn(() => ({ segmentCount: 1 })),
  evaluateManagerSmsNumberSendability: vi.fn(() => ({ sendable: true })),
  quietHoursBlocks: vi.fn(() => false),
}));
vi.mock("@/lib/comms-billing/rates", () => ({ isCommsPaygBillingEnabled: vi.fn(() => false), unitPriceCentsForMeter: () => 3 }));

import {
  dispatchOwnerSmsOutbox,
  reconcileSubmittedSmsConversationLogs,
} from "@/lib/sms/owner-sms-dispatcher.server";
import { reserveCommsCredit } from "@/lib/comms-billing/wallet.server";

type Row = Record<string, unknown>;

function dispatchDb({
  failFirstConversationLogMarkerWrite = false,
  derivedTourConsent,
  recipientUserId,
}: {
  failFirstConversationLogMarkerWrite?: boolean;
  derivedTourConsent?: "allowed" | "revoked";
  recipientUserId?: string | null;
} = {}) {
  const outbox: Row = {
    id: "outbox-1", manager_user_id: "manager-1", actor_user_id: "manager-1",
    recipient_user_id: recipientUserId ?? null, recipient_email: "prospect@example.com", recipient_phone: "+12065550142",
    body: "Your application has been approved.", send_class: "transactional",
    purpose: "application_approved_notification", conversation_key: "manager-1:prospect:+12065550142",
    counterparty_role: "prospect", property_id: "property-1", recipient_timezone: "America/Los_Angeles",
    dedupe_key: "approval-1", trace_id: null, segment_count: 1, status: "claimed", lease_owner: "worker-1",
    lease_expires_at: "2999-01-01T00:00:00.000Z", conversation_log_status: "pending", conversation_log_attempts: 0,
  };
  if (derivedTourConsent) outbox.purpose = "tour_rescheduled";
  const consentEvents: Row[] = derivedTourConsent ? [
    {
      recipient_phone_key: "2065550142", manager_user_id: "manager-1",
      messaging_service_sid: "MG1", purpose: "tour_rescheduled", send_class: "transactional",
      conversation_key: "manager-1:prospect:+12065550142", event_type: "granted",
      source: "recipient_initiated_inbound", occurred_at: "2026-09-10T10:00:00.000Z",
      evidence: { conversationPurpose: "manager_conversation" },
    },
    {
      recipient_phone_key: "2065550142", manager_user_id: "manager-1",
      messaging_service_sid: "MG1", purpose: "manager_conversation", send_class: "transactional",
      conversation_key: "manager-1:prospect:+12065550142",
      event_type: derivedTourConsent === "allowed" ? "granted" : "revoked",
      source: derivedTourConsent === "allowed" ? "recipient_initiated_inbound" : "twilio_stop",
      occurred_at: "2026-09-10T10:01:00.000Z", evidence: {},
    },
  ] : [];
  const attempts: Row[] = [];
  let claimAvailable = true;
  let campaignAllocations = 0;
  let markerWriteFailed = false;
  const matching = (filters: Array<(r: Row) => boolean>) => filters.every((filter) => filter(outbox));

  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let update: Row | null = null;
    let inserted: Row | null = null;
    let limitCalled = false;
    const result = () => {
      if (table === "sms_runtime_config") return { data: { mode: "enabled", pilot_manager_user_ids: ["manager-1"] }, error: null };
      if (table === "manager_sms_numbers") return { data: { manager_user_id: "manager-1", phone_number: "+12065550999", phone_number_sid: "PN1", messaging_service_sid: "MG1", campaign_sid: "CP1", provision_state: "active", registration_state: "registered", registration_ref: null, attachment_state: null, number_registration_state: null, grace_started_at: null, grace_expires_at: null, quarantined_at: null, quarantine_reason: null }, error: null };
      if (table === "sms_delivery_attempts") return { data: [], error: null };
      if (table === "sms_delivery_events") return { data: null, error: null };
      if (table === "sms_consent_events") {
        return { data: consentEvents.filter((row) => filters.every((filter) => filter(row))), error: null };
      }
      if (table === "sms_outbox") return { data: matching(filters) ? (limitCalled ? [{ ...outbox }] : outbox) : (limitCalled ? [] : null), error: null };
      return { data: null, error: null };
    };
    // This fluent fake intentionally supports a wider subset of the Supabase
    // builder than this test consumes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: Record<string, any> = {
      select() { return q; },
      eq(column: string, value: unknown) { filters.push((r) => r[column] === value); return q; },
      gt(column: string, value: string) { filters.push((r) => String(r[column] ?? "") > value); return q; },
      lt(column: string, value: string) { filters.push((r) => String(r[column] ?? "") < value); return q; },
      lte(column: string, value: string) { filters.push((r) => String(r[column] ?? "") <= value); return q; },
      in(column: string, values: unknown[]) { filters.push((r) => values.includes(r[column])); return q; },
      not(column: string, _operator: string, value: unknown) { filters.push((r) => r[column] !== value); return q; },
      is(column: string, value: unknown) { filters.push((r) => r[column] === value); return q; },
      order() { return q; },
      limit() { limitCalled = true; return q; },
      update(payload: Row) { update = payload; return q; },
      insert(payload: Row) {
        inserted = payload;
        if (table === "sms_delivery_attempts") attempts.push({ id: `attempt-${attempts.length + 1}`, ...payload });
        return q;
      },
      maybeSingle() {
        if (
          table === "sms_outbox" &&
          update &&
          !markerWriteFailed &&
          failFirstConversationLogMarkerWrite &&
          (update.conversation_log_status === "failed" || update.conversation_log_status === "persisted")
        ) {
          markerWriteFailed = true;
          return Promise.resolve({ data: null, error: { message: "marker write unavailable" } });
        }
        const matched = table !== "sms_outbox" || matching(filters);
        if (table === "sms_outbox" && update && matched) {
          Object.assign(outbox, update);
          return Promise.resolve({ data: { ...outbox }, error: null });
        }
        if (table === "sms_delivery_attempts" && update) Object.assign(attempts[0] ?? {}, update);
        return Promise.resolve(result());
      },
      single() {
        if (table === "sms_delivery_attempts" && inserted) return Promise.resolve({ data: attempts.at(-1), error: null });
        return Promise.resolve(result());
      },
      then(resolve: (value: unknown) => unknown) {
        // Stale-submission update has incompatible filters, so never mutates this row.
        if (table === "sms_outbox" && update && matching(filters)) Object.assign(outbox, update);
        return Promise.resolve(result()).then(resolve);
      },
    };
    return q;
  };
  return {
    outbox,
    reclaim() {
      claimAvailable = true;
      Object.assign(outbox, { status: "claimed", lease_owner: "worker-1", lease_expires_at: "2999-01-01T00:00:00.000Z" });
    },
    campaignAllocations: () => campaignAllocations,
    db: {
      from,
      rpc: vi.fn(async (name: string) => {
        if (name === "claim_sms_outbox") {
          if (!claimAvailable) return { data: [], error: null };
          claimAvailable = false;
          return { data: [{ ...outbox }], error: null };
        }
        if (name === "spend_sms_outbox_segment_budget") {
          const today = new Date().toISOString().slice(0, 10);
          if (outbox.campaign_budget_spent_on !== today) {
            campaignAllocations += 1;
            outbox.campaign_budget_spent_on = today;
          }
          return { data: true, error: null };
        }
        return { data: null, error: null };
      }),
    } as never,
  };
}

describe("dispatcher conversation-log repair handoff", () => {
  beforeEach(() => {
    process.env.SMS_RUNTIME_ENABLED = "1";
    process.env.SMS_OUTBOX_SCHEDULER_READY = "1";
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG1";
    process.env.TWILIO_CAMPAIGN_SID = "CP1";
    mocks.sendSms.mockReset().mockResolvedValue({ sent: true, sid: "SM-original" });
    mocks.log.mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.readSuppression.mockReset().mockResolvedValue({ ok: true, optedOut: false });
    vi.mocked(reserveCommsCredit).mockReset().mockResolvedValue({ allowed: true, duplicate: false, state: "reserved" });
  });

  it("submits once, snapshots the original sender, then repairs the same SID without a provider resend", async () => {
    const { db, outbox } = dispatchDb();
    await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, db)).resolves.toMatchObject({
      claimed: 1, submitted: 1, infrastructureErrors: ["conversation_log_persistence_unavailable"],
    });
    expect(mocks.sendSms).toHaveBeenCalledTimes(1);
    expect(outbox).toMatchObject({
      status: "submitted", provider_message_sid: "SM-original", provider_from_phone: "+12065550999",
      conversation_log_status: "failed", conversation_log_attempts: 1,
    });
    expect(mocks.log).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      messageSid: "SM-original", conversationKey: "manager-1:prospect:+12065550142", fromPhone: "+12065550999",
    }));

    // A manager number can rotate after submission. Repair uses the persisted
    // sender snapshot, never today's control-plane number.
    outbox.conversation_log_next_attempt_at = "2020-01-01T00:00:00.000Z";
    await expect(reconcileSubmittedSmsConversationLogs(db, 10)).resolves.toEqual({ ok: true, attempted: 1, persisted: 1, failed: 0 });
    await expect(reconcileSubmittedSmsConversationLogs(db, 10)).resolves.toEqual({ ok: true, attempted: 0, persisted: 0, failed: 0 });
    expect(mocks.sendSms).toHaveBeenCalledTimes(1);
    expect(mocks.log).toHaveBeenCalledTimes(2);
    expect(mocks.log.mock.calls[1]?.[1]).toMatchObject({ fromPhone: "+12065550999", messageSid: "SM-original" });
    expect(outbox).toMatchObject({ conversation_log_status: "persisted", conversation_log_attempts: 2 });
  });

  it("repairs the atomically stored pending marker when the first marker write fails", async () => {
    const { db, outbox } = dispatchDb({ failFirstConversationLogMarkerWrite: true });
    await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, db)).resolves.toMatchObject({
      claimed: 1, submitted: 1, infrastructureErrors: ["conversation_log_persistence_unavailable"],
    });
    expect(outbox).toMatchObject({
      status: "submitted", provider_message_sid: "SM-original", provider_from_phone: "+12065550999",
      conversation_log_status: "pending", conversation_log_attempts: 0,
    });
    outbox.conversation_log_next_attempt_at = "2020-01-01T00:00:00.000Z";
    await expect(reconcileSubmittedSmsConversationLogs(db, 10)).resolves.toEqual({ ok: true, attempted: 1, persisted: 1, failed: 0 });
    expect(mocks.sendSms).toHaveBeenCalledTimes(1);
    expect(mocks.log).toHaveBeenCalledTimes(2);
    expect(outbox).toMatchObject({ conversation_log_status: "persisted", conversation_log_attempts: 1 });
  });

  it("quarantines an explicit invalid conversation key without writing a fallback thread", async () => {
    const { db, outbox } = dispatchDb();
    outbox.conversation_key = "other-manager:prospect:+12065550142";
    await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, db)).resolves.toMatchObject({
      claimed: 1,
      submitted: 1,
      infrastructureErrors: ["conversation_log_projection_invalid_identity"],
    });
    expect(mocks.sendSms).toHaveBeenCalledTimes(1);
    expect(mocks.log).not.toHaveBeenCalled();
    expect(outbox).toMatchObject({
      provider_message_sid: "SM-original",
      conversation_log_status: "blocked",
      conversation_log_last_error: "invalid_conversation_key",
      conversation_log_next_attempt_at: null,
    });
  });

  it("blocks a queued conversation-derived tour after its source authority is revoked", async () => {
    const { db, outbox, campaignAllocations } = dispatchDb({ derivedTourConsent: "revoked" });
    await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, db)).resolves.toMatchObject({
      claimed: 1,
      submitted: 0,
      blocked: 1,
    });
    expect(campaignAllocations()).toBe(0);
    expect(vi.mocked(reserveCommsCredit)).not.toHaveBeenCalled();
    expect(mocks.sendSms).not.toHaveBeenCalled();
    expect(outbox).toMatchObject({ status: "blocked", blocked_reason: "tour_sms_consent_missing" });
  });

  it("rechecks a claimed row against user-keyed STOP when the queued phone has changed", async () => {
    const { db, outbox, campaignAllocations } = dispatchDb({ recipientUserId: "resident-1" });
    outbox.recipient_phone = "+12065550199";
    mocks.readSuppression.mockImplementation(async (_db, _phone, options) => ({
      ok: true,
      optedOut: options?.userId === "resident-1",
    }));

    await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, db)).resolves.toMatchObject({
      claimed: 1,
      submitted: 0,
      blocked: 1,
    });
    expect(mocks.readSuppression).toHaveBeenCalledWith(expect.anything(), "+12065550199", { userId: "resident-1" });
    expect(campaignAllocations()).toBe(0);
    expect(vi.mocked(reserveCommsCredit)).not.toHaveBeenCalled();
    expect(mocks.sendSms).not.toHaveBeenCalled();
    expect(outbox).toMatchObject({ status: "blocked", blocked_reason: "recipient_opted_out" });
  });

  it("retains campaign and wallet dispatch for a currently authorized derived tour", async () => {
    const { db, outbox, campaignAllocations } = dispatchDb({ derivedTourConsent: "allowed" });
    await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, db)).resolves.toMatchObject({
      claimed: 1,
      submitted: 1,
    });
    expect(campaignAllocations()).toBe(1);
    expect(vi.mocked(reserveCommsCredit)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        managerUserId: "manager-1",
        meter: "sms_outbound_segment",
        quantity: 1,
        idempotencyKey: "sms_outbound:outbox-1",
      }),
    );
    expect(mocks.sendSms).toHaveBeenCalledTimes(1);
    expect(outbox).toMatchObject({ status: "submitted", provider_message_sid: "SM-original" });
  });
});

vi.mock("@/lib/comms-billing/eligibility.server", () => ({evaluateManagerCommsBillingGate:vi.fn(async()=>({allowed:true}))}));
vi.mock("@/lib/comms-billing/wallet.server", () => ({reserveCommsCredit:vi.fn(async()=>({allowed:true,duplicate:false,state:"reserved"})),finishCommsCredit:vi.fn(async()=>{})}));

describe("dispatcher credit reservation outcomes", () => {
  beforeEach(() => {
    process.env.SMS_RUNTIME_ENABLED = "1";
    process.env.SMS_OUTBOX_SCHEDULER_READY = "1";
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG1";
    process.env.TWILIO_CAMPAIGN_SID = "CP1";
    mocks.sendSms.mockReset().mockResolvedValue({ sent: true, sid: "SM-original" });
    mocks.log.mockReset().mockResolvedValue(true);
    vi.mocked(reserveCommsCredit).mockReset();
  });

  it("defers, rather than blocks, when the wallet itself could not be read", async () => {
    vi.mocked(reserveCommsCredit).mockRejectedValueOnce(new Error("plan unreadable"));
    const { db, outbox } = dispatchDb();
    const before = Date.now();
    await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, db)).resolves.toMatchObject({
      ok: true, claimed: 1, submitted: 0, blocked: 0, unknown: 0,
    });
    expect(mocks.sendSms).not.toHaveBeenCalled();
    expect(outbox).toMatchObject({
      status: "deferred", blocked_reason: "credit_unavailable", lease_owner: null, dispatch_started_at: null,
    });
    expect(Date.parse(String(outbox.available_at))).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1_000);
  });

  it("retries wallet failures without spending the campaign allocation again", async () => {
    vi.mocked(reserveCommsCredit).mockRejectedValue(new Error("wallet unavailable"));
    const fixture = dispatchDb();
    await dispatchOwnerSmsOutbox({ workerId: "worker-1" }, fixture.db);
    fixture.reclaim();
    await dispatchOwnerSmsOutbox({ workerId: "worker-1" }, fixture.db);
    expect(vi.mocked(reserveCommsCredit)).toHaveBeenCalledTimes(2);
    expect(fixture.campaignAllocations()).toBe(1);
    expect(fixture.outbox.status).toBe("deferred");
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("still blocks terminally when the wallet answered that credit is exhausted", async () => {
    vi.mocked(reserveCommsCredit).mockResolvedValueOnce({ allowed: false, reason: "allowance_exhausted" });
    const { db, outbox } = dispatchDb();
    await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, db)).resolves.toMatchObject({ claimed: 1, blocked: 1 });
    expect(mocks.sendSms).not.toHaveBeenCalled();
    expect(outbox).toMatchObject({ status: "blocked", blocked_reason: "allowance_exhausted" });
  });

  it("blocks a duplicate reservation so a resend never spends twice", async () => {
    vi.mocked(reserveCommsCredit).mockResolvedValueOnce({ allowed: true, duplicate: true, state: "reserved" });
    const { db, outbox } = dispatchDb();
    await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, db)).resolves.toMatchObject({ claimed: 1, blocked: 1 });
    expect(mocks.sendSms).not.toHaveBeenCalled();
    expect(outbox).toMatchObject({ status: "blocked", blocked_reason: "credit_already_reserved" });
  });
});
