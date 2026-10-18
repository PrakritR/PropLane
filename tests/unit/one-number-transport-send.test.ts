import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendSms: vi.fn(),
  log: vi.fn(),
  readSuppression: vi.fn(),
  reserve: vi.fn(),
  runtimeRow: {} as Record<string, unknown>,
  pilotOwned: true,
}));

vi.mock("@/lib/twilio", () => ({
  sendSms: mocks.sendSms,
  normalizeE164: (phone: string) => (phone.startsWith("+") ? phone : `+1${phone.replace(/\D/g, "")}`),
}));
vi.mock("@/lib/manager-sms-messages.server", () => ({ logManagerSmsMessage: mocks.log }));
vi.mock("@/lib/sms/application-consent.server", () => ({
  ensureApplicationScopedSmsConsent: vi.fn(async () => ({ ok: true, granted: true })),
}));
vi.mock("@/lib/sms-consent", () => ({
  readSmsSuppressionState: mocks.readSuppression,
  normalizeConsentPhone: (phone: string) => phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""),
}));
vi.mock("@/lib/sms/number-registration-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms/number-registration-policy")>()),
  evaluateManagerSmsNumberSendability: vi.fn(() => ({ sendable: true })),
  quietHoursBlocks: vi.fn(() => false),
}));
vi.mock("@/lib/comms-billing/rates", () => ({ isCommsPaygBillingEnabled: vi.fn(() => false), unitPriceCentsForMeter: () => 3 }));
vi.mock("@/lib/comms-billing/eligibility.server", () => ({ evaluateManagerCommsBillingGate: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/comms-billing/wallet.server", () => ({
  reserveCommsCredit: mocks.reserve,
  finishCommsCredit: vi.fn(async () => {}),
  commsPlanBudget: vi.fn(async () => ({ allowance: 0, legacy: 0 })),
}));

