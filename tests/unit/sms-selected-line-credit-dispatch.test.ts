import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveLine: vi.fn(),
  loadWallet: vi.fn(),
  reserve: vi.fn(),
  finish: vi.fn(),
  sendSms: vi.fn(),
  suppression: vi.fn(),
  consent: vi.fn(),
}));

vi.mock("@/lib/sms/manager-workspace-role.server", () => ({ resolveOwnerSendNumberRow: mocks.resolveLine }));
vi.mock("@/lib/comms-billing/wallet.server", () => ({
  loadCommsWallet: mocks.loadWallet,
  reserveCommsCredit: mocks.reserve,
  finishCommsCredit: mocks.finish,
  commsPlanBudget: vi.fn(),
}));
vi.mock("@/lib/sms-consent", () => ({ readSmsSuppressionState: mocks.suppression }));
vi.mock("@/lib/sms/application-consent.server", () => ({ ensureApplicationScopedSmsConsent: mocks.consent }));
vi.mock("@/lib/sms/number-registration-policy", () => ({
  estimateSmsSegments: vi.fn(() => ({ segmentCount: 1 })),
  evaluateManagerSmsNumberSendability: vi.fn(() => ({ sendable: true })),
  quietHoursBlocks: vi.fn(() => false),
}));
vi.mock("@/lib/twilio", () => ({ sendSms: mocks.sendSms }));
vi.mock("@/lib/manager-sms-messages.server", () => ({ logManagerSmsMessage: vi.fn() }));

import { dispatchOwnerSmsOutbox } from "@/lib/sms/owner-sms-dispatcher.server";

type Row = Record<string, unknown>;
type LateChange = "pause" | "unreadable" | "optout" | "consent" | "phone" | "workspace";

function dispatchDb() {
  const outbox: Row = {
    id: "outbox-1", manager_user_id: "owner-1", actor_user_id: "owner-1",
    selected_work_line_id: "line-2", recipient_user_id: "resident-1",
    recipient_phone: "+12065550142", recipient_email: "resident@example.com",
    body: "A one segment message", send_class: "transactional", purpose: "manager_conversation",
    conversation_key: "owner-1:resident:resident-1", counterparty_role: "resident",
    property_id: null, recipient_timezone: "America/Los_Angeles", dedupe_key: "send-1",
    trace_id: null, segment_count: 1, status: "claimed", lease_owner: "worker-1",
    lease_expires_at: "2999-01-01T00:00:00.000Z", suppress_conversation_log: true,
  };
  const attempts: Row[] = [];
  let claimed = false;
  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let update: Row | null = null;
    let inserted: Row | null = null;
    let listResult = false;
    const matches = () => filters.every((filter) => filter(outbox));
    const result = () => {
      if (table === "sms_runtime_config") return { data: { mode: "enabled", pilot_manager_user_ids: ["owner-1"] }, error: null };
      if (table === "sms_outbox") return { data: matches() ? listResult ? [{ ...outbox }] : { ...outbox } : listResult ? [] : null, error: null };
      if (table === "sms_delivery_attempts") return { data: [], error: null };
      if (table === "sms_delivery_events") return { data: null, error: null };
      return { data: null, error: null };
    };
    const apply = () => {
      if (table === "sms_outbox" && update && matches()) Object.assign(outbox, update);
      if (table === "sms_delivery_attempts" && update) Object.assign(attempts[0] ?? {}, update);
    };
    const q = {
      select() { return q; },
      eq(column: string, value: unknown) { filters.push((row) => row[column] === value); return q; },
      in(column: string, values: unknown[]) { listResult = true; filters.push((row) => values.includes(row[column])); return q; },
      is(column: string, value: unknown) { filters.push((row) => row[column] === value); return q; },
      gt(column: string, value: string) { filters.push((row) => String(row[column] ?? "") > value); return q; },
      lt(column: string, value: string) { filters.push((row) => String(row[column] ?? "") < value); return q; },
      order() { return q; },
      limit() { listResult = true; return q; },
      update(payload: Row) { update = payload; return q; },
      insert(payload: Row) { inserted = payload; attempts.push({ id: `attempt-${attempts.length + 1}`, ...payload }); return q; },
      maybeSingle() {
        const matched = table !== "sms_outbox" || matches();
        apply();
        return Promise.resolve(table === "sms_outbox" && update
          ? { data: matched ? { ...outbox } : null, error: null }
          : result());
      },
      single() { return Promise.resolve(table === "sms_delivery_attempts" && inserted ? { data: attempts.at(-1), error: null } : result()); },
      then(resolve: (value: unknown) => unknown) { apply(); return Promise.resolve(result()).then(resolve); },
    };
    return q;
  };
  return {
    outbox,
    db: {
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
    } as never,
  };
}

