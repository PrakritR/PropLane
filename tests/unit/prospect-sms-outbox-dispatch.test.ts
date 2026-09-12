import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(), send: vi.fn(), plan: vi.fn(), reserve: vi.fn(), finish: vi.fn(),
  billing: vi.fn(), suppression: vi.fn(), consent: vi.fn(), log: vi.fn(),
}));
vi.mock("@/lib/sms/prospect-sms-burst.server", () => ({ durableProspectSmsEnabled: mocks.enabled }));
vi.mock("@/lib/twilio", () => ({ sendSms: mocks.send, normalizeE164: (value: string) => value }));
vi.mock("@/lib/comms-billing/wallet.server", () => ({
  commsPlanBudget: mocks.plan,
  reserveCommsCredit: mocks.reserve,
  finishCommsCredit: mocks.finish,
}));
vi.mock("@/lib/comms-billing/eligibility.server", () => ({ evaluateManagerCommsBillingGate: mocks.billing }));
vi.mock("@/lib/sms-consent", () => ({ readSmsSuppressionState: mocks.suppression }));
vi.mock("@/lib/sms/application-consent.server", () => ({ ensureApplicationScopedSmsConsent: mocks.consent }));
vi.mock("@/lib/manager-sms-messages.server", () => ({ logManagerSmsMessage: mocks.log }));
vi.mock("@/lib/sms/number-registration-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms/number-registration-policy")>()),
  evaluateManagerSmsNumberSendability: () => ({ sendable: true }),
  quietHoursBlocks: () => false,
}));
const claw = vi.hoisted(() => ({ register: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/claw-messenger.server", () => ({
  isClawMessengerConfigured: () => true,
  registerClawMessengerRoute: claw.register,
  sendClawMessengerText: claw.send,
}));

const row = {
  id: "outbox-1", prospect_burst_id: "burst-1", manager_user_id: "manager", actor_user_id: "manager",
  recipient_phone: "+15550001111", recipient_email: null, body: "hello", send_class: "automated", purpose: "manager_conversation",
  conversation_key: "key", counterparty_role: "prospect", property_id: null, recipient_timezone: "America/Los_Angeles",
  dedupe_key: "burst-1", trace_id: null, segment_count: 1,
};

function chain(result: unknown = { data: { id: "outbox-1" }, error: null }) {
  const c: Record<string, unknown> = {}; const self = () => c;
  c.update = self; c.insert = self; c.eq = self; c.is = self; c.order = self; c.lt = async () => ({ error: null }); c.select = self; c.maybeSingle = async () => result; c.single = async () => result;
  c.limit = () => ({
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve, reject),
  });
  return c;
}