import { dispatchOwnerSmsOutbox, enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";

type Row = Record<string, unknown>;
const WORK = "+12065550999";
const SHARED = "+12065550100";

function fixture() {
  const outbox: Row = {
    id: "outbox-1", manager_user_id: "manager-1", actor_user_id: "manager-1", workspace_id: "ws-1",
    recipient_user_id: null, recipient_email: null, recipient_phone: "+12065550142",
    body: "Your tour is Saturday at 10am.", send_class: "transactional", purpose: "manager_conversation",
    conversation_key: "manager-1:prospect:+12065550142", counterparty_role: "prospect", property_id: null,
    recipient_timezone: "America/Los_Angeles", dedupe_key: "k1", trace_id: null, segment_count: 1,
    status: "claimed", lease_owner: "worker-1", lease_expires_at: "2999-01-01T00:00:00.000Z",
  };
  const inserted: Row[] = [];
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let update: Row | null = null;
    let selectedLineIds = false;
    let limitCalled = false;
    const result = () => {
      if (table === "sms_runtime_config") return { data: mocks.runtimeRow, error: null };
      if (table === "portal_workspaces") return { data: { id: "ws-1", name: "Brooklyn" }, error: null };
      if (table === "manager_sms_numbers") {
        return { data: { manager_user_id: "manager-1", workspace_id: "ws-1", phone_number: WORK, phone_number_sid: "PN1", messaging_service_sid: "MG1", campaign_sid: "CP1", provision_state: "active", registration_state: "registered", registration_ref: null, attachment_state: null, number_registration_state: null, grace_started_at: null, grace_expires_at: null, quarantined_at: null, quarantine_reason: null }, error: null };
      }
      if (table === "sms_delivery_attempts") return { data: [], error: null };
      if (table === "sms_outbox") {
        const rows = filters.every((f) => f(outbox)) ? [{ ...outbox }] : [];
        return { data: limitCalled || selectedLineIds ? rows : rows[0] ?? null, error: null };
      }
      return { data: null, error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: Record<string, any> = {
      select() { return q; },
      eq(column: string, value: unknown) { filters.push((r) => r[column] === value); return q; },
      gt() { return q; }, lt() { return q; }, lte() { return q; },
      in(column: string, values: unknown[]) { if (table === "sms_outbox" && column === "id") selectedLineIds = true; filters.push((r) => values.includes(r[column])); return q; },
      not() { return q; }, is() { return q; }, order() { return q; },
      limit() { limitCalled = true; return q; },
      update(payload: Row) { update = payload; return q; },
      insert(payload: Row) {
        if (table === "sms_outbox") { inserted.push(payload); return { select: () => ({ single: async () => ({ data: { id: "outbox-new", status: "queued" }, error: null }) }) }; }
        return q;
      },
      maybeSingle() {
        if (table === "sms_outbox" && update) { Object.assign(outbox, update); return Promise.resolve({ data: { ...outbox }, error: null }); }
        return Promise.resolve(result());
      },
      single() { return Promise.resolve(result()); },
      then(resolve: (v: unknown) => unknown) {
        if (table === "sms_outbox" && update) Object.assign(outbox, update);
        return Promise.resolve(result()).then(resolve);
      },
    };
    return q;
  };
  let claimed = false;
  const db = {
    from,
    rpc: vi.fn(async (name: string) => {
      if (name === "claim_sms_outbox") {
        if (claimed) return { data: [], error: null };
        claimed = true;
        return { data: [{ ...outbox }], error: null };
      }
      if (name === "spend_sms_outbox_segment_budget") return { data: true, error: null };
      return { data: null, error: null };
    }),
  } as never;
  return { outbox, inserted, db };
}

describe("shared-line transport through the work-number dispatcher", () => {
  beforeEach(() => {
    process.env.SMS_RUNTIME_ENABLED = "1";
    process.env.SMS_OUTBOX_SCHEDULER_READY = "1";
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG1";
    process.env.TWILIO_CAMPAIGN_SID = "CP1";
    mocks.runtimeRow = { mode: "automatic", pilot_manager_user_ids: [] };
    mocks.sendSms.mockReset().mockResolvedValue({ sent: true, sid: "SM-1" });
    mocks.log.mockReset().mockResolvedValue(true);
    mocks.readSuppression.mockReset().mockResolvedValue({ ok: true, optedOut: false });
    mocks.reserve.mockReset().mockResolvedValue({ allowed: true, duplicate: false, state: "reserved" });
  });

  it("per_workspace sends from the workspace work number exactly as before", async () => {
    const f = fixture();
    await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, f.db)).resolves.toMatchObject({ claimed: 1, submitted: 1 });
    expect(mocks.sendSms).toHaveBeenCalledTimes(1);
    const [, , from, opts] = mocks.sendSms.mock.calls[0];
    expect(from).toBe(WORK);
    expect(opts).toEqual({ skipOptOutCheck: true, creditReservationKey: "sms_outbound:outbox-1" });
    expect(f.outbox.provider_from_phone).toBe(WORK);
  });

  it("an unreadable (pre-migration) line config reads as per_workspace", async () => {
    mocks.runtimeRow = { mode: "automatic", pilot_manager_user_ids: [] }; // no line_mode column at all
    const f = fixture();
    await dispatchOwnerSmsOutbox({ workerId: "worker-1" }, f.db);
    expect(mocks.sendSms.mock.calls[0][2]).toBe(WORK);
  });

  it("shadow mode still sends from the work number", async () => {
    mocks.runtimeRow = { mode: "automatic", pilot_manager_user_ids: [], line_mode: "shadow", shared_number_e164: SHARED };
    const f = fixture();
    await dispatchOwnerSmsOutbox({ workerId: "worker-1" }, f.db);
    expect(mocks.sendSms.mock.calls[0][2]).toBe(WORK);
  });

  it("shared mode sends from the shared number through the shared Messaging Service, billed to the stamped workspace", async () => {
    mocks.runtimeRow = {
      mode: "automatic", pilot_manager_user_ids: [], line_mode: "shared", shared_number_e164: SHARED,
      shared_messaging_service_sid: "MGSHARED", shared_pilot_workspace_ids: [],
    };
    const f = fixture();
    await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, f.db)).resolves.toMatchObject({ claimed: 1, submitted: 1 });
    const [, , from, opts] = mocks.sendSms.mock.calls[0];
    expect(from).toBe(SHARED);
    expect(opts).toMatchObject({ messagingServiceSid: "MGSHARED", creditReservationKey: "sms_outbound:outbox-1" });
    expect(f.outbox.provider_from_phone).toBe(SHARED);
    expect(mocks.reserve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ managerUserId: "manager-1", workspaceId: "ws-1" }));
    expect(mocks.log).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceId: "ws-1", fromPhone: SHARED }));
  });

  it("a workspace outside the pilot keeps its work number while the line is shared", async () => {
    mocks.runtimeRow = {
      mode: "automatic", pilot_manager_user_ids: [], line_mode: "shared", shared_number_e164: SHARED,
      shared_pilot_workspace_ids: ["some-other-workspace"],
    };
    const f = fixture();
    await dispatchOwnerSmsOutbox({ workerId: "worker-1" }, f.db);
    expect(mocks.sendSms.mock.calls[0][2]).toBe(WORK);
    expect(mocks.sendSms.mock.calls[0][3]).not.toHaveProperty("messagingServiceSid");
  });

  it("an opted-out phone is refused on the shared line and nothing is sent", async () => {
    mocks.runtimeRow = { mode: "automatic", pilot_manager_user_ids: [], line_mode: "shared", shared_number_e164: SHARED };
    mocks.readSuppression.mockResolvedValue({ ok: true, optedOut: true });
    const f = fixture();
    await expect(dispatchOwnerSmsOutbox({ workerId: "worker-1" }, f.db)).resolves.toMatchObject({ claimed: 1, submitted: 0, blocked: 1 });
    expect(mocks.sendSms).not.toHaveBeenCalled();
    expect(f.outbox).toMatchObject({ status: "blocked", blocked_reason: "recipient_opted_out" });
  });

  it("the shared line stays paused when the runtime kill switch is paused", async () => {
    mocks.runtimeRow = { mode: "paused", pilot_manager_user_ids: [], line_mode: "shared", shared_number_e164: SHARED };
    const f = fixture();
    await dispatchOwnerSmsOutbox({ workerId: "worker-1" }, f.db);
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("enqueue stamps the workspace on the outbox row", async () => {
    const f = fixture();
    const queued = await enqueueOwnerSms({
      managerUserId: "manager-1", actorUserId: "manager-1", workspaceId: "ws-1", recipientPhone: "+12065550142",
      body: "hello", sendClass: "transactional", purpose: "manager_conversation", dedupeKey: "k-new",
    }, f.db);
    expect(queued).toMatchObject({ ok: true, outboxId: "outbox-new" });
    expect(f.inserted[0]).toMatchObject({ workspace_id: "ws-1", manager_user_id: "manager-1" });
  });

  it("enqueue under per_workspace stamps the sending number's workspace even when the caller named none", async () => {
    const f = fixture();
    await enqueueOwnerSms({
      managerUserId: "manager-1", actorUserId: "manager-1", recipientPhone: "+12065550142",
      body: "hello", sendClass: "transactional", purpose: "manager_conversation", dedupeKey: "k-new2",
    }, f.db);
    expect(f.inserted[0]).toMatchObject({ workspace_id: "ws-1" });
  });
});