describe("selected-line SMS credit at the final dispatch boundary", () => {
  let remainingCents: number;
  let paused: boolean;
  let unreadable: boolean;
  let optedOut: boolean;
  let consentGranted: boolean;
  let fromNumber: string;
  let workspaceId: string;
  const walletReads: Array<{ workspaceId: string | undefined; remainingCents: number }> = [];

  beforeEach(() => {
    process.env.SMS_RUNTIME_ENABLED = "1";
    process.env.SMS_OUTBOX_SCHEDULER_READY = "1";
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG1";
    process.env.TWILIO_CAMPAIGN_SID = "CP1";
    remainingCents = 3;
    paused = false;
    unreadable = false;
    optedOut = false;
    consentGranted = true;
    fromNumber = "+12065550999";
    workspaceId = "workspace-other";
    walletReads.length = 0;
    mocks.resolveLine.mockReset().mockImplementation(async (_db, ownerId: string, _columns, opts: { workLineId?: string }) => {
      expect(ownerId).toBe("owner-1");
      expect(opts.workLineId).toBe("line-2");
      return { data: {
        manager_user_id: "owner-1", workspace_id: workspaceId, phone_number: fromNumber,
        phone_number_sid: "PN1", messaging_service_sid: "MG1", campaign_sid: "CP1",
        provision_state: "active", registration_state: "registered", registration_ref: null,
        attachment_state: null, number_registration_state: null, grace_started_at: null,
        grace_expires_at: null, quarantined_at: null, quarantine_reason: null,
      }, error: null };
    });
    mocks.loadWallet.mockReset().mockImplementation(async (_db, ownerId: string, walletWorkspaceId?: string) => {
      expect(ownerId).toBe("owner-1");
      walletReads.push({ workspaceId: walletWorkspaceId, remainingCents });
      if (unreadable) throw new Error("wallet unavailable");
      return { remainingCents, paused };
    });
    mocks.reserve.mockReset().mockImplementation(async (_db, reservation: { idempotencyKey: string; workspaceId: string; quantity: number }) => {
      expect(reservation).toMatchObject({ idempotencyKey: "sms_outbound:outbox-1", workspaceId: "workspace-other", quantity: 1 });
      if (remainingCents < 3) return { allowed: false, reason: "allowance_exhausted" };
      remainingCents -= 3;
      return { allowed: true, duplicate: false, state: "reserved" };
    });
    mocks.finish.mockReset().mockImplementation(async (_db, ownerId: string, key: string, refund?: boolean) => {
      expect(ownerId).toBe("owner-1");
      expect(key).toBe("sms_outbound:outbox-1");
      if (refund) remainingCents += 3;
    });
    mocks.suppression.mockReset().mockImplementation(async (_db, _phone: string, options: { userId?: string }) => {
      expect(options.userId).toBe("resident-1");
      return { ok: true, optedOut };
    });
    mocks.consent.mockReset().mockImplementation(async (_db, scope: { recipientUserId?: string }) => {
      expect(scope.recipientUserId).toBe("resident-1");
      return { ok: true, granted: consentGranted };
    });
    mocks.sendSms.mockReset().mockResolvedValue({ sent: true, sid: "SM1" });
  });

  it("sends once from a nondefault workspace with exactly one segment of credit", async () => {
    const fixture = dispatchDb();
    const result = await dispatchOwnerSmsOutbox({ workerId: "worker-1" }, fixture.db);
    expect(result).toMatchObject({ claimed: 1, submitted: 1, blocked: 0 });
    expect(fixture.outbox.status).toBe("submitted");
    expect(walletReads).toEqual([
      { workspaceId: "workspace-other", remainingCents: 3 },
      { workspaceId: "workspace-other", remainingCents: 0 },
    ]);
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.sendSms).toHaveBeenCalledOnce();
    expect(mocks.sendSms).toHaveBeenCalledWith(
      "+12065550142", "A one segment message", "+12065550999",
      { skipOptOutCheck: true, creditReservationKey: "sms_outbound:outbox-1" },
    );
    expect(mocks.finish).toHaveBeenCalledOnce();
    expect(mocks.finish).toHaveBeenCalledWith(fixture.db, "owner-1", "sms_outbound:outbox-1");
    expect(remainingCents).toBe(0);
  });

  it("blocks an insufficient wallet before reservation", async () => {
    remainingCents = 2;
    const fixture = dispatchDb();
    await dispatchOwnerSmsOutbox({ workerId: "worker-1" }, fixture.db);
    expect(fixture.outbox).toMatchObject({ status: "blocked", blocked_reason: "comms_billing_allowance_exhausted" });
    expect(walletReads).toEqual([{ workspaceId: "workspace-other", remainingCents: 2 }]);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it.each([
    ["pause", "comms_billing_billing_paused"],
    ["unreadable", "comms_billing_plan_unreadable"],
    ["optout", "recipient_opted_out"],
    ["consent", "scoped_consent_missing"],
    ["phone", "work_number_changed"],
    ["workspace", "work_number_changed"],
  ] as const)("refunds a reservation when %s changes before provider submission", async (change: LateChange, reason) => {
    mocks.reserve.mockImplementationOnce(async (_db, reservation: { idempotencyKey: string; workspaceId: string }) => {
      expect(reservation).toMatchObject({ idempotencyKey: "sms_outbound:outbox-1", workspaceId: "workspace-other" });
      remainingCents -= 3;
      if (change === "pause") paused = true;
      if (change === "unreadable") unreadable = true;
      if (change === "optout") optedOut = true;
      if (change === "consent") consentGranted = false;
      if (change === "phone") fromNumber = "+12065550888";
      if (change === "workspace") workspaceId = "workspace-changed";
      return { allowed: true, duplicate: false, state: "reserved" };
    });
    const fixture = dispatchDb();
    const result = await dispatchOwnerSmsOutbox({ workerId: "worker-1" }, fixture.db);
    expect(result).toMatchObject({ claimed: 1, submitted: 0, blocked: 1 });
    expect(fixture.outbox).toMatchObject({ status: "blocked", blocked_reason: reason });
    expect(mocks.sendSms).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledOnce();
    expect(mocks.finish).toHaveBeenCalledWith(fixture.db, "owner-1", "sms_outbound:outbox-1", true);
    expect(remainingCents).toBe(3);
    expect(walletReads).toHaveLength(2);
  });
});