describe("prospect burst outbox dispatcher gate", () => {
  beforeEach(() => {
    vi.stubEnv("SMS_RUNTIME_ENABLED", "1");
    vi.stubEnv("SMS_OUTBOX_SCHEDULER_READY", "1");
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG-test");
    vi.stubEnv("TWILIO_CAMPAIGN_SID", "QE-test");
    mocks.enabled.mockReset(); mocks.send.mockReset(); mocks.plan.mockReset(); mocks.reserve.mockReset();
    mocks.finish.mockReset(); mocks.billing.mockReset(); mocks.suppression.mockReset(); mocks.consent.mockReset(); mocks.log.mockReset();
    mocks.plan.mockResolvedValue({ allowance: 1500, legacy: 1500 });
    mocks.billing.mockResolvedValue({ allowed: true });
    mocks.suppression.mockResolvedValue({ ok: true, optedOut: false });
    mocks.consent.mockResolvedValue({ ok: true, granted: true });
    mocks.log.mockResolvedValue(true);
    mocks.finish.mockResolvedValue(undefined);
    claw.register.mockReset(); claw.send.mockReset();
  });

  it("rejects a retired Claw burst before the delivery RPC", async () => {
    mocks.enabled.mockReturnValue(true);
    const insert = vi.fn();
    const db = {
      rpc: vi.fn(async (name: string) => name === "prepare_prospect_sms_delivery"
        ? { data: [{ outbox_id: "outbox-atomic", status: "queued", deduplicated: false, prepared: true }], error: null }
        : { data: null, error: null }),
      from: vi.fn(() => ({ insert })),
    } as never;
    const { enqueueOwnerSms } = await import("@/lib/sms/owner-sms-dispatcher.server");
    const result = await enqueueOwnerSms({
      managerUserId: "manager", actorUserId: "manager", recipientPhone: "+15550001111",
      body: "hello", sendClass: "transactional", purpose: "manager_conversation",
      prospectBurst: { burstId: "burst-1", revision: 2, workerId: "worker-a", transport: "claw", transportFromNumber: "+15550009999" },
    }, db);
    expect(result).toEqual({ ok: false, error: "retired_transport_unsupported" });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("defers a claimed prospect burst while durable bursts are disabled without provider submission", async () => {
    mocks.enabled.mockReturnValue(false);
    const db = {
      from: vi.fn(() => chain()),
      rpc: vi.fn(async (name: string) => name === "claim_sms_outbox" ? ({ data: [row], error: null }) : ({ data: null, error: null })),
    } as never;
    const { dispatchOwnerSmsOutbox } = await import("@/lib/sms/owner-sms-dispatcher.server");
    const result = await dispatchOwnerSmsOutbox({ workerId: "worker" }, db);
    expect(result).toMatchObject({ ok: true, claimed: 1, submitted: 0 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalledWith("begin_sms_outbox_submission", expect.anything());
  });

  it("blocks a persisted Claw rail even when retired configuration variables are present", async () => {
    mocks.enabled.mockReturnValue(true);
    const clawRow = { ...row, transport: "claw", transport_from_number: "+15550009999" };
    const db = {
      from: vi.fn(() => chain()),
      rpc: vi.fn(async (name: string) => {
        if (name === "claim_sms_outbox") return { data: [clawRow], error: null };
        if (name === "begin_sms_outbox_submission") return { data: "started", error: null };
        return { data: true, error: null };
      }),
    } as never;
    const { dispatchOwnerSmsOutbox } = await import("@/lib/sms/owner-sms-dispatcher.server");
    await dispatchOwnerSmsOutbox({ workerId: "worker" }, db);
    expect(claw.register).not.toHaveBeenCalled();
    expect(claw.send).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("does not submit a prepared Claw reply after retirement", async () => {
    mocks.enabled.mockReturnValue(true);
    const clawRow = { ...row, transport: "claw", transport_from_number: "+15550009999" };
    const db = {
      from: vi.fn(() => chain()),
      rpc: vi.fn(async (name: string) => name === "claim_sms_outbox"
        ? { data: [clawRow], error: null }
        : { data: true, error: null }),
    } as never;
    const { dispatchOwnerSmsOutbox } = await import("@/lib/sms/owner-sms-dispatcher.server");
    const result = await dispatchOwnerSmsOutbox({ workerId: "worker" }, db);
    expect(result).toMatchObject({ submitted: 0 });
    expect(claw.send).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalledWith("begin_sms_outbox_submission", expect.anything());
  });

  it("reserves a prospect credit inside its sealed burst submission", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20260912143000_prospect_sms_bursts.sql"),
      "utf8",
    );
    const dispatcher = readFileSync(
      resolve(process.cwd(), "src/lib/sms/owner-sms-dispatcher.server.ts"),
      "utf8",
    );
    const begin = dispatcher.indexOf('db.rpc("begin_sms_outbox_submission"');
    const provider = dispatcher.indexOf("sendSms(row.recipient_phone");

    // The app supplies only plan figures and the resolved sender. The locked
    // outbox supplies owner, key, and segment quantity inside the same
    // BURST→OUTBOX transaction that seals the candidate context and shadow.
    expect(provider).toBeGreaterThan(begin);
    expect(dispatcher).toContain("p_allowance: plan.allowance");
    expect(dispatcher).toContain("p_provider_from_phone: policy.fromNumber");
    expect(migration).toContain("public.reserve_comms_credit(v_outbox.manager_user_id,p_allowance,p_legacy_allowance");
    expect(migration).toContain("'sms_outbound:' || v_outbox.id::text");
    expect(migration).toContain("spend_sms_segment_budget(v_outbox.segment_count)");
    expect(migration).toContain("provider_from_phone=p_provider_from_phone");
    expect(migration).toContain("status='dispatched', handled_revision=v_burst.revision");
  });

  it("submits a funded burst after the atomic begin without reserving its credit again", async () => {
    mocks.enabled.mockReturnValue(true);
    mocks.send.mockResolvedValue({ sent: true, sid: "SM-atomic", providerAttempted: true });
    const db = {
      rpc: vi.fn(async (name: string) => {
        if (name === "claim_sms_outbox") return { data: [row], error: null };
        if (name === "begin_sms_outbox_submission") return { data: "started", error: null };
        return { data: true, error: null };
      }),
      from: vi.fn((table: string) => {
        if (table === "sms_runtime_config") return chain({ data: { mode: "live", pilot_manager_user_ids: [] }, error: null });
        if (table === "manager_sms_numbers") return chain({ data: {
          manager_user_id: "manager", phone_number: "+15550009999", phone_number_sid: "PN-test",
          messaging_service_sid: "MG-test", campaign_sid: "QE-test", provision_state: "active",
          registration_state: "verified", registration_ref: "reg", attachment_state: "attached",
          number_registration_state: "in-use", grace_started_at: null, grace_expires_at: null,
          quarantined_at: null, quarantine_reason: null,
        }, error: null });
        return chain();
      }),
    } as never;
    const { dispatchOwnerSmsOutbox } = await import("@/lib/sms/owner-sms-dispatcher.server");

    const result = await dispatchOwnerSmsOutbox({ workerId: "worker" }, db);

    expect(result).toMatchObject({ submitted: 1, unknown: 0 });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith(db, "manager", "sms_outbound:outbox-1");
  });
});
