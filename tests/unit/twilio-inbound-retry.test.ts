vi.mock("@/lib/agent/vendor-agent.server", () => ({ resolveVendorAgentSessionForInbound: vi.fn(async () => ({ kind: "unknown_phone" })), runVendorAgentSessionTurn: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleInbound: vi.fn(),
  relayInbound: vi.fn(),
  deliverLeasing: vi.fn(),
  rpc: vi.fn(),
  inboundLogSelects: 0,
  inboundBodies: [] as Record<string, unknown>[],
  inboundDeletes: 0,
  receiptUpdates: [] as Record<string, unknown>[],
  receipt: { status: "processing", first_received_at: "2026-09-25T12:00:00.000Z" } as Record<string, unknown> | null,
  receiptReadError: false,
  managerLog: null as Record<string, unknown> | null,
  managerLogs: [] as Record<string, unknown>[],
  prospectIngress: null as Record<string, unknown> | null,
  durableOriginal: null as Record<string, unknown> | null,
  existingTurns: [] as Record<string, unknown>[],
  existingConversation: null as Record<string, unknown> | null,
  historicalLog: null as Record<string, unknown> | null,
  ownedNumber: true,
  rateLimit: vi.fn((): { ok: boolean; unavailable?: true } => ({ ok: true })),
  detectSelfReply: vi.fn(async () => null),
  resolveManagerCtx: vi.fn(),
  runManagerTurn: vi.fn(),
  deliverManagerReply: vi.fn(),
  replyConsent: vi.fn(async () => "allowed"),
  after: vi.fn(),
  runInlineBurst: vi.fn(async () => undefined),
  recoveryRows: [] as Record<string, unknown>[],
  projectEvent: vi.fn(async () => true),
  projectionRetryRows: [] as Record<string, unknown>[],
  projectOriginal: vi.fn(async () => undefined),
  finishProjection: vi.fn(async () => undefined),
}));

vi.mock("twilio", () => ({ default: { validateRequest: vi.fn(() => true) } }));
import twilio from "twilio";
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: mocks.after }));
vi.mock("@/lib/sms/prospect-sms-burst-job.server", () => ({ runInlineProspectBurst: mocks.runInlineBurst }));
vi.mock("@/lib/twilio-client.server", () => ({
  twilioWebhookAuthToken: () => "auth-token",
  fetchTwilioMessageCreatedAt: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/lib/claw-leasing-bot.server", () => ({
  handleClawLeasingInbound: mocks.handleInbound,
}));
vi.mock("@/lib/agent/leasing-sms-agent.server", () => ({
  deliverLeasingSmsReply: mocks.deliverLeasing,
}));
vi.mock("@/lib/sms-relay.server", () => ({ relayInboundSms: mocks.relayInbound }));
vi.mock("@/lib/sms/manager-relay.server", () => ({
  detectManagerSelfReply: mocks.detectSelfReply,
  forwardResidentInboundToManagerCell: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/sms/manager-sms-access.server", () => ({
  resolveManagerSmsInboundIdentity: mocks.detectSelfReply,
}));
vi.mock("@/lib/sms/manager-conversation-consent.server", () => ({ ensureManagerInboundReplyConsent: mocks.replyConsent }));
vi.mock("@/lib/sms/project-manager-sms-event.server", () => ({ projectManagerSmsEvent: mocks.projectEvent }));
vi.mock("@/lib/sms/sms-projection.server", () => ({
  projectOriginalEvent: mocks.projectOriginal,
  listPendingSmsProjectionRetries: vi.fn(async () => mocks.projectionRetryRows),
  finishSmsProjectionRetry: mocks.finishProjection,
  resolveSmsProjectionWorkLine: vi.fn(async () => ({ workLineId: "line-1" })),
}));
vi.mock("@/lib/tools/manager-sms-context", () => ({
  resolveManagerSmsAgentContext: mocks.resolveManagerCtx,
}));
vi.mock("@/lib/agent/manager-sms-agent.server", () => ({
  runManagerSmsAgentTurn: mocks.runManagerTurn,
  deliverManagerSmsReply: mocks.deliverManagerReply,
}));
vi.mock("@/lib/claw-leasing-links", () => ({ isClawSharedLineBridgeEnabled: () => true }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => makeDb(),
}));

function makeDb() {
  return {
    rpc: mocks.rpc,
    from(table: string) {
      let isUpdate = false;
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        select() {
          if (table === "inbound_sms_log") mocks.inboundLogSelects += 1;
          return builder;
        },
        in: () => builder,
        eq: (column: string, value: unknown) => { filters[column] = value; return builder; },
        not: () => builder,
        lt: () => builder,
        gt: () => builder,
        order: () => builder,
        limit: () =>
          table === "manager_sms_numbers"
            ? Promise.resolve({
                data: mocks.ownedNumber ? [
                  {
                    manager_user_id: "11111111-1111-4111-8111-111111111111",
                    messaging_service_sid: "MG11111111111111111111111111111111",
                    provision_state: "active",
                    grace_expires_at: null,
                    updated_at: "2026-08-25T00:00:00.000Z",
                  },
                ] : [],
                error: null,
              })
            : table === "sms_inbound_receipts"
              ? Promise.resolve({ data: mocks.recoveryRows, error: null })
              : table === "prospect_sms_ingress"
                ? Promise.resolve({ data: mocks.prospectIngress ? [mocks.prospectIngress] : [], error: null })
              : table === "sms_projection_turns"
                ? Promise.resolve({ data: mocks.existingTurns, error: null })
              : table === "manager_sms_messages"
                ? Promise.resolve({ data: mocks.managerLogs.filter((row) =>
                    Object.entries(filters).every(([column, value]) => row[column] === value)), error: null })
              : Promise.resolve({ data: [], error: null }),
        insert: (values: Record<string, unknown>) => { if (table === "inbound_sms_log") mocks.inboundBodies.push(values); return Promise.resolve({ data: null, error: null }); },
        delete: () => {
          if (table === "inbound_sms_log") mocks.inboundDeletes += 1;
          return builder;
        },
        update: (values: Record<string, unknown>) => {
          isUpdate = true;
          if (table === "sms_inbound_receipts") mocks.receiptUpdates.push(values);
          return builder;
        },
        maybeSingle: () =>
          Promise.resolve({
            data:
              table === "sms_inbound_receipts" && !isUpdate
                ? mocks.receipt
                : table === "manager_sms_messages"
                  ? (mocks.managerLog && Object.entries(filters).every(([column, value]) => mocks.managerLog?.[column] === value)
                      ? mocks.managerLog : null)
        : table === "sms_projection_conversations"
                  ? mocks.existingConversation
                : table === "inbound_sms_log"
                  ? mocks.historicalLog
                : { message_sid: "SM111" },
            error: table === "sms_inbound_receipts" && mocks.receiptReadError ? { message: "read failed" } : null,
          }),
        then(resolve: (value: { data: unknown; error: null }) => unknown) {
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

import { POST } from "@/app/api/twilio/inbound/route";
import { recoverInboundReceipts, recoverSmsProjectionRetries } from "@/lib/sms/inbound-pipeline.server";
import { resolveVendorAgentSessionForInbound } from "@/lib/agent/vendor-agent.server";

const OWNER = "11111111-1111-4111-8111-111111111111";
function recoveryRow(overrides: Record<string, unknown> = {}) {
  return {
    message_sid: "SM11111111111111111111111111111111",
    manager_user_id: OWNER,
    recipient_phone_key: "12065552222",
    status: "retryable",
    lease_expires_at: null,
    inbound_payload: {
      fromPhone: "+12065552222",
      toPhone: "+12065559999",
      body: "Is it furnished",
      workspaceId: null,
      media: {},
      runtime: "development",
    },
    ...overrides,
  };
}

function inboundRequest() {
  return new Request("https://prop-lane.space/api/twilio/inbound", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": "valid",
    },
    body: new URLSearchParams({
      From: "+12065552222",
      To: "+12065559999",
      Body: "Is the apartment available?",
      MessageSid: "SM11111111111111111111111111111111",
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inboundBodies = [];
  mocks.inboundDeletes = 0;
  mocks.inboundLogSelects = 0;
  mocks.receiptUpdates = [];
  mocks.recoveryRows = [];
  mocks.projectionRetryRows = [];
  mocks.projectOriginal.mockReset().mockResolvedValue(undefined);
  mocks.finishProjection.mockReset().mockResolvedValue(undefined);
  mocks.receipt = { status: "processing", first_received_at: "2026-09-25T12:00:00.000Z" };
  mocks.receiptReadError = false;
  mocks.managerLog = null;
  mocks.managerLogs = [];
  mocks.prospectIngress = null;
  mocks.durableOriginal = null;
  mocks.existingTurns = [];
  mocks.existingConversation = null;
  mocks.historicalLog = null;
  mocks.ownedNumber = true;
  mocks.rateLimit.mockReturnValue({ ok: true });
  mocks.detectSelfReply.mockResolvedValue(null);
  mocks.resolveManagerCtx.mockReset();
  mocks.runManagerTurn.mockReset();
  mocks.deliverManagerReply.mockReset();
  mocks.replyConsent.mockResolvedValue("allowed");
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG11111111111111111111111111111111");
  vi.stubEnv("SMS_RUNTIME_ENABLED", "1");
  mocks.rpc.mockImplementation(async (name: string, args?: { p_sid?: string }) => {
    if (name === "resolve_sms_completed_receipt_original") {
      const payload = (mocks.receipt?.inbound_payload ?? mocks.durableOriginal) as Record<string, unknown> | null;
      if (!payload) return { data: { ok: false, reason: "original_missing" }, error: null };
      const ingress = Boolean(mocks.prospectIngress);
      return { data: {
        ok: true, sid: args?.p_sid,
        receiptOwner: mocks.receipt?.manager_user_id ?? OWNER,
        owner: ingress ? mocks.prospectIngress?.manager_user_id : mocks.receipt?.manager_user_id ?? OWNER,
        status: mocks.receipt?.status,
        body: payload.body, fromPhone: payload.fromPhone, toPhone: payload.toPhone,
        occurredAt: mocks.receipt?.first_received_at,
        role: ingress ? "prospect" : mocks.durableOriginal?.role ?? "unknown",
        userId: mocks.durableOriginal?.userId ?? null, conversationKey: null,
        ingress, source: mocks.receipt?.inbound_payload ? "receipt_payload" : "durable_log",
      }, error: null };
    }
    if (name === "claim_sms_inbound") return { data: true, error: null };
    if (name === "prepare_sms_inbound_reply") {
      return { data: true, error: null };
    }
    if (name === "attach_sms_inbound_outbox") return { data: true, error: null };
    return { data: null, error: null };
  });
});

describe("managed Twilio inbound retry", () => {
  it("keeps two queued receipts out of visible per-SID conversations until classification", async () => {
    mocks.receipt = {
      status: "processing", manager_user_id: OWNER, first_received_at: "2026-09-25T12:00:00.000Z",
      inbound_payload: { fromPhone: "+12065552222", toPhone: "+12065559999", body: "First", runtime: "development", workspaceId: null, media: {} },
    };
    mocks.projectionRetryRows = ["SM-first", "SM-second"].map((sid) => ({
      ownerManagerUserId: OWNER, sourceNamespace: "receipt:twilio", sourceEventId: sid,
      claimToken: `claim-${sid}`, event: { sourceRef: { table: "sms_inbound_receipts", id: sid } },
    }));
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ scanned: 2, projected: 0, failed: 2 });
    expect(mocks.projectOriginal).not.toHaveBeenCalled();
    expect(mocks.finishProjection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      success: false, reasonCode: "receipt_classification_pending",
    }));
  });
  it("repairs a co-manager receipt into the workspace owner's prospect conversation", async () => {
    const canonicalOwner = "22222222-2222-4222-8222-222222222222";
    mocks.receipt = {
      status: "completed", manager_user_id: OWNER, first_received_at: "2026-09-25T12:00:00.000Z",
      inbound_payload: { fromPhone: "+12065552222", toPhone: "+12065559999", body: "Tour please", runtime: "development", workspaceId: null, media: {} },
    };
    mocks.prospectIngress = { manager_user_id: canonicalOwner, body: "Tour please" };
    mocks.projectionRetryRows = [{ ownerManagerUserId: OWNER, sourceNamespace: "receipt:twilio", sourceEventId: "SM-co-manager",
      claimToken: "claim-owner", event: { sourceRef: { table: "sms_inbound_receipts", id: "SM-co-manager" } } }];
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 1, failed: 0 });
    expect(mocks.projectOriginal).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ownerManagerUserId: canonicalOwner, counterpartyRole: "prospect", identityKey: "phone:+12065552222",
    }));
  });
  it("repairs a manager-log source intent from the saved row without sending again", async () => {
    const sid = "SM11111111111111111111111111111111";
    mocks.managerLog = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", manager_user_id: OWNER,
      resident_user_id: null, resident_phone: "+12065552222", direction: "outbound",
      body: "Saved reply", from_phone: "+12065559999", to_phone: "+12065552222",
      message_sid: sid, created_at: "2026-09-25T12:00:03.000Z", source: "work_number",
      counterparty_role: "prospect", conversation_key: `${OWNER}:prospect:+12065552222`,
    };
    mocks.projectionRetryRows = [{ ownerManagerUserId: OWNER, sourceNamespace: "manager_log",
      sourceEventId: String(mocks.managerLog.id), claimToken: "claim-log",
      event: { sourceRef: { table: "manager_sms_messages", id: mocks.managerLog.id } } }];
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 1, failed: 0 });
    expect(mocks.projectOriginal).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sourceEventId: sid, direction: "outbound", body: "Saved reply", occurredAt: "2026-09-25T12:00:03.000Z",
    }));
    expect(mocks.handleInbound).not.toHaveBeenCalled();
    expect(mocks.deliverLeasing).not.toHaveBeenCalled();
  });
  it("repairs a receipt-source projection intent without replaying provider or model work", async () => {
    const sid = "SM11111111111111111111111111111111";
    mocks.receipt = {
      status: "completed", manager_user_id: OWNER, first_received_at: "2026-09-25T12:00:00.000Z",
      inbound_payload: { fromPhone: "+12065552222", toPhone: "+12065559999", body: "Original receipt body", runtime: "development", workspaceId: null, media: {} },
    };
    mocks.projectionRetryRows = [{ ownerManagerUserId: OWNER, sourceNamespace: "receipt:twilio", sourceEventId: sid,
      claimToken: "claim-1", event: { sourceRef: { table: "sms_inbound_receipts", id: sid } } }];
    const result = await recoverSmsProjectionRetries(makeDb() as never);
    expect(result).toMatchObject({ scanned: 1, projected: 1, failed: 0 });
    expect(mocks.projectOriginal).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      body: "Original receipt body", occurredAt: "2026-09-25T12:00:00.000Z", sourceEventId: sid,
    }));
    expect(mocks.finishProjection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ success: true }));
    expect(mocks.handleInbound).not.toHaveBeenCalled();
    expect(mocks.deliverLeasing).not.toHaveBeenCalled();
  });

  it("repairs a completed payload-null receipt from the retained full original", async () => {
    const sid = "SM-retained";
    mocks.receipt = { status: "completed", manager_user_id: OWNER,
      first_received_at: "2026-09-25T12:00:00.000Z", inbound_payload: null };
    mocks.durableOriginal = { fromPhone: "+12065552222", toPhone: "+12065559999", body: "  Full original  " };
    mocks.projectionRetryRows = [{ ownerManagerUserId: OWNER, sourceNamespace: "receipt:twilio", sourceEventId: sid,
      claimToken: "claim-retained", event: { sourceRef: { table: "sms_inbound_receipts", id: sid } } }];
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 1, failed: 0 });
    expect(mocks.projectOriginal).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sourceEventId: sid, body: "  Full original  ", occurredAt: "2026-09-25T12:00:00.000Z",
    }));
    expect(mocks.handleInbound).not.toHaveBeenCalled();
  });

  it("does not live-recover a retryable null-payload original from its durable log", async () => {
    const sid = "SM-retained-pending";
    mocks.receipt = { status: "retryable", manager_user_id: OWNER,
      first_received_at: "2026-09-25T12:00:00.000Z", inbound_payload: null };
    mocks.durableOriginal = { fromPhone: "+12065552222", toPhone: "+12065559999", body: "Original",
      role: "resident", userId: null };
    mocks.projectionRetryRows = [{ ownerManagerUserId: OWNER, sourceNamespace: "receipt:twilio",
      sourceEventId: sid, claimToken: "claim-pending", event: { sourceRef: { table: "sms_inbound_receipts", id: sid } } }];
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 0, failed: 1 });
    expect(mocks.projectOriginal).not.toHaveBeenCalled();
    expect(mocks.handleInbound).not.toHaveBeenCalled();
    expect(mocks.deliverLeasing).not.toHaveBeenCalled();
    expect(mocks.finishProjection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      success: false, reasonCode: "inbound_original_invalid_result",
    }));
  });

  it("leaves a completed receipt without a retained original unresolved", async () => {
    mocks.receipt = { status: "completed", manager_user_id: OWNER,
      first_received_at: "2026-09-25T12:00:00.000Z", inbound_payload: null };
    mocks.projectionRetryRows = [{ ownerManagerUserId: OWNER, sourceNamespace: "receipt:twilio", sourceEventId: "SM-missing",
      claimToken: "claim-missing", event: { sourceRef: { table: "sms_inbound_receipts", id: "SM-missing" } } }];
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 0, failed: 1 });
    expect(mocks.projectOriginal).not.toHaveBeenCalled();
  });

  it("rehydrates a stale queued inbound timestamp and body from the receipt", async () => {
    const sid = "SM11111111111111111111111111111111";
    mocks.receipt = {
      status: "completed", manager_user_id: OWNER, first_received_at: "2026-09-25T12:00:00.000Z",
      inbound_payload: { fromPhone: "+12065552222", toPhone: "+12065559999", body: "Receipt wins", runtime: "development", workspaceId: null, media: {} },
    };
    mocks.projectionRetryRows = [{ ownerManagerUserId: OWNER, sourceNamespace: `twilio:${OWNER}:unconfigured`, sourceEventId: sid,
      claimToken: "claim-2", event: { ownerManagerUserId: OWNER, counterpartyRole: "prospect", workLineId: "line-1",
        identityKey: "phone:+12065552222", identityKind: "phone", sourceNamespace: `twilio:${OWNER}:unconfigured`,
        sourceEventId: sid, direction: "inbound", body: "Stale queued body", occurredAt: "2026-09-25T12:00:09.000Z",
        fromPhone: "+12065552222", toPhone: "+12065559999" } }];
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 0, failed: 1 });
    expect(mocks.projectOriginal).not.toHaveBeenCalled();
    expect(mocks.finishProjection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      success: false, reasonCode: "receipt_queued_envelope_conflict",
    }));
  });

  it("accepts only exact classified queued enrichment when durable user identity is unknown", async () => {
    const sid = "SM-authorized-user";
    mocks.receipt = { status: "processing", manager_user_id: OWNER,
      first_received_at: "2026-09-25T12:00:00.000Z",
      inbound_payload: { fromPhone: "+12065552222", toPhone: "+12065559999", body: "Full original" } };
    const event = { ownerManagerUserId: OWNER, sourceNamespace: `twilio:${OWNER}:unconfigured`,
      sourceEventId: sid, sourceRef: { table: "sms_inbound_receipts", id: sid },
      counterpartyRole: "resident", counterpartyUserId: "user-1", direction: "inbound",
      body: "Full original", fromPhone: "+12065552222", toPhone: "+12065559999",
      occurredAt: "2026-09-25T12:00:00.000Z" };
    mocks.projectionRetryRows = [{ ownerManagerUserId: OWNER, sourceNamespace: event.sourceNamespace,
      sourceEventId: sid, claimToken: "claim-user", event }];
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 1, failed: 0 });
    expect(mocks.projectOriginal).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      counterpartyRole: "resident", counterpartyUserId: "user-1", identityKey: "user:user-1",
    }));
    mocks.projectOriginal.mockClear();
    mocks.durableOriginal = { role: "resident", userId: "user-2" };
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 0, failed: 1 });
    expect(mocks.projectOriginal).not.toHaveBeenCalled();
  });

  it("enriches a pending role-only producer but refuses the same completed durable-log hint", async () => {
    const sid = "SM-role-only";
    const event = { ownerManagerUserId: OWNER, sourceNamespace: `twilio:${OWNER}:unconfigured`,
      sourceEventId: sid, sourceRef: { table: "sms_inbound_receipts", id: sid },
      counterpartyRole: "resident", counterpartyUserId: null, direction: "inbound",
      body: "Original", fromPhone: "+12065552222", toPhone: "+12065559999",
      occurredAt: "2026-09-25T12:00:00.123456Z" };
    mocks.receipt = { status: "processing", manager_user_id: OWNER,
      first_received_at: event.occurredAt, inbound_payload: { body: "Original", fromPhone: event.fromPhone, toPhone: event.toPhone } };
    mocks.projectionRetryRows = [{ ownerManagerUserId: OWNER, sourceNamespace: event.sourceNamespace,
      sourceEventId: sid, claimToken: "claim-role", event }];
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 1, failed: 0 });
    expect(mocks.projectOriginal).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ counterpartyRole: "resident" }));
    mocks.projectOriginal.mockClear();
    mocks.receipt = { ...mocks.receipt, status: "completed", inbound_payload: null };
    mocks.durableOriginal = { body: "Original", fromPhone: event.fromPhone, toPhone: event.toPhone, role: "unknown", userId: null };
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 0, failed: 1 });
    expect(mocks.projectOriginal).not.toHaveBeenCalled();
    mocks.receipt = { ...mocks.receipt, status: "retryable" };
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 0, failed: 1 });
    expect(mocks.projectOriginal).not.toHaveBeenCalled();
  });

  it("rejects a queued classification that differs by one microsecond", async () => {
    const sid = "SM-microsecond-queue";
    mocks.receipt = { status: "processing", manager_user_id: OWNER,
      first_received_at: "2026-09-25T12:00:00.123456Z",
      inbound_payload: { body: "Original", fromPhone: "+12065552222", toPhone: "+12065559999" } };
    mocks.projectionRetryRows = [{ ownerManagerUserId: OWNER, sourceNamespace: `twilio:${OWNER}:unconfigured`,
      sourceEventId: sid, claimToken: "claim-micro", event: {
        ownerManagerUserId: OWNER, sourceNamespace: `twilio:${OWNER}:unconfigured`, sourceEventId: sid,
        sourceRef: { table: "sms_inbound_receipts", id: sid }, counterpartyRole: "resident",
        direction: "inbound", body: "Original", fromPhone: "+12065552222", toPhone: "+12065559999",
        occurredAt: "2026-09-25T12:00:00.123457Z",
      } }];
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 0, failed: 1 });
    expect(mocks.projectOriginal).not.toHaveBeenCalled();
  });

  it("checks an existing historical log row against the exact receipt SID", async () => {
    const sid = "SM-historical-existing";
    const logId = "33333333-3333-4333-8333-333333333333";
    mocks.receipt = { status: "completed", manager_user_id: OWNER,
      first_received_at: "2026-09-25T12:00:00.000Z", inbound_payload: null };
    mocks.durableOriginal = { fromPhone: "+12065552222", toPhone: "+12065559999", body: "Original",
      role: "resident", userId: "user-1" };
    mocks.existingTurns = [{ owner_manager_user_id: OWNER, conversation_id: "conversation-1",
      source_namespace: "historical:inbound_sms_log", source_event_id: logId, provider_sid: sid,
      source_ref: { table: "inbound_sms_log", id: logId }, direction: "inbound", body: "Original",
      occurred_at: "2026-09-25T12:00:00.000Z", from_phone: "+12065552222", to_phone: "+12065559999" }];
    mocks.existingConversation = { owner_manager_user_id: OWNER, counterparty_role: "resident",
      counterparty_user_id: "user-1", counterparty_phone: "+12065552222",
      identity_kind: "user", identity_key: "user:user-1", work_line_id: "line-1" };
    mocks.historicalLog = { message_sid: sid, manager_user_id: OWNER };
    mocks.projectionRetryRows = [{ ownerManagerUserId: OWNER, sourceNamespace: "receipt:twilio",
      sourceEventId: sid, claimToken: "claim-historical", event: { sourceRef: { table: "sms_inbound_receipts", id: sid } } }];
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 1, failed: 0 });
    mocks.historicalLog = { message_sid: "SM-other", manager_user_id: OWNER };
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 0, failed: 1 });
    expect(mocks.projectOriginal).not.toHaveBeenCalled();
  });

  it("does not restore a queued user after a completed durable log has null identity", async () => {
    const sid = "SM-user-removed";
    mocks.receipt = { status: "completed", manager_user_id: OWNER,
      first_received_at: "2026-09-25T12:00:00.000Z", inbound_payload: null };
    mocks.durableOriginal = { fromPhone: "+12065552222", toPhone: "+12065559999",
      body: "Original", role: "resident", userId: null };
    mocks.projectionRetryRows = [{ ownerManagerUserId: OWNER,
      sourceNamespace: `twilio:${OWNER}:unconfigured`, sourceEventId: sid, claimToken: "claim-removed",
      event: { ownerManagerUserId: OWNER, sourceNamespace: `twilio:${OWNER}:unconfigured`,
        sourceEventId: sid, sourceRef: { table: "sms_inbound_receipts", id: sid },
        counterpartyRole: "resident", counterpartyUserId: "old-user", direction: "inbound",
        body: "Original", fromPhone: "+12065552222", toPhone: "+12065559999",
        occurredAt: "2026-09-25T12:00:00.000Z" } }];
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 0, failed: 1 });
    expect(mocks.projectOriginal).not.toHaveBeenCalled();
    expect(mocks.finishProjection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      success: false, reasonCode: "receipt_classification_unproven",
    }));
  });

  it("acknowledges a fully matching existing turn after owner, line and classification checks", async () => {
    const sid = "SM-existing-correct";
    mocks.receipt = { status: "completed", manager_user_id: OWNER,
      first_received_at: "2026-09-25T12:00:00.000Z", inbound_payload: null };
    mocks.durableOriginal = { fromPhone: "+12065552222", toPhone: "+12065559999", body: "Original",
      role: "resident", userId: "user-1" };
    mocks.existingTurns = [{ owner_manager_user_id: OWNER, conversation_id: "conversation-1",
      source_namespace: `twilio:${OWNER}:unconfigured`, source_event_id: sid, provider_sid: sid,
      source_ref: { table: "sms_inbound_receipts", id: sid },
      direction: "inbound", body: "Original", occurred_at: "2026-09-25T12:00:00.000Z",
      from_phone: "+12065552222", to_phone: "+12065559999" }];
    mocks.existingConversation = { owner_manager_user_id: OWNER, counterparty_role: "resident",
      counterparty_user_id: "user-1", counterparty_phone: "+12065552222",
      identity_kind: "user", identity_key: "user:user-1", work_line_id: "line-1" };
    mocks.projectionRetryRows = [{ ownerManagerUserId: OWNER, sourceNamespace: "receipt:twilio",
      sourceEventId: sid, claimToken: "claim-existing", event: { sourceRef: { table: "sms_inbound_receipts", id: sid } } }];
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 1, failed: 0 });
    expect(mocks.projectOriginal).not.toHaveBeenCalled();
    expect(mocks.finishProjection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ success: true }));
  });

  it.each([
    ["wrong user key", { identity_key: "user:someone-else" }, { table: "sms_inbound_receipts", id: "SM-identity" }, false],
    ["wrong kind", { identity_kind: "phone" }, { table: "sms_inbound_receipts", id: "SM-identity" }, false],
    ["wrong receipt reference", {}, { table: "sms_inbound_receipts", id: "SM-other" }, false],
    ["exact receipt reference", {}, { table: "sms_inbound_receipts", id: "SM-identity" }, true],
    ["known user with an older phone snapshot", { counterparty_phone: "+12065553333" }, { table: "sms_inbound_receipts", id: "SM-identity" }, true],
    ["exact ingress reference", {}, { table: "prospect_sms_ingress", id: "SM-identity" }, true],
  ])("checks existing live provenance and canonical identity: %s", async (_name, identity, sourceRef, accepted) => {
    const sid = "SM-identity";
    mocks.receipt = { status: "completed", manager_user_id: OWNER,
      first_received_at: "2026-09-25T12:00:00.123456Z", inbound_payload: null };
    mocks.durableOriginal = { fromPhone: "+12065552222", toPhone: "+12065559999", body: "Original",
      role: "resident", userId: "user-1" };
    if (sourceRef.table === "prospect_sms_ingress") {
      mocks.prospectIngress = { manager_user_id: OWNER };
      mocks.durableOriginal.role = "prospect";
      mocks.durableOriginal.userId = null;
    }
    mocks.existingTurns = [{ owner_manager_user_id: OWNER, conversation_id: "conversation-1",
      source_namespace: `twilio:${OWNER}:unconfigured`, source_event_id: sid, provider_sid: sid,
      source_ref: sourceRef, direction: "inbound", body: "Original",
      occurred_at: "2026-09-25 08:00:00.123456-04:00", from_phone: "+12065552222", to_phone: "+12065559999" }];
    mocks.existingConversation = { owner_manager_user_id: OWNER,
      counterparty_role: sourceRef.table === "prospect_sms_ingress" ? "prospect" : "resident",
      counterparty_user_id: sourceRef.table === "prospect_sms_ingress" ? null : "user-1",
      counterparty_phone: "+12065552222", work_line_id: "line-1",
      identity_kind: sourceRef.table === "prospect_sms_ingress" ? "phone" : "user",
      identity_key: sourceRef.table === "prospect_sms_ingress" ? "phone:+12065552222" : "user:user-1",
      ...identity };
    mocks.projectionRetryRows = [{ ownerManagerUserId: OWNER, sourceNamespace: "receipt:twilio",
      sourceEventId: sid, claimToken: "claim-identity", event: { sourceRef: { table: "sms_inbound_receipts", id: sid } } }];
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: accepted ? 1 : 0, failed: accepted ? 0 : 1 });
    expect(mocks.projectOriginal).not.toHaveBeenCalled();
  });

  it("binds a live transport-log reference to its exact row, SID and receipt holder", async () => {
    const sid = "SM-live-log";
    const logId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    mocks.receipt = { status: "completed", manager_user_id: OWNER,
      first_received_at: "2026-09-25T12:00:00.000Z", inbound_payload: null };
    mocks.durableOriginal = { fromPhone: "+12065552222", toPhone: "+12065559999", body: "Original",
      role: "resident", userId: null };
    mocks.existingTurns = [{ owner_manager_user_id: OWNER, conversation_id: "conversation-1",
      source_namespace: `twilio:${OWNER}:unconfigured`, source_event_id: sid, provider_sid: sid,
      source_ref: { table: "inbound_sms_log", id: logId }, direction: "inbound", body: "Original",
      occurred_at: "2026-09-25T12:00:00.000Z", from_phone: "+12065552222", to_phone: "+12065559999" }];
    mocks.existingConversation = { owner_manager_user_id: OWNER, counterparty_role: "resident",
      counterparty_user_id: null, counterparty_phone: "+12065552222", identity_kind: "phone",
      identity_key: "phone:+12065552222", work_line_id: "line-1" };
    mocks.historicalLog = { message_sid: sid, manager_user_id: OWNER };
    mocks.projectionRetryRows = [{ ownerManagerUserId: OWNER, sourceNamespace: "receipt:twilio",
      sourceEventId: sid, claimToken: "claim-log", event: { sourceRef: { table: "sms_inbound_receipts", id: sid } } }];
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 1, failed: 0 });
    mocks.historicalLog = { message_sid: "SM-other", manager_user_id: OWNER };
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 0, failed: 1 });
    mocks.historicalLog = { message_sid: sid, manager_user_id: OWNER };
    mocks.existingConversation.counterparty_phone = "+12065553333";
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 0, failed: 1 });
  });

  it("acknowledges the actual manager SMS producer reference only with one matching durable original", async () => {
    const sid = "SM-manager-producer";
    const at = "2026-09-25T12:00:00.123456Z";
    const logId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    mocks.receipt = { status: "completed", manager_user_id: OWNER,
      first_received_at: at, inbound_payload: null };
    mocks.durableOriginal = { fromPhone: "+12065552222", toPhone: "+12065559999", body: "Original",
      role: "resident", userId: "user-1" };
    const { projectManagerSmsEvent } = await vi.importActual<typeof import("@/lib/sms/project-manager-sms-event.server")>(
      "@/lib/sms/project-manager-sms-event.server",
    );
    expect(await projectManagerSmsEvent(makeDb() as never, {
      ownerManagerUserId: OWNER, counterpartyRole: "resident", counterpartyUserId: "user-1",
      counterpartyPhone: "+12065552222", workPhone: "+12065559999",
      legacyConversationKey: `${OWNER}:resident:user-1`, messageSid: sid,
      direction: "inbound", body: "Original", occurredAt: at,
      fromPhone: "+12065552222", toPhone: "+12065559999", source: "work_number",
    })).toBe(true);
    const produced = mocks.projectOriginal.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(produced.sourceRef).toEqual({ table: "manager_sms_messages", source: "work_number" });
    mocks.existingTurns = [{ owner_manager_user_id: OWNER, conversation_id: "conversation-1",
      source_namespace: produced.sourceNamespace, source_event_id: sid, provider_sid: sid,
      source_ref: produced.sourceRef, direction: "inbound", body: "Original",
      occurred_at: "2026-09-25 08:00:00.123456-04:00",
      from_phone: "+12065552222", to_phone: "+12065559999" }];
    mocks.existingConversation = { owner_manager_user_id: OWNER, counterparty_role: "resident",
      counterparty_user_id: "user-1", counterparty_phone: "+12065552222",
      identity_kind: "user", identity_key: "user:user-1", work_line_id: "line-1" };
    const log = { id: logId, manager_user_id: OWNER, message_sid: sid, direction: "inbound",
      body: "Original", from_phone: "+12065552222", to_phone: "+12065559999",
      created_at: at, resident_phone: "+12065552222", resident_user_id: "user-1",
      counterparty_role: "resident", source: "work_number" };
    mocks.managerLogs = [log];
    mocks.projectionRetryRows = [{ ownerManagerUserId: OWNER, sourceNamespace: "receipt:twilio",
      sourceEventId: sid, claimToken: "claim-producer", event: { sourceRef: { table: "sms_inbound_receipts", id: sid } } }];
    mocks.projectOriginal.mockClear();
    const recover = () => recoverSmsProjectionRetries(makeDb() as never);
    expect(await recover()).toMatchObject({ projected: 1, failed: 0 });
    expect(mocks.projectOriginal).not.toHaveBeenCalled();
    expect(mocks.handleInbound).not.toHaveBeenCalled();
    expect(mocks.deliverLeasing).not.toHaveBeenCalled();

    mocks.existingTurns[0]!.source_ref = { table: "manager_sms_messages", id: logId };
    expect(await recover()).toMatchObject({ projected: 1, failed: 0 });
    mocks.existingTurns[0]!.source_ref = { table: "manager_sms_messages", id: "other-row" };
    expect(await recover()).toMatchObject({ projected: 0, failed: 1 });
    mocks.existingTurns[0]!.source_ref = { table: "manager_sms_messages", source: "relay" };
    expect(await recover()).toMatchObject({ projected: 0, failed: 1 });
    mocks.existingTurns[0]!.source_ref = produced.sourceRef;

    for (const [change, value] of [
      ["missing", null], ["ambiguous", { ...log, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
      ["wrong owner", { ...log, manager_user_id: "other-owner" }],
      ["wrong SID", { ...log, message_sid: "SM-other" }],
      ["wrong direction", { ...log, direction: "outbound" }],
      ["wrong body", { ...log, body: "Changed" }],
      ["wrong sender", { ...log, from_phone: "+12065553333" }],
      ["wrong work line", { ...log, to_phone: "+12065553333" }],
      ["wrong counterparty phone", { ...log, resident_phone: "+12065553333" }],
      ["wrong time", { ...log, created_at: "2026-09-25T12:00:00.123457Z" }],
      ["wrong role", { ...log, counterparty_role: "vendor" }],
      ["wrong user", { ...log, resident_user_id: "other-user" }],
    ] as const) {
      mocks.managerLogs = change === "missing" ? [] : change === "ambiguous" ? [log, value as typeof log] : [value as typeof log];
      expect(await recover(), change).toMatchObject({ projected: 0, failed: 1 });
    }
    mocks.managerLogs = [log];
    mocks.receipt.manager_user_id = "other-holder";
    expect(await recover()).toMatchObject({ projected: 0, failed: 1 });
    mocks.receipt.manager_user_id = OWNER;
    mocks.existingConversation.identity_key = "user:other-user";
    expect(await recover()).toMatchObject({ projected: 0, failed: 1 });
  });

  it.each(["receipt", "queued producer", "manager row intent"] as const)(
    "proves the %s inbound entry path with a distinct receipt holder, then reconstructs or acknowledges",
    async (path) => {
      const sid = "SM-cross-holder";
      const at = "2026-09-25T12:00:00.123456Z";
      const holder = "22222222-2222-4222-8222-222222222222";
      const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      mocks.receipt = { status: "completed", manager_user_id: holder, first_received_at: at, inbound_payload: null };
      mocks.prospectIngress = { manager_user_id: OWNER };
      mocks.durableOriginal = { fromPhone: "+12065552222", toPhone: "+12065559999", body: "Original",
        role: "prospect", userId: null };
      const log = { id, manager_user_id: OWNER, message_sid: sid, direction: "inbound",
        body: "Original", from_phone: "+12065552222", to_phone: "+12065559999",
        created_at: at, resident_phone: "+12065552222", resident_user_id: null,
        counterparty_role: "prospect", source: "automated" };
      mocks.managerLogs = [log];
      mocks.managerLog = log;
      const { projectManagerSmsEvent } = await vi.importActual<typeof import("@/lib/sms/project-manager-sms-event.server")>(
        "@/lib/sms/project-manager-sms-event.server",
      );
      await projectManagerSmsEvent(makeDb() as never, {
        ownerManagerUserId: OWNER, counterpartyRole: "prospect", counterpartyUserId: null,
        counterpartyPhone: "+12065552222", workPhone: "+12065559999",
        legacyConversationKey: `${OWNER}:prospect:+12065552222`, messageSid: sid,
        direction: "inbound", body: "Original", occurredAt: at,
        fromPhone: "+12065552222", toPhone: "+12065559999", source: "automated",
      });
      const produced = mocks.projectOriginal.mock.calls[0]?.[1] as Record<string, unknown>;
      mocks.projectOriginal.mockClear();
      const intent = path === "receipt" ? { sourceRef: { table: "sms_inbound_receipts", id: sid } }
        : path === "manager row intent" ? { sourceRef: { table: "manager_sms_messages", id } } : produced;
      mocks.projectionRetryRows = [{ ownerManagerUserId: path === "receipt" ? holder : OWNER,
        sourceNamespace: "retry", sourceEventId: sid, claimToken: "claim-cross-holder", event: intent }];
      const recover = () => recoverSmsProjectionRetries(makeDb() as never);
      expect(await recover()).toMatchObject({ projected: 1, failed: 0 });
      expect(mocks.projectOriginal).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        ownerManagerUserId: OWNER, counterpartyRole: "prospect", counterpartyUserId: null,
        body: "Original", occurredAt: at, workLineId: "line-1",
        sourceRef: path === "receipt" ? { table: "sms_inbound_receipts", id: sid }
          : path === "manager row intent" ? { table: "manager_sms_messages", id }
            : { table: "manager_sms_messages", source: "automated" },
      }));
      mocks.projectOriginal.mockClear();
      mocks.existingTurns = [{ owner_manager_user_id: OWNER, conversation_id: "conversation-1",
        source_namespace: `twilio:${OWNER}:unconfigured`, source_event_id: sid, provider_sid: sid,
        source_ref: path === "receipt" ? { table: "manager_sms_messages", source: "automated" }
          : intent.sourceRef, direction: "inbound", body: "Original", occurred_at: at,
        from_phone: "+12065552222", to_phone: "+12065559999" }];
      mocks.existingConversation = { owner_manager_user_id: OWNER, counterparty_role: "prospect",
        counterparty_user_id: null, counterparty_phone: "+12065552222",
        identity_kind: "phone", identity_key: "phone:+12065552222", work_line_id: "line-1" };
      expect(await recover()).toMatchObject({ projected: 1, failed: 0 });
      expect(mocks.projectOriginal).not.toHaveBeenCalled();

      for (const [label, change] of [
        ["missing", null], ["ambiguous", { ...log, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
        ["wrong owner", { ...log, manager_user_id: holder }],
        ["wrong body", { ...log, body: "Changed" }],
        ["wrong wire", { ...log, to_phone: "+12065550000" }],
        ["wrong time", { ...log, created_at: "2026-09-25T12:00:00.123457Z" }],
        ["wrong identity", { ...log, counterparty_role: "resident" }],
      ] as const) {
        mocks.managerLogs = label === "missing" ? [] : label === "ambiguous" ? [log, change as typeof log] : [change as typeof log];
        if (path === "manager row intent") mocks.managerLog = label === "missing" ? null : log;
        expect(await recover(), `${path}: ${label}`).toMatchObject({ projected: 0, failed: 1 });
      }
      mocks.managerLogs = [log];
      mocks.managerLog = log;
      mocks.existingTurns[0]!.occurred_at = "2026-09-25T12:00:00.123457Z";
      expect(await recover()).toMatchObject({ projected: 0, failed: 1 });
      mocks.existingTurns[0]!.occurred_at = at;
      mocks.existingConversation.identity_key = "phone:+12065550000";
      expect(await recover()).toMatchObject({ projected: 0, failed: 1 });
      mocks.existingConversation.identity_key = "phone:+12065552222";
      mocks.prospectIngress = null;
      expect(await recover()).toMatchObject({ projected: 0, failed: 1 });
      mocks.prospectIngress = { manager_user_id: OWNER };
      if (path === "queued producer") {
        mocks.existingTurns = [];
        for (const [label, event] of [
          ["wrong source", { ...produced, sourceRef: { table: "manager_sms_messages", source: "relay" } }],
          ["wrong reference", { ...produced, sourceRef: { table: "manager_sms_messages", id: "other-row" } }],
          ["wrong owner", { ...produced, ownerManagerUserId: holder }],
          ["wrong SID", { ...produced, sourceEventId: "SM-other" }],
          ["wrong namespace", { ...produced, sourceNamespace: "twilio:other:unconfigured" }],
          ["wrong body", { ...produced, body: "Changed" }],
          ["wrong wire", { ...produced, fromPhone: "+12065550000" }],
          ["one microsecond", { ...produced, occurredAt: "2026-09-25T12:00:00.123457Z" }],
          ["wrong identity", { ...produced, identityKey: "phone:+12065550000" }],
          ["wrong role", { ...produced, counterpartyRole: "resident" }],
          ["wrong line", { ...produced, workLineId: "other-line" }],
        ] as const) {
          mocks.projectionRetryRows[0]!.event = event;
          expect(await recover(), label).toMatchObject({ projected: 0, failed: 1 });
        }
        mocks.projectionRetryRows[0]!.event = produced;
      }
      if (path === "manager row intent") {
        mocks.existingTurns = [];
        mocks.projectionRetryRows[0]!.event = { sourceRef: { table: "manager_sms_messages", id: "other-row" } };
        expect(await recover()).toMatchObject({ projected: 0, failed: 1 });
      }
    },
  );

  it("accepts matching classified source identity and rejects unbound queued identity", async () => {
    const sid = "SM-classified";
    mocks.receipt = { status: "completed", manager_user_id: OWNER,
      first_received_at: "2026-09-25T12:00:00.000Z", inbound_payload: null };
    mocks.durableOriginal = { fromPhone: "+12065552222", toPhone: "+12065559999",
      body: "Classified original", role: "resident", userId: "user-1" };
    const event = { ownerManagerUserId: OWNER, sourceNamespace: `twilio:${OWNER}:unconfigured`,
      sourceEventId: sid, sourceRef: { table: "sms_inbound_receipts", id: sid },
      counterpartyRole: "resident", counterpartyUserId: "user-1", direction: "inbound",
      body: "Classified original", fromPhone: "+12065552222", toPhone: "+12065559999",
      occurredAt: "2026-09-25T12:00:00.000Z" };
    mocks.projectionRetryRows = [{ ownerManagerUserId: OWNER, sourceNamespace: event.sourceNamespace,
      sourceEventId: sid, claimToken: "claim-classified", event }];
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 1, failed: 0 });
    mocks.projectOriginal.mockClear();
    mocks.projectionRetryRows[0]!.event = { ...event, sourceRef: { table: "inbound_sms_log", id: "other-row" } };
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 0, failed: 1 });
    expect(mocks.projectOriginal).not.toHaveBeenCalled();
    expect(mocks.finishProjection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      success: false, reasonCode: "receipt_queued_envelope_conflict",
    }));
  });

  it.each([
    ["wrong owner", { owner_manager_user_id: "other-owner" }, {}, "receipt_projection_integrity_conflict"],
    ["wrong direction", { direction: "outbound" }, {}, "receipt_projection_integrity_conflict"],
    ["one microsecond later", { occurred_at: "2026-09-25T12:00:00.000001Z" }, {}, "receipt_projection_integrity_conflict"],
    ["wrong line", {}, { work_line_id: "other-line" }, "receipt_projection_identity_conflict"],
    ["wrong role", {}, { counterparty_role: "vendor" }, "receipt_projection_identity_conflict"],
    ["wrong user", {}, { counterparty_user_id: "other-user" }, "receipt_projection_identity_conflict"],
  ])("refuses an existing turn with %s before acknowledging its receipt", async (_label, turnChange, conversationChange, reason) => {
    const sid = "SM-existing";
    mocks.receipt = { status: "completed", manager_user_id: OWNER,
      first_received_at: "2026-09-25T12:00:00.000Z", inbound_payload: null };
    mocks.durableOriginal = { fromPhone: "+12065552222", toPhone: "+12065559999", body: "Original",
      role: "resident", userId: "user-1" };
    mocks.existingTurns = [{ owner_manager_user_id: OWNER, conversation_id: "conversation-1",
      source_namespace: `twilio:${OWNER}:unconfigured`, source_event_id: sid, provider_sid: sid,
      source_ref: { table: "sms_inbound_receipts", id: sid },
      direction: "inbound", body: "Original", occurred_at: "2026-09-25T12:00:00.000Z",
      from_phone: "+12065552222", to_phone: "+12065559999", ...turnChange }];
    mocks.existingConversation = { owner_manager_user_id: OWNER, counterparty_role: "resident",
      counterparty_user_id: "user-1", counterparty_phone: "+12065552222",
      identity_kind: "user", identity_key: "user:user-1", work_line_id: "line-1", ...conversationChange };
    mocks.projectionRetryRows = [{ ownerManagerUserId: OWNER, sourceNamespace: "receipt:twilio",
      sourceEventId: sid, claimToken: "claim-existing", event: { sourceRef: { table: "sms_inbound_receipts", id: sid } } }];
    expect(await recoverSmsProjectionRetries(makeDb() as never)).toMatchObject({ projected: 0, failed: 1 });
    expect(mocks.finishProjection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ success: false, reasonCode: reason }));
    expect(mocks.projectOriginal).not.toHaveBeenCalled();
    expect(mocks.handleInbound).not.toHaveBeenCalled();
  });

  it("routes the immutable receipt body and time even when the replay request differs and projection defers", async () => {
    mocks.receipt = {
      status: "processing",
      first_received_at: "2026-09-25T12:00:00.000Z",
      inbound_payload: {
        fromPhone: "+12065552222", toPhone: "+12065559999", body: "Original prospect text",
        workspaceId: null, media: {}, runtime: "development",
      },
    };
    mocks.projectEvent.mockResolvedValueOnce(false);
    mocks.handleInbound.mockResolvedValue({ ok: true, intent: "unknown", replied: false, durablyAccepted: true });

    const response = await POST(inboundRequest());

    expect(response.status).toBe(200);
    expect(mocks.inboundBodies[0]).toMatchObject({
      body: "Original prospect text", created_at: "2026-09-25T12:00:00.000Z",
    });
    expect(mocks.projectEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      body: "Original prospect text", occurredAt: "2026-09-25T12:00:00.000Z",
      sourceRef: { table: "sms_inbound_receipts", id: "SM11111111111111111111111111111111" },
    }));
    expect(mocks.handleInbound).toHaveBeenCalledWith(expect.objectContaining({
      text: "Original prospect text", receivedAt: "2026-09-25T12:00:00.000Z",
    }));
  });

  it("releases an unreadable receipt for recovery before agent or provider work", async () => {
    mocks.receiptReadError = true;
    const response = await POST(inboundRequest());
    expect(response.status).toBe(503);
    expect(mocks.handleInbound).not.toHaveBeenCalled();
    expect(mocks.inboundBodies).toHaveLength(0);
  });
  it("acknowledges Twilio and runs the burst after the response when the queue refused it", async () => {
    const inlineBurst = { burstId: "burst-1", revision: 2, dueAt: "2026-09-24T15:00:10.000Z" };
    mocks.handleInbound.mockResolvedValue({ ok: true, intent: "unknown", replied: false, durablyAccepted: true, inlineBurst });

    const response = await POST(inboundRequest());

    expect(response.status).toBe(200);
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.runInlineBurst).not.toHaveBeenCalled();
    await mocks.after.mock.calls[0]![0]();
    expect(mocks.runInlineBurst).toHaveBeenCalledWith(expect.anything(), inlineBurst);
  });

  it("keeps the saved text on the leasing path when inbound credit cannot be reserved", async () => {
    const { recordManagerCommsUsage } = await import("@/lib/comms-billing/record-usage.server");
    vi.mocked(recordManagerCommsUsage).mockRejectedValueOnce(new Error("Communication credit could not be reserved."));
    mocks.handleInbound.mockResolvedValue({ ok: true, intent: "unknown", replied: false, durablyAccepted: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await POST(inboundRequest());

    expect(response.status).toBe(200);
    expect(mocks.inboundBodies).toEqual([expect.objectContaining({ body: "Is the apartment available?" })]);
    expect(mocks.handleInbound).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("twilio inbound usage not recorded", "SM11111111111111111111111111111111", "Communication credit could not be reserved.", undefined);
    warn.mockRestore();
  });

  it("claims the receipt together with a replayable payload", async () => {
    mocks.handleInbound.mockResolvedValue({ ok: true, intent: "unknown", replied: false, durablyAccepted: true });

    expect((await POST(inboundRequest())).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("claim_sms_inbound", expect.objectContaining({
      p_inbound_payload: {
        fromPhone: "+12065552222",
        toPhone: "+12065559999",
        body: "Is the apartment available?",
        workspaceId: null,
        media: {},
        runtime: "development",
      },
    }));
  });

  it("projects the classified prospect's original inbound SID, body, and receipt time", async () => {
    mocks.handleInbound.mockResolvedValue({ ok: true, intent: "unknown", replied: false, durablyAccepted: true });

    expect((await POST(inboundRequest())).status).toBe(200);
    expect(mocks.projectEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ownerManagerUserId: OWNER,
      counterpartyRole: "prospect",
      counterpartyUserId: null,
      counterpartyPhone: "+12065552222",
      workPhone: "+12065559999",
      messageSid: "SM11111111111111111111111111111111",
      direction: "inbound",
      body: "Is the apartment available?",
      occurredAt: "2026-09-25T12:00:00.000Z",
      fromPhone: "+12065552222",
      toPhone: "+12065559999",
      source: "work_number",
    }));
  });

  it("recovers a claimed projection marker by projecting only its immutable event and finishing with its claim token", async () => {
    mocks.projectionRetryRows = [{
      ownerManagerUserId: OWNER,
      sourceNamespace: "twilio:account",
      sourceEventId: "SM-projection-retry",
      claimToken: "claim-token-1",
      attempts: 1,
      nextAttemptAt: "2026-09-25T12:00:00.000Z",
      event: { sourceEventId: "SM-projection-retry", workLineId: "line-1", body: "Exact original", occurredAt: "2026-09-25T12:00:00.000Z" },
    }];
    const { recoverSmsProjectionRetries } = await import("@/lib/sms/inbound-pipeline.server");

    await expect(recoverSmsProjectionRetries(makeDb() as never, { limit: 25 })).resolves.toEqual({
      scanned: 1, projected: 1, failed: 0,
    });
    expect(mocks.projectOriginal).toHaveBeenCalledWith(expect.anything(), mocks.projectionRetryRows[0]!.event);
    expect(mocks.finishProjection).toHaveBeenCalledWith(expect.anything(), {
      ownerManagerUserId: OWNER,
      sourceNamespace: "twilio:account",
      sourceEventId: "SM-projection-retry",
      claimToken: "claim-token-1",
      success: true,
    });
    expect(mocks.handleInbound).not.toHaveBeenCalled();
    expect(mocks.deliverLeasing).not.toHaveBeenCalled();
  });

  it("releases the claim as retryable when a route after the claim throws", async () => {
    vi.mocked(resolveVendorAgentSessionForInbound).mockRejectedValueOnce(new Error("Vendor session lookup unavailable."));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await POST(inboundRequest());

    expect(response.status).toBe(503);
    expect(mocks.receiptUpdates).toContainEqual(expect.objectContaining({ status: "retryable", lease_owner: null }));
    expect(mocks.handleInbound).not.toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
  });

  it("recovers a retryable receipt through the same pipeline", async () => {
    mocks.recoveryRows = [recoveryRow()];
    mocks.handleInbound.mockResolvedValue({ ok: true, intent: "unknown", replied: false, durablyAccepted: true });

    const result = await recoverInboundReceipts(makeDb() as never, { deadline: Date.now() + 60_000 });

    expect(result).toEqual({ scanned: 1, recovered: 1, failed: 0, dropped: 0 });
    expect(mocks.rpc).toHaveBeenCalledWith("claim_sms_inbound", expect.objectContaining({
      p_message_sid: "SM11111111111111111111111111111111",
      p_worker_id: expect.stringMatching(/^inbound-recovery-/),
    }));
    expect(mocks.handleInbound).toHaveBeenCalledWith(expect.objectContaining({ text: "Is it furnished", from: "+12065552222" }));
    expect(mocks.receiptUpdates).toContainEqual(expect.objectContaining({ status: "completed" }));
  });

  it("never replays a receipt another runtime stored, or one still leased", async () => {
    mocks.recoveryRows = [
      recoveryRow({ inbound_payload: { ...recoveryRow().inbound_payload, runtime: "production" } }),
      recoveryRow({ status: "processing", lease_expires_at: new Date(Date.now() + 60_000).toISOString() }),
    ];

    const result = await recoverInboundReceipts(makeDb() as never, { deadline: Date.now() + 60_000 });

    expect(result).toEqual({ scanned: 2, recovered: 0, failed: 0, dropped: 0 });
    expect(mocks.rpc).not.toHaveBeenCalledWith("claim_sms_inbound", expect.anything());
    expect(mocks.handleInbound).not.toHaveBeenCalled();
  });

  it("takes over a processing receipt only after its lease is past the grace window", async () => {
    const now = Date.now();
    mocks.recoveryRows = [
      recoveryRow({ status: "processing", lease_expires_at: new Date(now - 30_000).toISOString() }),
      recoveryRow({ status: "processing", lease_expires_at: new Date(now - 120_000).toISOString() }),
    ];
    mocks.handleInbound.mockResolvedValue({ ok: true, intent: "unknown", replied: false, durablyAccepted: true });

    const result = await recoverInboundReceipts(makeDb() as never, { deadline: now + 60_000, now });

    expect(result).toMatchObject({ recovered: 1, failed: 0 });
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "claim_sms_inbound")).toHaveLength(1);
  });

  it("retries instead of dropping when the work number cannot be resolved", async () => {
    mocks.recoveryRows = [recoveryRow()];
    mocks.ownedNumber = false;

    const result = await recoverInboundReceipts(makeDb() as never, { deadline: Date.now() + 60_000 });

    expect(result).toEqual({ scanned: 1, recovered: 0, failed: 1, dropped: 0 });
    expect(mocks.receiptUpdates).toContainEqual(expect.objectContaining({ status: "retryable" }));
    expect(mocks.handleInbound).not.toHaveBeenCalled();
  });

  it("drops without replying when the line now belongs to another workspace", async () => {
    mocks.recoveryRows = [recoveryRow({ manager_user_id: "22222222-2222-4222-8222-222222222222" })];

    const result = await recoverInboundReceipts(makeDb() as never, { deadline: Date.now() + 60_000 });

    expect(result).toEqual({ scanned: 1, recovered: 0, failed: 0, dropped: 1 });
    expect(mocks.receiptUpdates).toContainEqual(expect.objectContaining({ status: "completed" }));
    expect(mocks.handleInbound).not.toHaveBeenCalled();
  });

  it("validates the signature against the webhook URL without its retry-policy fragment", async () => {
    vi.stubEnv("TWILIO_WEBHOOK_URL", "https://proplane.ai/api/twilio/inbound#rp=ct,5xx&rc=2");
    mocks.handleInbound.mockResolvedValue({ ok: true, intent: "unknown", replied: false, durablyAccepted: true });

    expect((await POST(inboundRequest())).status).toBe(200);
    expect(vi.mocked(twilio.validateRequest)).toHaveBeenCalledWith(
      "auth-token", "valid", "https://proplane.ai/api/twilio/inbound", expect.anything(),
    );
  });

  it("schedules nothing extra when the burst was queued normally", async () => {
    mocks.handleInbound.mockResolvedValue({ ok: true, intent: "unknown", replied: false, durablyAccepted: true });

    expect((await POST(inboundRequest())).status).toBe(200);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("removes a fresh manager self-SMS transport row from Communication", async () => {
    mocks.detectSelfReply.mockResolvedValue({
      actorUserId: "co-manager",
      workNumberOwnerId: "11111111-1111-4111-8111-111111111111",
      access: { mode: "delegated" },
    });
    mocks.resolveManagerCtx.mockResolvedValue({
      ok: true,
      ctx: { userId: "co-manager", landlordId: "11111111-1111-4111-8111-111111111111" },
    });
    mocks.runManagerTurn.mockResolvedValue({
      reply: "Your assistant answer.",
      sessionId: "assistant-session",
      inboundMessageId: "inbound-agent-message",
      assistantMessageId: "assistant-agent-message",
    });
    mocks.runManagerTurn.mockImplementationOnce(async (_db, args: { onInboundPersisted?: () => Promise<boolean> }) => {
      expect(await args.onInboundPersisted?.()).toBe(true);
      return {
        reply: "Your assistant answer.",
        sessionId: "assistant-session",
        inboundMessageId: "inbound-agent-message",
        assistantMessageId: "assistant-agent-message",
      };
    });
    mocks.deliverManagerReply.mockResolvedValue({ ok: true, durablyAccepted: true });

    expect((await POST(inboundRequest())).status).toBe(200);
    expect(mocks.runManagerTurn).toHaveBeenCalledOnce();
    expect(mocks.resolveManagerCtx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceId: null }));
    expect(mocks.inboundDeletes).toBe(1);
  });

  it("keeps the co-manager actor on a prepared reply retry without rerunning the agent", async () => {
    mocks.receipt = { ...mocks.receipt, status: "processing", route_kind: "manager_agent", reply_body: "Your assigned house has one request.", counterparty_user_id: "co-manager" };
    mocks.detectSelfReply.mockResolvedValue({ actorUserId: "co-manager", workNumberOwnerId: "11111111-1111-4111-8111-111111111111" });
    mocks.deliverManagerReply.mockResolvedValue({ ok: true, durablyAccepted: true });
    expect((await POST(inboundRequest())).status).toBe(200);
    expect(mocks.deliverManagerReply).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "co-manager" }));
    expect(mocks.runManagerTurn).not.toHaveBeenCalled();
  });

  it("retains retryability when identity lookup fails for a prepared manager reply", async () => {
    mocks.receipt = { ...mocks.receipt, status: "processing", route_kind: "manager_agent", reply_body: "Prepared reply", counterparty_user_id: "co-manager" };
    mocks.detectSelfReply.mockRejectedValueOnce(new Error("Database temporarily unavailable"));
    expect((await POST(inboundRequest())).status).toBe(503);
    expect(mocks.deliverManagerReply).not.toHaveBeenCalled();
    expect(mocks.receiptUpdates).toEqual(expect.arrayContaining([expect.objectContaining({ status: "retryable" })]));
  });

  it("does not send a saved reply after the co-manager's assignment is revoked", async () => {
    mocks.receipt = { ...mocks.receipt, status: "processing", route_kind: "manager_agent", reply_body: "Prepared reply", counterparty_user_id: "co-manager" };
    expect((await POST(inboundRequest())).status).toBe(200);
    expect(mocks.deliverManagerReply).not.toHaveBeenCalled();
    expect(mocks.handleInbound).not.toHaveBeenCalled();
  });


  it.each([
    ["legacy relay", "0", true],
    ["unknown work number", "1", false],
    ["new managed message", "1", true],
  ] as const)("preserves provider retries on limiter outage for %s", async (_, runtime, ownedNumber) => {
    vi.stubEnv("SMS_RUNTIME_ENABLED", runtime);
    mocks.ownedNumber = ownedNumber;
    mocks.receipt = null;
    mocks.rateLimit.mockReturnValue({ ok: false, unavailable: true });

    const response = await POST(inboundRequest());

    expect(response.status).toBe(503);
    expect(mocks.rateLimit).toHaveBeenCalledOnce();
    expect(mocks.handleInbound).not.toHaveBeenCalled();
    expect(mocks.relayInbound).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["legacy relay", "0", true],
    ["unknown work number", "1", false],
    ["new managed message", "1", true],
  ] as const)("acknowledges confirmed exhaustion for %s", async (_, runtime, ownedNumber) => {
    vi.stubEnv("SMS_RUNTIME_ENABLED", runtime);
    mocks.ownedNumber = ownedNumber;
    mocks.receipt = null;
    mocks.rateLimit.mockReturnValue({ ok: false });

    const response = await POST(inboundRequest());

    expect(response.status).toBe(200);
    expect(mocks.rateLimit).toHaveBeenCalledOnce();
    expect(mocks.handleInbound).not.toHaveBeenCalled();
    expect(mocks.relayInbound).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("reclaims a retryable receipt even when the durable message log already exists", async () => {
    mocks.handleInbound.mockImplementationOnce(async (args: {
      onPreparedReply: (prepared: Record<string, unknown>) => Promise<boolean>;
    }) => {
      const replyBody = "Yes, the apartment is available.";
      const prepared = await args.onPreparedReply({ routeKind: "leasing_agent", replyBody });
      mocks.receipt = {
        ...mocks.receipt,
        status: "processing",
        route_kind: "leasing_agent",
        reply_body: replyBody,
      };
      return prepared
        ? { ok: false, error: "reply unavailable" }
        : { ok: false, error: "prepare unavailable" };
    });
    mocks.deliverLeasing.mockResolvedValue({
      ok: false,
      error: "deferred",
      outboxId: "44444444-4444-4444-8444-444444444444",
      durablyAccepted: true,
    });

    const first = await POST(inboundRequest());
    const retry = await POST(inboundRequest());

    expect(first.status).toBe(503);
    expect(retry.status).toBe(200);
    expect(mocks.handleInbound).toHaveBeenCalledTimes(1);
    expect(mocks.deliverLeasing).toHaveBeenCalledTimes(1);
    expect(mocks.deliverLeasing).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Yes, the apartment is available." }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "claim_sms_inbound",
      expect.objectContaining({ p_message_sid: "SM11111111111111111111111111111111" }),
    );
    expect(mocks.inboundLogSelects).toBe(0);
    expect(mocks.relayInbound).not.toHaveBeenCalled();
    expect(mocks.inboundBodies[0]).toMatchObject({ manager_user_id: "11111111-1111-4111-8111-111111111111", message_sid: "SM11111111111111111111111111111111" });
  });

  it("completes without re-entering the handler once its durable outbox owns the reply", async () => {
    mocks.receipt = {
      ...mocks.receipt,
      status: "processing",
      route_kind: "leasing_agent",
      reply_body: "The prepared answer must not be regenerated.",
      turn_trace_id: "trace-original",
      outbox_id: "55555555-5555-4555-8555-555555555555",
    };

    const response = await POST(inboundRequest());

    expect(response.status).toBe(200);
    expect(mocks.handleInbound).not.toHaveBeenCalled();
    expect(mocks.deliverLeasing).not.toHaveBeenCalled();
    expect(mocks.receiptUpdates).toContainEqual(
      expect.objectContaining({ status: "completed", lease_owner: null, lease_expires_at: null }),
    );
    expect(mocks.rpc).not.toHaveBeenCalledWith("attach_sms_inbound_outbox", expect.anything());
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("hands retry ownership to a newly created outbox and never handles the duplicate again", async () => {
    const replyBody = "This exact answer is now owned by the outbox.";
    mocks.handleInbound.mockImplementationOnce(async (args: {
      onPreparedReply: (prepared: Record<string, unknown>) => Promise<boolean>;
    }) => {
      const prepared = await args.onPreparedReply({ routeKind: "leasing_agent", replyBody });
      return prepared
        ? {
            ok: true,
            replied: false,
            outboxId: "66666666-6666-4666-8666-666666666666",
          }
        : { ok: false, error: "prepare unavailable" };
    });

    const first = await POST(inboundRequest());
    expect(first.status).toBe(200);
    expect(mocks.handleInbound).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("prepare_sms_inbound_reply", expect.objectContaining({
      p_message_sid: "SM11111111111111111111111111111111",
      p_reply_body: replyBody,
    }));
    expect(mocks.rpc).toHaveBeenCalledWith("attach_sms_inbound_outbox", expect.objectContaining({
      p_message_sid: "SM11111111111111111111111111111111",
      p_outbox_id: "66666666-6666-4666-8666-666666666666",
    }));

    mocks.receipt = { status: "completed" };
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_sms_inbound") return { data: false, error: null };
      return { data: null, error: null };
    });
    const duplicate = await POST(inboundRequest());

    expect(duplicate.status).toBe(200);
    expect(mocks.handleInbound).toHaveBeenCalledTimes(1);
    expect(mocks.deliverLeasing).not.toHaveBeenCalled();
  });

  it("asks Twilio to retry while another receipt lease is not completed", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });

    const response = await POST(inboundRequest());

    expect(response.status).toBe(503);
    expect(mocks.handleInbound).not.toHaveBeenCalled();
  });

  it("logs the failing step timeline and error so a Twilio timeout can be traced", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await POST(inboundRequest());

    const call = warn.mock.calls.find(([label]) => label === "twilio inbound timing");
    expect(call?.[1]).toMatchObject({
      status: 503,
      error: expect.stringContaining("still pending"),
      marks: expect.stringMatching(/signed:\d+ .*rate-limit:\d+/),
    });
    expect(String(call?.[1]?.marks)).not.toContain("claimed");
    warn.mockRestore();
  });

  it("acknowledges a duplicate only after the receipt is completed", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    mocks.receipt = { status: "completed" };

    const response = await POST(inboundRequest());

    expect(response.status).toBe(200);
    expect(mocks.handleInbound).not.toHaveBeenCalled();
  });

  it("hands a manager's own verified cell to the manager agent and texts the reply back", async () => {
    mocks.detectSelfReply.mockResolvedValue({
      workNumberOwnerId: "11111111-1111-4111-8111-111111111111",
      actorUserId: "11111111-1111-4111-8111-111111111111",
      workNumber: "+12065559999",
      actorPhone: "+12065552222",
      access: {
        mode: "owner",
        workNumberOwnerId: "11111111-1111-4111-8111-111111111111",
        actorUserId: "11111111-1111-4111-8111-111111111111",
        dataOwnerIds: ["11111111-1111-4111-8111-111111111111"],
        assignedPropertyIds: [],
      },
    });
    mocks.resolveManagerCtx.mockResolvedValue({
      ok: true,
      ctx: { landlordId: "11111111-1111-4111-8111-111111111111", userId: "11111111-1111-4111-8111-111111111111" },
    });
    mocks.runManagerTurn.mockResolvedValue({
      reply: "3 charges are overdue, $4,150 total.",
      sessionId: "22222222-2222-4222-8222-222222222222",
    });
    mocks.deliverManagerReply.mockResolvedValue({ ok: true, durablyAccepted: true });

    const response = await POST(inboundRequest());

    expect(response.status).toBe(200);
    // The leasing/prospect path must never see a manager's own text.
    expect(mocks.handleInbound).not.toHaveBeenCalled();
    expect(mocks.runManagerTurn).toHaveBeenCalledTimes(1);
    expect(mocks.deliverManagerReply).toHaveBeenCalledWith(
      expect.objectContaining({
        managerUserId: "11111111-1111-4111-8111-111111111111",
        text: "3 charges are overdue, $4,150 total.",
      }),
    );
  });

  it("stays silent when the manager identity cannot be resolved, and never falls through to leasing", async () => {
    mocks.detectSelfReply.mockResolvedValue({
      workNumberOwnerId: "11111111-1111-4111-8111-111111111111",
      actorUserId: "11111111-1111-4111-8111-111111111111",
      workNumber: "+12065559999",
      actorPhone: "+12065552222",
      access: {
        mode: "owner",
        workNumberOwnerId: "11111111-1111-4111-8111-111111111111",
        actorUserId: "11111111-1111-4111-8111-111111111111",
        dataOwnerIds: ["11111111-1111-4111-8111-111111111111"],
        assignedPropertyIds: [],
      },
    });
    mocks.resolveManagerCtx.mockResolvedValue({ ok: false, reason: "not_a_manager" });

    const response = await POST(inboundRequest());
    const twiml = await response.text();

    expect(response.status).toBe(200);
    expect(twiml).toContain("<Response></Response>");
    expect(mocks.runManagerTurn).not.toHaveBeenCalled();
    expect(mocks.deliverManagerReply).not.toHaveBeenCalled();
    // Critically: it does NOT retry the text as a prospect/resident, which
    // would run the leasing agent AT the manager.
    expect(mocks.handleInbound).not.toHaveBeenCalled();
  });
});

vi.mock("@/lib/comms-billing/record-usage.server", () => ({recordManagerCommsUsage:vi.fn(async()=>({recorded:true,duplicate:false,totalCents:2}))}));
