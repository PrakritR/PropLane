import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatchDb } from "./support/dispatch-memory-db";

/**
 * The dispatch loop end to end against an in-memory database, with the transport mocked so
 * every text is recorded instead of sent (vendor-dispatch-1018). What each test proves is
 * named in its title: rule precedence, chain order, nothing to a vendor before approval,
 * broadcast first-YES-wins, busy / timeout / exhausted, price over cap, ambiguous answers,
 * workspace isolation and the privacy of the offer text.
 */

const sent = vi.hoisted(() => ({
  vendor: [] as Array<{ vendorDirectoryId: string; phone: string; text: string; ownerUserId: string }>,
  keys: new Set<string>(),
  team: [] as Array<{ memberUserId: string; text: string; ownerUserId: string }>,
  resident: [] as Array<{ residentEmail: string; text: string }>,
  workOrderEvents: [] as Array<{ event: string; recipients: unknown[] }>,
  unreachable: new Set<string>(),
  optedOut: new Set<string>(),
  teammates: [] as string[],
}));

vi.mock("@/lib/vendor-dispatch/send.server", () => ({
  workspaceOnSharedLine: async () => false,
  sendVendorDispatchText: async (_db: unknown, input: { vendorDirectoryId: string; phone: string; text: string; ownerUserId: string; idempotencyKey: string }) => {
    if (sent.unreachable.has(input.vendorDirectoryId)) return { ok: false, reason: "blocked" };
    // The real transport dedupes on the idempotency key; so does this stand-in.
    if (sent.keys.has(input.idempotencyKey)) return { ok: true, outboxId: null };
    sent.keys.add(input.idempotencyKey);
    sent.vendor.push({ vendorDirectoryId: input.vendorDirectoryId, phone: input.phone, text: input.text, ownerUserId: input.ownerUserId });
    return { ok: true, outboxId: null };
  },
  sendTeamMemberDispatchText: async (_db: unknown, input: { memberUserId: string; text: string; ownerUserId: string }) => {
    sent.team.push({ memberUserId: input.memberUserId, text: input.text, ownerUserId: input.ownerUserId });
    return { ok: true, outboxId: null };
  },
  sendResidentDispatchText: async (_db: unknown, input: { residentEmail: string; text: string }) => {
    sent.resident.push({ residentEmail: input.residentEmail, text: input.text });
    return { ok: true, outboxId: null };
  },
}));
vi.mock("@/lib/sms/vendor-conversation-consent.server", () => ({
  readVendorTextConsent: async (_db: unknown, input: { phone: string }) => ({
    ok: true,
    state: sent.optedOut.has(input.phone) ? "opted_out" : "granted",
    conversationKey: "k",
    grantedUnder: "k",
    grantSource: "test",
  }),
}));
vi.mock("@/lib/team-comms.server", () => ({
  resolveWorkspaceTeamMembersWithGrants: async (_db: unknown, input: { ownerManagerUserId: string }) => [
    { userId: input.ownerManagerUserId, teamRole: null, isOwner: true, grantRow: null },
    ...sent.teammates.map((userId) => ({
      userId,
      teamRole: "admin",
      isOwner: false,
      grantRow: { house_scope: "all", assigned_property_ids: [], co_manager_permissions: { services: true }, team_role: "admin" },
    })),
  ],
}));
vi.mock("@/lib/work-order-events.server", () => ({
  workOrderEvent: async (_db: unknown, input: { event: string; recipients: unknown[] }) => {
    sent.workOrderEvents.push({ event: input.event, recipients: input.recipients });
    return { eventId: "e", duplicate: false, delivered: 0, deferred: 0, failed: 0 };
  },
}));
vi.mock("@/lib/google-calendar/sync.server", () => ({ syncWorkOrderToGoogleCalendar: async (_db: unknown, _owner: string, row: unknown) => row }));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: async () => undefined }));
vi.mock("@/lib/work-order-resident-confirmation.server", () => ({
  requestResidentConfirmation: async () => null,
  resolveResidentConfirmationBySms: async () => null,
}));
vi.mock("@/lib/work-order-vendor-invoice.server", () => ({ ensureSubmittedVendorInvoiceForMarkedDone: async () => undefined }));
vi.mock("@/lib/vendor-invoice-submit.server", () => ({ prepareVendorInvoiceSubmission: async () => ({}), insertVendorInvoiceRow: async () => ({ data: null }) }));
vi.mock("@/lib/manager-bills.server", () => ({ createBillFromVendorInvoice: async () => ({ id: "bill" }) }));
vi.mock("@/lib/vendor-invoice-decision-notify.server", () => ({ notifyVendorOfInvoiceDecision: async () => undefined }));
vi.mock("@/lib/reports/auth", () => ({ assertFinancialsTier: async () => ({ ok: true }) }));
vi.mock("@/lib/agent/portal-assistant-session.server", () => ({ readPortalAssistantSmsSession: async () => ({ ok: true, session: null }) }));
vi.mock("@/lib/sms/agent-confirmation.server", () => ({
  classifySmsConfirmationReply: () => "none",
  resolveOpenSmsProposal: async () => ({ status: "none" }),
}));
vi.mock("@/lib/communication/manager-assistant-workspace.server", () => ({ userDefaultWorkspaceId: async () => "ws-1" }));

import { matchDispatchRule, orderMatchingRules } from "@/lib/vendor-dispatch/match.server";
import { approveDispatchRun, cancelDispatchRun, createDispatchRun, declineDispatchRun, retryDispatchRun } from "@/lib/vendor-dispatch/runs.server";
import { decideVendorQuote, recordVendorBusy, recordVendorNo, recordVendorYes, timeoutAttempt } from "@/lib/vendor-dispatch/responses.server";
import { handleManagerDispatchReply, handleResidentDispatchReply, handleVendorDispatchReply } from "@/lib/vendor-dispatch/inbound.server";
import { recordVendorDone } from "@/lib/vendor-dispatch/completion.server";
import { sweepVendorDispatch } from "@/lib/vendor-dispatch/sweep.server";
import { maybeCreateRuleRunForWorkOrder } from "@/lib/vendor-dispatch/triggers.server";
import type { DispatchRuleRow } from "@/lib/vendor-dispatch/types";
import { approveVendorDispatchTool, dispatchVendorTool, listVendorDispatchesTool } from "@/lib/tools/domains/vendor-dispatch";

const OWNER = "owner-1";
const OWNER2 = "owner-2";
const WS = "ws-1";
const WS2 = "ws-2";
const PROP = "prop-1";
const T0 = new Date("2026-10-19T20:00:00Z"); // Monday 1:00pm Pacific

type Row = Record<string, unknown>;

function vendor(id: string, name: string, phone: string, extra: Row = {}, owner = OWNER): Row {
  return {
    id,
    manager_user_id: owner,
    vendor_user_id: null,
    row_data: { id, name, trade: "Locksmith", trades: ["Locksmith"], phone, email: "", notes: "", active: true, ...extra },
  };
}

function rule(overrides: Partial<DispatchRuleRow> = {}): Row {
  return {
    id: "r1",
    workspace_id: WS,
    owner_user_id: OWNER,
    name: "Lockouts",
    trade: "locksmith",
    issue: "lockout",
    property_scope: "all",
    property_ids: [],
    urgencies: ["emergency", "urgent", "routine"],
    hours: "any",
    mode: "sequential",
    broadcast_size: 3,
    timeout_minutes: null,
    pay_cents: 12000,
    pay_model: "flat",
    nte_cents: 18000,
    approval: "always",
    active: true,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

function workOrderRow(overrides: Row = {}): Row {
  return {
    id: "wo-1",
    reference: "WO-1",
    propertyName: "5259 Brooklyn",
    unit: "R3",
    title: "Locked out",
    priority: "Emergency",
    status: "Submitted",
    bucket: "open",
    description: "I am locked out, call me at (206) 555-0142 or dana@example.com",
    scheduled: "—",
    cost: "—",
    propertyAddress: "5259 Brooklyn Ave NE, Seattle, WA 98105",
    propertyId: PROP,
    managerUserId: OWNER,
    residentName: "Dana Lee",
    residentEmail: "dana@example.com",
    category: "access",
    ...overrides,
  };
}

function world(options: { rules?: Row[]; vendors?: Row[]; extra?: Record<string, Row[]> } = {}) {
  const vendors = options.vendors ?? [
    vendor("v1", "Sam Locksmith", "(206) 555-0101"),
    vendor("v2", "Lee Locks", "(206) 555-0102"),
    vendor("v3", "Kim Keys", "(206) 555-0103"),
  ];
  return createDispatchDb({
    manager_property_records: [
      { id: PROP, manager_user_id: OWNER, workspace_id: WS, property_data: { address: "5259 Brooklyn Ave NE, Seattle, WA 98105", title: "5259 Brooklyn" } },
    ],
    manager_vendor_records: vendors,
    vendor_dispatch_rules: options.rules ?? [rule()],
    vendor_dispatch_rule_vendors: [
      { rule_id: "r1", vendor_directory_id: "v1", position: 0 },
      { rule_id: "r1", vendor_directory_id: "v2", position: 1 },
      { rule_id: "r1", vendor_directory_id: "v3", position: 2 },
    ],
    portal_work_order_records: [{ id: "wo-1", manager_user_id: OWNER, vendor_user_id: null, row_data: workOrderRow() }],
    profiles: [{ id: "owner-1", email: "owner@example.com", full_name: "Olive Owner" }],
    ...options.extra,
  });
}

type Db = ReturnType<typeof world>;

async function newRun(db: Db, overrides: Partial<Parameters<typeof createDispatchRun>[1]> = {}) {
  const created = await createDispatchRun(db as never, {
    workspaceId: WS,
    ownerUserId: OWNER,
    sourceType: "work_order",
    sourceId: "wo-1",
    trade: "locksmith",
    issue: "lockout",
    urgency: "emergency",
    propertyId: PROP,
    residentEmail: "dana@example.com",
    createdBy: null,
    at: T0,
    details: { what: "Lockout", room: "R3", personFirstName: "Dana", summary: "call me at (206) 555-0142 or dana@example.com" },
    ...overrides,
  });
  if (!created.ok) throw new Error(`run not created: ${created.reason}`);
  return created.run;
}

const rows = (db: Db, table: string) => db.__tables[table] ?? [];
const attemptsOf = (db: Db, runId: string) => rows(db, "vendor_dispatch_attempts").filter((a) => a.run_id === runId).sort((a, b) => Number(a.position) - Number(b.position));
const runById = (db: Db, runId: string) => rows(db, "vendor_dispatch_runs").find((r) => r.id === runId)!;
const approve = (db: Db, runId: string) =>
  approveDispatchRun(db as never, { ownerUserId: OWNER, actorUserId: OWNER, channel: "sms", runId, now: T0 });

beforeEach(() => {
  sent.vendor.length = 0;
  sent.keys.clear();
  sent.team.length = 0;
  sent.resident.length = 0;
  sent.workOrderEvents.length = 0;
  sent.unreachable.clear();
  sent.optedOut.clear();
  sent.teammates.length = 0;
});

describe("which rule governs a job", () => {
  const base = { workspaceId: WS, ownerUserId: OWNER, trade: "locksmith", issue: "lockout", propertyId: PROP, urgency: "emergency" as const };
  const mk = (overrides: Partial<DispatchRuleRow>) => rule(overrides) as unknown as DispatchRuleRow;

  it("a selected rule naming the property beats all; an issue rule beats trade-only; ties go to the newest", () => {
    const rules = [
      mk({ id: "all-trade", issue: null, updated_at: "2026-10-10T00:00:00Z" }),
      mk({ id: "all-issue", issue: "lockout", updated_at: "2026-10-02T00:00:00Z" }),
      mk({ id: "all-issue-newer", issue: "lockout", updated_at: "2026-10-05T00:00:00Z" }),
      mk({ id: "selected-trade", issue: null, property_scope: "selected", property_ids: [PROP], updated_at: "2026-09-01T00:00:00Z" }),
    ];
    expect(orderMatchingRules(rules, base, T0).map((r) => r.id)).toEqual(["selected-trade", "all-issue-newer", "all-issue", "all-trade"]);
  });

  it("filters by property, issue, urgency, hours and active", () => {
    const rules = [
      mk({ id: "other-house", property_scope: "selected", property_ids: ["prop-9"] }),
      mk({ id: "other-issue", issue: "rekey" }),
      mk({ id: "routine-only", urgencies: ["routine"] }),
      mk({ id: "after-hours", hours: "after_hours" }),
      mk({ id: "inactive", active: false }),
      mk({ id: "other-workspace", workspace_id: WS2 }),
      mk({ id: "business", hours: "business" }),
    ];
    // T0 is Monday 1pm Pacific: business hours.
    expect(orderMatchingRules(rules, base, T0).map((r) => r.id)).toEqual(["business"]);
    expect(orderMatchingRules(rules, base, new Date("2026-10-24T18:00:00Z")).map((r) => r.id)).toEqual(["after-hours"]);
  });

  it("builds the chain in the rule's order and skips vendors who cannot be texted", async () => {
    sent.optedOut.add("+12065550102");
    const db = world({
      vendors: [
        vendor("v1", "Sam Locksmith", "(206) 555-0101"),
        vendor("v2", "Lee Locks", "(206) 555-0102"), // opted out
        vendor("v3", "Kim Keys", ""), // no phone
      ],
    });
    db.__tables.vendor_dispatch_rule_vendors!.push({ rule_id: "r1", vendor_directory_id: "v4", position: 3 }, { rule_id: "r1", vendor_directory_id: "v5", position: 4 });
    db.__tables.manager_vendor_records!.push(vendor("v4", "Busy Bo", "(206) 555-0104"), vendor("v5", "Pat Pins", "(206) 555-0105", { active: false }));
    db.__tables.vendor_dispatch_attempts = [{ id: "old", run_id: "x", vendor_directory_id: "v4", position: 0, status: "busy", busy_until: "2026-10-19T23:00:00Z" }];
    const match = await matchDispatchRule(db as never, { ...base, at: T0 });
    expect(match.source).toBe("rule");
    expect(match.chain.map((v) => v.vendorDirectoryId)).toEqual(["v1"]);
    expect(match.chain[0]).toMatchObject({ name: "Sam Locksmith", phone: "+12065550101", position: 0 });
  });

  it("falls back to the trade's roster when no rule matches, and reports none when nobody fits", async () => {
    const db = world({ rules: [] });
    const fallback = await matchDispatchRule(db as never, { ...base, at: T0 });
    expect(fallback.source).toBe("fallback");
    expect(fallback.chain.map((v) => v.vendorDirectoryId).sort()).toEqual(["v1", "v2", "v3"]);
    const none = await matchDispatchRule(db as never, { ...base, trade: "plumber", at: T0 });
    expect(none).toMatchObject({ source: "none", chain: [] });
  });
});

describe("approval comes first", () => {
  it("creates the run, asks the owner, and texts no vendor before approval", async () => {
    const db = world();
    const run = await newRun(db);
    expect(run.status).toBe("awaiting_approval");
    expect(run.handle).toBe(1);
    expect(attemptsOf(db, run.id).map((a) => [a.vendor_directory_id, a.status])).toEqual([
      ["v1", "queued"],
      ["v2", "queued"],
      ["v3", "queued"],
    ]);
    expect(sent.vendor).toHaveLength(0);
    expect(sent.team).toHaveLength(1);
    expect(sent.team[0]).toMatchObject({ memberUserId: OWNER });
    expect(sent.team[0]!.text).toBe("Lockout 5259 Brooklyn Ave NE R3 #1. Send Sam Locksmith $120, then Lee Locks, Kim Keys if busy? Y/N or 1-3 to pick one");
    expect(rows(db, "work_order_vendor_offers")).toHaveLength(0);
  });

  it("is idempotent on the source: a second create returns the same run and asks once", async () => {
    const db = world();
    const first = await newRun(db);
    const second = await createDispatchRun(db as never, {
      workspaceId: WS, ownerUserId: OWNER, sourceType: "work_order", sourceId: "wo-1", trade: "locksmith", issue: "lockout",
      urgency: "emergency", propertyId: PROP, details: {}, at: T0,
    });
    expect(second).toMatchObject({ ok: true, created: false });
    expect(second.ok && second.run.id).toBe(first.id);
    expect(rows(db, "vendor_dispatch_runs")).toHaveLength(1);
    expect(sent.team).toHaveLength(1);
  });

  it("refuses a gas smell and a job nobody can be texted for", async () => {
    const db = world();
    const gas = await createDispatchRun(db as never, {
      workspaceId: WS, ownerUserId: OWNER, sourceType: "manual", sourceId: "m1", trade: "plumber", issue: "gas_smell",
      urgency: "emergency", details: {}, at: T0,
    });
    expect(gas).toMatchObject({ ok: false, reason: "never_auto" });
    const none = await createDispatchRun(db as never, {
      workspaceId: WS, ownerUserId: OWNER, sourceType: "manual", sourceId: "m2", trade: "plumber", issue: "leak",
      urgency: "emergency", details: {}, at: T0,
    });
    expect(none).toMatchObject({ ok: false, reason: "no_vendors" });
    expect(rows(db, "vendor_dispatch_runs")).toHaveLength(0);
  });

  it("offers the first vendor after approval, shows the vendor portal offer, and a double approval is a no-op", async () => {
    const db = world();
    const run = await newRun(db);
    const [one, two] = await Promise.all([approve(db, run.id), approve(db, run.id)]);
    expect([one.ok, two.ok].sort()).toEqual([false, true]);
    expect(runById(db, run.id)).toMatchObject({ status: "offering", approved_by: OWNER, approval_channel: "sms" });
    expect(sent.vendor.map((v) => v.vendorDirectoryId)).toEqual(["v1"]);
    expect(attemptsOf(db, run.id).map((a) => a.status)).toEqual(["offered", "queued", "queued"]);
    expect(rows(db, "work_order_vendor_offers")).toMatchObject([{ work_order_id: "wo-1", vendor_directory_id: "v1", status: "sent", manager_user_id: OWNER }]);
    const audit = rows(db, "action_events").map((e) => e.event_type);
    expect(audit).toEqual(expect.arrayContaining(["created", "approval_requested", "approved", "offered"]));
  });

  it("picks one vendor by number and cancels the rest of the chain", async () => {
    const db = world();
    const run = await newRun(db);
    const result = await approveDispatchRun(db as never, { ownerUserId: OWNER, actorUserId: OWNER, channel: "sms", runId: run.id, pickPosition: 1, now: T0 });
    expect(result.ok).toBe(true);
    expect(sent.vendor.map((v) => v.vendorDirectoryId)).toEqual(["v2"]);
    expect(attemptsOf(db, run.id).map((a) => a.status)).toEqual(["canceled", "offered", "canceled"]);
  });

  it("a declined dispatch texts nobody, and the decline STICKS against an automatic trigger", async () => {
    const db = world();
    const run = await newRun(db);
    const result = await declineDispatchRun(db as never, { ownerUserId: OWNER, actorUserId: OWNER, channel: "sms", runId: run.id, now: T0 });
    expect(result).toEqual({ ok: true, status: "declined_by_manager" });
    expect(sent.vendor).toHaveLength(0);
    expect(attemptsOf(db, run.id).every((a) => a.status === "canceled")).toBe(true);
    // The sweep runs every two minutes on a stable source id: it must hand back the declined run rather than
    // insert a new one and re-text the approver for the rest of the day.
    const again = await newRun(db);
    expect(again.id).toBe(run.id);
    expect(again.status).toBe("declined_by_manager");
    expect(rows(db, "vendor_dispatch_runs")).toHaveLength(1);
    expect(sent.team).toHaveLength(1);
    // The manager asking for it themselves is a new request, so it does start a fresh run.
    const restarted = await newRun(db, { restartExhausted: true, skipApprovalRequest: true });
    expect(restarted.id).not.toBe(run.id);
    expect(rows(db, "vendor_dispatch_runs")).toHaveLength(2);
  });

  it("a completed or canceled job is not re-proposed by a trigger either", async () => {
    for (const status of ["completed", "canceled"]) {
      const db = world();
      const run = await newRun(db);
      runById(db, run.id)!.status = status;
      const again = await newRun(db);
      expect(again.id).toBe(run.id);
      expect(rows(db, "vendor_dispatch_runs")).toHaveLength(1);
    }
  });
});

describe("the vendor's answer", () => {
  it("BUSY parks the vendor and moves to the next; a timeout does the same", async () => {
    const db = world();
    const run = await newRun(db);
    await approve(db, run.id);
    const first = attemptsOf(db, run.id)[0]!;
    const busy = await recordVendorBusy(db as never, { ownerUserId: OWNER, attemptId: String(first.id), minutes: 120, rawText: "BUSY 2h", now: T0 });
    expect(busy).toEqual({ outcome: "busy" });
    expect(attemptsOf(db, run.id)[0]).toMatchObject({ status: "busy", busy_until: "2026-10-19T22:00:00.000Z" });
    expect(sent.vendor.map((v) => v.vendorDirectoryId)).toEqual(["v1", "v1", "v2"]); // offer, ack, next offer

    // The parked vendor is skipped for new jobs until busy_until passes.
    const match = await matchDispatchRule(db as never, { workspaceId: WS, ownerUserId: OWNER, trade: "locksmith", issue: "lockout", propertyId: PROP, urgency: "emergency", at: T0 });
    expect(match.chain.map((v) => v.vendorDirectoryId)).toEqual(["v2", "v3"]);

    const second = attemptsOf(db, run.id)[1]!;
    expect(await timeoutAttempt(db as never, String(second.id), new Date(T0.getTime() + 5 * 60_000))).toBe(false); // not due yet
    expect(await timeoutAttempt(db as never, String(second.id), new Date(T0.getTime() + 11 * 60_000))).toBe(true); // emergency: 10 minutes
    expect(attemptsOf(db, run.id).map((a) => a.status)).toEqual(["busy", "timed_out", "offered"]);
    expect(sent.vendor.at(-1)).toMatchObject({ vendorDirectoryId: "v3" });
  });

  it("a NO moves on; when the chain runs out the manager gets the three ways forward, once", async () => {
    const db = world();
    const run = await newRun(db);
    await approve(db, run.id);
    for (let i = 0; i < 3; i += 1) {
      const attempt = attemptsOf(db, run.id).find((a) => a.status === "offered")!;
      await recordVendorNo(db as never, { ownerUserId: OWNER, attemptId: String(attempt.id), rawText: "NO", now: T0 });
    }
    expect(runById(db, run.id)).toMatchObject({ status: "exhausted" });
    const exhausted = sent.team.filter((t) => t.text.startsWith("No one took"));
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]!.text).toBe("No one took #1. R to retry, B to offer all locksmiths at once, or handle it yourself");
    expect(rows(db, "work_order_vendor_offers").every((o) => o.status === "declined")).toBe(true);
  });

  it("R retries the chain and B offers every locksmith at once", async () => {
    const db = world();
    const run = await newRun(db);
    await approve(db, run.id);
    for (let i = 0; i < 3; i += 1) {
      const attempt = attemptsOf(db, run.id).find((a) => a.status === "offered")!;
      await recordVendorNo(db as never, { ownerUserId: OWNER, attemptId: String(attempt.id), now: T0 });
    }
    sent.vendor.length = 0;
    const broadcast = await retryDispatchRun(db as never, { ownerUserId: OWNER, actorUserId: OWNER, channel: "sms", runId: run.id, broadcast: true, now: T0 });
    expect(broadcast.ok).toBe(true);
    expect(runById(db, run.id)).toMatchObject({ status: "offering", mode: "broadcast", wave: 1 });
    expect(sent.vendor.filter((v) => v.text.startsWith("PropLane job")).map((v) => v.vendorDirectoryId).sort()).toEqual(["v1", "v2", "v3"]);
  });

  it("R re-offers only vendors it may actually text: a BUSY window and an opt-out both survive it", async () => {
    const db = world();
    const run = await newRun(db);
    await approve(db, run.id);
    // v1 says BUSY for two hours; v2 and v3 decline; the chain is exhausted.
    const first = attemptsOf(db, run.id).find((a) => a.status === "offered")!;
    await recordVendorBusy(db as never, { ownerUserId: OWNER, attemptId: String(first.id), minutes: 120, now: T0 });
    for (let i = 0; i < 2; i += 1) {
      const attempt = attemptsOf(db, run.id).find((a) => a.status === "offered")!;
      await recordVendorNo(db as never, { ownerUserId: OWNER, attemptId: String(attempt.id), now: T0 });
    }
    expect(runById(db, run.id)).toMatchObject({ status: "exhausted" });

    sent.optedOut.add("+12065550102");
    sent.vendor.length = 0;
    const retried = await retryDispatchRun(db as never, { ownerUserId: OWNER, actorUserId: OWNER, channel: "sms", runId: run.id, broadcast: false, now: T0 });
    expect(retried.ok).toBe(true);
    // v1 was told "we will not text you for 2h" a minute ago, and v2 has opted out: only v3 is re-offered.
    const roster = attemptsOf(db, run.id).filter((a) => a.wave === 1).map((a) => a.vendor_directory_id).sort();
    expect(roster).toEqual(["v3"]);
    expect(sent.vendor.map((v) => v.vendorDirectoryId)).not.toContain("v1");
    expect(sent.vendor.map((v) => v.vendorDirectoryId)).not.toContain("v2");
    // The busy window is left standing rather than cleared by the re-offer.
    expect(attemptsOf(db, run.id).find((a) => a.vendor_directory_id === "v1")!.busy_until).toBeTruthy();
  });

  it("a YES with a time accepts, assigns the service as Scheduled and tells everyone", async () => {
    const db = world();
    const run = await newRun(db);
    await approve(db, run.id);
    const attempt = attemptsOf(db, run.id)[0]!;
    const outcome = await recordVendorYes(db as never, { ownerUserId: OWNER, attemptId: String(attempt.id), timeText: "2:30pm", rawText: "YES 2:30pm", now: T0 });
    expect(outcome).toEqual({ outcome: "accepted", scheduledIso: "2026-10-19T21:30:00.000Z" });
    expect(runById(db, run.id)).toMatchObject({ status: "accepted", accepted_vendor_directory_id: "v1", scheduled_for: "2026-10-19T21:30:00.000Z", agreed_cents: 12000 });
    const wo = rows(db, "portal_work_order_records")[0]!;
    expect(wo.row_data).toMatchObject({ vendorId: "v1", vendorName: "Sam Locksmith", bucket: "scheduled", status: "Scheduled", scheduledAtIso: "2026-10-19T21:30:00.000Z", selfAssigned: false });
    expect(sent.team.at(-1)!.text).toBe("Sam accepted, ~2:30pm #1");
    expect(sent.resident.at(-1)!.text).toBe("Sam (locksmith) is coming around 2:30pm.");
    const confirm = sent.vendor.at(-1)!.text;
    expect(confirm).toContain("5259 Brooklyn Ave NE");
    expect(confirm).not.toMatch(/555-0142|@/);
  });

  it("a YES without a time leaves the service Assigned, not Scheduled", async () => {
    const db = world();
    const run = await newRun(db);
    await approve(db, run.id);
    const outcome = await recordVendorYes(db as never, { ownerUserId: OWNER, attemptId: String(attemptsOf(db, run.id)[0]!.id), rawText: "YES", now: T0 });
    expect(outcome).toEqual({ outcome: "accepted", scheduledIso: null });
    expect(rows(db, "portal_work_order_records")[0]!.row_data).toMatchObject({ vendorId: "v1", bucket: "open" });
    expect(sent.team.at(-1)!.text).toBe("Sam accepted #1");
  });

  it("a service somebody else assigned meanwhile is never overwritten, and the manager is told", async () => {
    const db = world();
    const run = await newRun(db);
    await approve(db, run.id);
    rows(db, "portal_work_order_records")[0]!.row_data = workOrderRow({ vendorId: "other", vendorName: "Someone Else" });
    const outcome = await recordVendorYes(db as never, { ownerUserId: OWNER, attemptId: String(attemptsOf(db, run.id)[0]!.id), rawText: "YES", now: T0 });
    expect(outcome).toEqual({ outcome: "taken" });
    expect(rows(db, "portal_work_order_records")[0]!.row_data).toMatchObject({ vendorId: "other" });
    expect(runById(db, run.id)).toMatchObject({ status: "canceled" });
    expect(sent.team.at(-1)!.text).toContain("already assigned elsewhere");
  });

  it("a broadcast with two YES at once books exactly one vendor; the rest are told it was taken", async () => {
    const db = world({ rules: [rule({ mode: "broadcast", broadcast_size: 3 })] });
    const run = await newRun(db);
    await approve(db, run.id);
    expect(sent.vendor.filter((v) => v.text.startsWith("PropLane job")).map((v) => v.vendorDirectoryId)).toEqual(["v1", "v2", "v3"]);
    const [a1, a2] = attemptsOf(db, run.id);
    const results = await Promise.all([
      recordVendorYes(db as never, { ownerUserId: OWNER, attemptId: String(a1!.id), rawText: "YES", now: T0 }),
      recordVendorYes(db as never, { ownerUserId: OWNER, attemptId: String(a2!.id), rawText: "YES", now: T0 }),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["accepted", "taken"]);
    const final = attemptsOf(db, run.id).map((a) => a.status).sort();
    expect(final).toEqual(["accepted", "superseded", "superseded"]);
    expect(runById(db, run.id).accepted_vendor_directory_id).toMatch(/^v[12]$/);
    const taken = sent.vendor.filter((v) => /was taken/.test(v.text));
    expect(taken).toHaveLength(2);
    const acceptedNotices = sent.team.filter((t) => /accepted/.test(t.text));
    expect(acceptedNotices).toHaveLength(1);
    // The service has exactly the winner on it.
    expect(rows(db, "portal_work_order_records")[0]!.row_data).toMatchObject({ vendorId: runById(db, run.id).accepted_vendor_directory_id });
    expect(rows(db, "work_order_vendor_offers").filter((o) => o.status === "withdrawn")).toHaveLength(2);
  });

  it("a price over the cap goes back to the manager; Y books it at that price, N tries the next vendor", async () => {
    const db = world();
    const run = await newRun(db);
    await approve(db, run.id);
    const first = attemptsOf(db, run.id)[0]!;
    const held = await recordVendorYes(db as never, { ownerUserId: OWNER, attemptId: String(first.id), priceCents: 24000, rawText: "YES $240", now: T0 });
    expect(held).toEqual({ outcome: "quote_held" });
    expect(runById(db, run.id).status).toBe("offering");
    expect(sent.team.at(-1)!.text).toBe("Sam quotes $240 (cap $180) #1. Y/N");
    expect(sent.vendor.at(-1)!.text).toMatch(/checking your price/);
    expect(rows(db, "portal_work_order_records")[0]!.row_data).not.toHaveProperty("vendorId");

    const approved = await decideVendorQuote(db as never, { ownerUserId: OWNER, actorUserId: OWNER, runId: run.id, approve: true, channel: "sms", now: T0 });
    expect(approved).toMatchObject({ ok: true, outcome: { outcome: "accepted" } });
    expect(runById(db, run.id)).toMatchObject({ status: "accepted", agreed_cents: 24000 });

    // And the refusal path, on a second job.
    const db2 = world();
    const run2 = await newRun(db2);
    await approve(db2, run2.id);
    await recordVendorYes(db2 as never, { ownerUserId: OWNER, attemptId: String(attemptsOf(db2, run2.id)[0]!.id), priceCents: 24000, now: T0 });
    const rejected = await decideVendorQuote(db2 as never, { ownerUserId: OWNER, actorUserId: OWNER, runId: run2.id, approve: false, channel: "sms", now: T0 });
    expect(rejected.ok).toBe(true);
    expect(attemptsOf(db2, run2.id).map((a) => a.status)).toEqual(["declined", "offered", "queued"]);
  });

  it("a price at or under the cap just books", async () => {
    const db = world();
    const run = await newRun(db);
    await approve(db, run.id);
    const outcome = await recordVendorYes(db as never, { ownerUserId: OWNER, attemptId: String(attemptsOf(db, run.id)[0]!.id), priceCents: 15000, now: T0 });
    expect(outcome.outcome).toBe("accepted");
    expect(runById(db, run.id).agreed_cents).toBe(15000);
  });

  it("a vendor whose text cannot be sent is skipped, not stuck", async () => {
    sent.unreachable.add("v1");
    const db = world();
    const run = await newRun(db);
    await approve(db, run.id);
    expect(attemptsOf(db, run.id).map((a) => a.status)).toEqual(["canceled", "offered", "queued"]);
    expect(String(attemptsOf(db, run.id)[0]!.response_text)).toMatch(/^unreachable:/);
  });
});

describe("answers by text", () => {
  it("a bare Y with two jobs waiting is refused and approves nothing; Y 1 approves only job 1", async () => {
    const db = world();
    const first = await newRun(db);
    rows(db, "portal_work_order_records").push({ id: "wo-2", manager_user_id: OWNER, vendor_user_id: null, row_data: workOrderRow({ id: "wo-2" }) });
    const second = await newRun(db, { sourceId: "wo-2" });
    expect([first.handle, second.handle]).toEqual([1, 2]);
    const ask = (body: string) =>
      handleManagerDispatchReply(db as never, { ownerUserId: OWNER, workspaceId: WS, actorUserId: OWNER, body, now: T0, assistantProposalOpen: async () => false });

    expect(await ask("Y")).toEqual({ handled: true, reply: "Which one? Reply Y 2 or Y 1" });
    expect(runById(db, first.id).status).toBe("awaiting_approval");
    expect(runById(db, second.id).status).toBe("awaiting_approval");
    expect(sent.vendor).toHaveLength(0);

    expect(await ask("Y 1")).toEqual({ handled: true, reply: "Approved #1. Texting now." });
    expect(runById(db, first.id).status).toBe("offering");
    expect(runById(db, second.id).status).toBe("awaiting_approval");
    expect(sent.vendor).toHaveLength(1);

    expect(await ask("N 2")).toEqual({ handled: true, reply: "Declined #2. Nobody was texted." });
    expect(runById(db, second.id).status).toBe("declined_by_manager");
  });

  it("a bare Y with one job and no assistant action approves it; with an assistant action open it asks which", async () => {
    const db = world();
    const run = await newRun(db);
    const withAssistant = await handleManagerDispatchReply(db as never, { ownerUserId: OWNER, workspaceId: WS, actorUserId: OWNER, body: "yes", now: T0, assistantProposalOpen: async () => true });
    expect(withAssistant).toMatchObject({ handled: true });
    expect((withAssistant as { reply: string }).reply).toMatch(/Two things are waiting/);
    expect(runById(db, run.id).status).toBe("awaiting_approval");

    const alone = await handleManagerDispatchReply(db as never, { ownerUserId: OWNER, workspaceId: WS, actorUserId: OWNER, body: "yes", now: T0, assistantProposalOpen: async () => false });
    expect(alone).toEqual({ handled: true, reply: "Approved #1. Texting now." });
    expect(runById(db, run.id).status).toBe("offering");
  });

  it("a number picks one vendor; one that is not on the chain is refused", async () => {
    const db = world();
    const run = await newRun(db);
    const ask = (body: string) =>
      handleManagerDispatchReply(db as never, { ownerUserId: OWNER, workspaceId: WS, actorUserId: OWNER, body, now: T0, assistantProposalOpen: async () => false });
    expect(await ask("7")).toEqual({ handled: true, reply: "#1 has no vendor number 7" });
    expect(runById(db, run.id).status).toBe("awaiting_approval");
    expect(await ask("2")).toMatchObject({ handled: true, reply: "Approved #1. Texting now." });
    expect(sent.vendor.map((v) => v.vendorDirectoryId)).toEqual(["v2"]);
  });

  it("leaves everything else alone: nothing pending, or text that is not an answer", async () => {
    const db = world();
    const ask = (body: string) =>
      handleManagerDispatchReply(db as never, { ownerUserId: OWNER, workspaceId: WS, actorUserId: OWNER, body, now: T0, assistantProposalOpen: async () => false });
    expect(await ask("Y")).toEqual({ handled: false });
    await newRun(db);
    expect(await ask("what is pending")).toEqual({ handled: false });
    expect(await ask("R")).toEqual({ handled: false }); // nothing exhausted
  });

  it("an answer never reaches another owner's or workspace's run, or a person who cannot approve", async () => {
    const db = world({
      extra: {
        manager_property_records: [
          { id: PROP, manager_user_id: OWNER, workspace_id: WS, property_data: { address: "5259 Brooklyn Ave NE, Seattle, WA", title: "5259 Brooklyn" } },
          { id: "prop-2", manager_user_id: OWNER2, workspace_id: WS2, property_data: { address: "9 Elm St, Tacoma, WA", title: "9 Elm" } },
        ],
      },
    });
    db.__tables.manager_vendor_records!.push(vendor("w1", "Wes Locks", "(253) 555-0201", {}, OWNER2));
    db.__tables.vendor_dispatch_rules!.push(rule({ id: "r2", workspace_id: WS2, owner_user_id: OWNER2 }));
    db.__tables.vendor_dispatch_rule_vendors!.push({ rule_id: "r2", vendor_directory_id: "w1", position: 0 });
    const mine = await newRun(db);
    const theirs = await createDispatchRun(db as never, {
      workspaceId: WS2, ownerUserId: OWNER2, sourceType: "manual", sourceId: "x1", trade: "locksmith", issue: "lockout",
      urgency: "emergency", propertyId: "prop-2", details: {}, at: T0,
    });
    if (!theirs.ok) throw new Error(theirs.reason);
    expect(theirs.run.handle).toBe(1); // handles are per owner: both are "#1"

    // Owner 1's "Y 1" approves owner 1's run and leaves owner 2's alone.
    const reply = await handleManagerDispatchReply(db as never, { ownerUserId: OWNER, workspaceId: WS, actorUserId: OWNER, body: "Y 1", now: T0, assistantProposalOpen: async () => false });
    expect(reply).toMatchObject({ handled: true, reply: "Approved #1. Texting now." });
    expect(runById(db, mine.id).status).toBe("offering");
    expect(runById(db, theirs.run.id).status).toBe("awaiting_approval");

    // The portal call can't reach it either, by id.
    expect(await approveDispatchRun(db as never, { ownerUserId: OWNER, actorUserId: OWNER, channel: "portal", runId: theirs.run.id })).toEqual({ ok: false, reason: "not_found" });
    expect(await cancelDispatchRun(db as never, { ownerUserId: OWNER, actorUserId: OWNER, channel: "portal", runId: theirs.run.id })).toEqual({ ok: false, reason: "not_found" });
    // A stranger is not an approver of owner 1's anything.
    const second = await createDispatchRun(db as never, {
      workspaceId: WS, ownerUserId: OWNER, sourceType: "manual", sourceId: "x2", trade: "locksmith", issue: "lockout",
      urgency: "emergency", propertyId: PROP, details: {}, at: T0,
    });
    if (!second.ok) throw new Error(second.reason);
    expect(await handleManagerDispatchReply(db as never, { ownerUserId: OWNER, workspaceId: WS, actorUserId: "stranger", body: "Y", now: T0 })).toEqual({ handled: false });
    expect(await approveDispatchRun(db as never, { ownerUserId: OWNER, actorUserId: "stranger", channel: "portal", runId: second.run.id })).toEqual({ ok: false, reason: "not_allowed" });
    expect(runById(db, second.run.id).status).toBe("awaiting_approval");
    // A reply arriving on another workspace's number does not see this workspace's run.
    expect(await handleManagerDispatchReply(db as never, { ownerUserId: OWNER, workspaceId: "ws-elsewhere", actorUserId: OWNER, body: "Y 2", now: T0 })).toEqual({ handled: false });
  });

  it("a vendor's text finds its job by phone, asks which when two are open, and ignores a stranger's phone", async () => {
    const db = world({ rules: [rule({ mode: "broadcast" })] });
    rows(db, "portal_work_order_records").push({ id: "wo-2", manager_user_id: OWNER, vendor_user_id: null, row_data: workOrderRow({ id: "wo-2" }) });
    const first = await newRun(db);
    const second = await newRun(db, { sourceId: "wo-2" });
    await approve(db, first.id);
    await approve(db, second.id);
    const tell = (body: string, phone = "+12065550101") =>
      handleVendorDispatchReply(db as never, { ownerUserId: OWNER, workspaceId: WS, phoneE164: phone, body, messageSid: `SM${Math.random()}`, now: T0 });

    expect(await tell("YES", "+12065559999")).toEqual({ handled: false });
    sent.vendor.length = 0;
    expect(await tell("YES")).toMatchObject({ handled: true });
    expect(sent.vendor.at(-1)!.text).toBe("Which job? Reply YES 2 or YES 1");
    expect(runById(db, first.id).status).toBe("offering");

    expect(await tell("YES 2 3pm")).toMatchObject({ handled: true });
    expect(runById(db, second.id)).toMatchObject({ status: "accepted", accepted_vendor_directory_id: "v1" });
    expect(runById(db, first.id).status).toBe("offering");
    expect(await tell("what time is it")).toEqual({ handled: false });
  });
});

describe("what a vendor can and cannot read", () => {
  it("the offer text carries the area, never the street, the resident's phone or email", async () => {
    const db = world();
    const run = await newRun(db);
    expect(run.offer_text).toContain("Seattle");
    expect(run.offer_text).not.toMatch(/5259|Brooklyn|555-0142|dana@|@/);
    await approve(db, run.id);
    for (const text of sent.vendor.map((v) => v.text)) {
      expect(text).not.toMatch(/5259|Brooklyn|555-0142|dana@|@/);
    }
    expect(JSON.stringify(runById(db, run.id).details)).not.toMatch(/555-0142|dana@example/);
  });
});

describe("after the accept", () => {
  async function accepted() {
    const db = world();
    const run = await newRun(db);
    await approve(db, run.id);
    await recordVendorYes(db as never, { ownerUserId: OWNER, attemptId: String(attemptsOf(db, run.id)[0]!.id), timeText: "2:30pm", rawText: "YES 2:30pm", now: T0 });
    return { db, run };
  }

  it("DONE asks the resident; YES completes the service; the run is completed", async () => {
    const { db, run } = await accepted();
    const attempt = attemptsOf(db, run.id)[0]!;
    expect(await recordVendorDone(db as never, { ownerUserId: OWNER, attemptId: String(attempt.id), now: T0 })).toBe("marked_done");
    expect(runById(db, run.id)).toMatchObject({ status: "accepted", completion_state: "awaiting_resident" });
    expect(sent.resident.at(-1)!.text).toBe("Your service is done. Is it fixed? Reply YES or NO");
    expect(rows(db, "portal_work_order_records")[0]!.row_data).toMatchObject({ automationStatus: "vendor_marked_done" });
    expect(await recordVendorDone(db as never, { ownerUserId: OWNER, attemptId: String(attempt.id), now: T0 })).toBe("already");

    const stranger = await handleResidentDispatchReply(db as never, { ownerUserId: OWNER, residentEmail: "someone@else.com", body: "YES", now: T0 });
    expect(stranger).toEqual({ handled: false });
    const fixed = await handleResidentDispatchReply(db as never, { ownerUserId: OWNER, residentEmail: "dana@example.com", body: "YES", now: T0 });
    expect(fixed).toMatchObject({ handled: true });
    expect(runById(db, run.id)).toMatchObject({ status: "completed", completion_state: "confirmed" });
    expect(rows(db, "portal_work_order_records")[0]!.row_data).toMatchObject({ bucket: "completed", status: "Completed" });
  });

  it("a NO reopens the service for the vendor and alerts the manager", async () => {
    const { db, run } = await accepted();
    await recordVendorDone(db as never, { ownerUserId: OWNER, attemptId: String(attemptsOf(db, run.id)[0]!.id), now: T0 });
    sent.vendor.length = 0;
    sent.team.length = 0;
    const answer = await handleResidentDispatchReply(db as never, { ownerUserId: OWNER, residentEmail: "dana@example.com", body: "no", now: T0 });
    expect(answer).toMatchObject({ handled: true });
    expect(runById(db, run.id)).toMatchObject({ status: "accepted", completion_state: "reopened" });
    expect(rows(db, "portal_work_order_records")[0]!.row_data).toMatchObject({ bucket: "scheduled" });
    expect(sent.team.at(-1)!.text).toBe("Resident says #1 at 5259 Brooklyn Ave NE is NOT fixed. Service reopened");
    expect(sent.vendor.at(-1)!.text).toMatch(/not fixed yet/);
    // The vendor can finish again.
    expect(await recordVendorDone(db as never, { ownerUserId: OWNER, attemptId: String(attemptsOf(db, run.id)[0]!.id), now: T0 })).toBe("marked_done");
  });

  it("only the accepted vendor can say DONE", async () => {
    const { db, run } = await accepted();
    const other = attemptsOf(db, run.id)[1]!;
    expect(await recordVendorDone(db as never, { ownerUserId: OWNER, attemptId: String(other.id), now: T0 })).toBe("not_accepted_vendor");
    expect(await recordVendorDone(db as never, { ownerUserId: OWNER2, attemptId: String(attemptsOf(db, run.id)[0]!.id), now: T0 })).toBe("not_found");
  });
});

describe("the scheduler", () => {
  it("resends an unanswered approval, then escalates to the next teammate", async () => {
    sent.teammates.push("teammate-1");
    const db = world();
    const run = await newRun(db);
    expect(sent.team.map((t) => t.memberUserId)).toEqual([OWNER]);
    const reminded = await sweepVendorDispatch(db as never, new Date(T0.getTime() + 6 * 60_000), { turnovers: false });
    expect(reminded).toMatchObject({ reminded: 1, escalated: 0 });
    expect(sent.team.map((t) => t.memberUserId)).toEqual([OWNER, OWNER]);
    const escalated = await sweepVendorDispatch(db as never, new Date(T0.getTime() + 11 * 60_000), { turnovers: false });
    expect(escalated).toMatchObject({ escalated: 1 });
    expect(sent.team.at(-1)).toMatchObject({ memberUserId: "teammate-1" });
    expect(runById(db, run.id).approval_notified_user_ids).toEqual([OWNER, "teammate-1"]);
    // Neither fires twice.
    await sweepVendorDispatch(db as never, new Date(T0.getTime() + 20 * 60_000), { turnovers: false });
    expect(sent.team).toHaveLength(3);
    expect(sent.vendor).toHaveLength(0);
  });

  it("times out due offers on its own and expires an approval nobody answered in three days", async () => {
    const db = world();
    const run = await newRun(db);
    await approve(db, run.id);
    const summary = await sweepVendorDispatch(db as never, new Date(T0.getTime() + 11 * 60_000), { turnovers: false });
    expect(summary.timedOut).toBe(1);
    expect(attemptsOf(db, run.id).map((a) => a.status)).toEqual(["timed_out", "offered", "queued"]);

    const stale = await newRun(db, { sourceId: "wo-stale" });
    const swept = await sweepVendorDispatch(db as never, new Date(T0.getTime() + 73 * 3_600_000), { turnovers: false });
    expect(swept.expired).toBe(1);
    expect(runById(db, stale.id).status).toBe("canceled");
  });

  it("a vendor who declines in the portal moves the chain on", async () => {
    const db = world();
    const run = await newRun(db);
    await approve(db, run.id);
    rows(db, "work_order_vendor_offers")[0]!.status = "declined";
    const summary = await sweepVendorDispatch(db as never, new Date(T0.getTime() + 60_000), { turnovers: false });
    expect(summary.portalDeclines).toBe(1);
    expect(attemptsOf(db, run.id).map((a) => a.status)).toEqual(["declined", "offered", "queued"]);
  });
});

describe("when a resident files a service", () => {
  const prime = (db: Db) => {
    db.__tables.profiles!.push({ id: "res-1", email: "dana@example.com", phone: "+12065550142", phone_verified_at: "2026-09-01T00:00:00Z" });
    db.__tables.portal_lease_pipeline_records = [{ manager_user_id: OWNER, resident_email: "dana@example.com", row_data: { status: "Signed", propertyId: PROP } }];
  };

  it("opens a run for a workspace with a rule, and leaves a workspace without one on the legacy path", async () => {
    const db = world();
    prime(db);
    expect(await maybeCreateRuleRunForWorkOrder(db as never, "wo-1")).toBe("created");
    expect(rows(db, "vendor_dispatch_runs")[0]).toMatchObject({ trade: "locksmith", issue: "lockout", urgency: "emergency", status: "awaiting_approval", source_id: "wo-1" });
    expect(await maybeCreateRuleRunForWorkOrder(db as never, "wo-1")).toBe("existing");

    const bare = world({ rules: [] });
    prime(bare);
    expect(await maybeCreateRuleRunForWorkOrder(bare as never, "wo-1")).toBe("no_rule");
    expect(rows(bare, "vendor_dispatch_runs")).toHaveLength(0);
  });

  it("refuses a lockout when the texter is not on the house roster, and says so", async () => {
    const db = world();
    db.__tables.profiles!.push({ id: "res-1", email: "dana@example.com", phone: "+12065550142", phone_verified_at: null });
    db.__tables.portal_lease_pipeline_records = [{ manager_user_id: OWNER, resident_email: "dana@example.com", row_data: { status: "Signed", propertyId: PROP } }];
    expect(await maybeCreateRuleRunForWorkOrder(db as never, "wo-1")).toBe("refused");
    expect(rows(db, "vendor_dispatch_runs")).toHaveLength(0);
    expect(rows(db, "action_events").map((e) => e.event_type)).toContain("refused_unverified_lockout");

    const wrongHouse = world();
    wrongHouse.__tables.profiles!.push({ id: "res-1", email: "dana@example.com", phone: "+12065550142", phone_verified_at: "2026-09-01T00:00:00Z" });
    wrongHouse.__tables.portal_lease_pipeline_records = [{ manager_user_id: OWNER, resident_email: "dana@example.com", row_data: { status: "Signed", propertyId: "prop-9" } }];
    expect(await maybeCreateRuleRunForWorkOrder(wrongHouse as never, "wo-1")).toBe("refused");
  });

  it("never opens a run for a gas smell", async () => {
    const db = world();
    prime(db);
    rows(db, "portal_work_order_records")[0]!.row_data = workOrderRow({ title: "Gas smell", description: "I smell gas in the hallway", category: "plumbing" });
    expect(await maybeCreateRuleRunForWorkOrder(db as never, "wo-1")).toBe("skipped");
  });
});

describe("assistant tools", () => {
  const toolCtx = (db: Db, userId = OWNER) =>
    ({ landlordId: OWNER, userId, email: "owner@example.com", roles: ["manager"], isAdmin: false, db }) as never;

  it("lists what is waiting, approves by number through the write gate, and refuses a second approval", async () => {
    const db = world();
    const run = await newRun(db);
    const listed = (await listVendorDispatchesTool.handler(toolCtx(db), {})) as { count: number; runs: Array<{ handle: number; vendors: string[]; status: string }> };
    expect(listed.count).toBe(1);
    expect(listed.runs[0]).toMatchObject({ handle: 1, status: "awaiting_approval", vendors: ["Sam Locksmith", "Lee Locks", "Kim Keys"] });

    const preview = await approveVendorDispatchTool.preview(toolCtx(db), { handle: 1 });
    expect(preview.fields.find((field) => field.label === "What the vendor reads")?.value).toBe(run.offer_text);
    expect(sent.vendor).toHaveLength(0); // a preview texts nobody

    const done = await approveVendorDispatchTool.handler(toolCtx(db), { handle: 1 });
    expect(done).toEqual({ reply: "Approved dispatch #1. The vendor is being texted now." });
    expect(sent.vendor.map((v) => v.vendorDirectoryId)).toEqual(["v1"]);
    await expect(approveVendorDispatchTool.handler(toolCtx(db), { handle: 1 })).rejects.toThrow(/no longer waiting/);
    await expect(approveVendorDispatchTool.preview(toolCtx(db), { handle: 99 })).rejects.toThrow(/No dispatch with that number/);
  });

  it("will not approve a stranger's run or one in another workspace", async () => {
    const db = world();
    await newRun(db);
    await expect(approveVendorDispatchTool.preview(toolCtx(db, "stranger"), { handle: 1 })).rejects.toThrow(/do not have access/);
    await expect(approveVendorDispatchTool.preview({ ...(toolCtx(db) as object), workspace: { id: "ws-other" } } as never, { handle: 1 })).rejects.toThrow(/another workspace/);
    expect(rows(db, "vendor_dispatch_runs")[0]!.status).toBe("awaiting_approval");
  });

  it("dispatch_vendor sends a role to an existing service; the confirm is the approval", async () => {
    const db = world();
    const preview = await dispatchVendorTool.preview(toolCtx(db), { workOrderId: "wo-1" });
    expect(preview.fields.find((field) => field.label === "Vendors")?.value).toBe("Sam Locksmith, then Lee Locks, then Kim Keys");
    expect(preview.fields.find((field) => field.label === "Vendors see")?.value).toBe("the area (Seattle) until they accept");
    expect(rows(db, "vendor_dispatch_runs")).toHaveLength(0);

    const result = await dispatchVendorTool.handler(toolCtx(db), { workOrderId: "wo-1" });
    expect(result).toEqual({ reply: "Dispatch #1 started. The first vendor is being texted now." });
    expect(rows(db, "vendor_dispatch_runs")[0]).toMatchObject({ status: "offering", approved_by: OWNER, source_id: "wo-1" });
    expect(sent.vendor.map((v) => v.vendorDirectoryId)).toEqual(["v1"]);
    expect(sent.team).toHaveLength(0); // no second "approve?" text: the manager's YES already was the approval

    await expect(dispatchVendorTool.preview(toolCtx(db, OWNER2) as never, { workOrderId: "nope" })).rejects.toThrow(/No service with this id/);
    await expect(dispatchVendorTool.preview({ ...(toolCtx(db) as object), landlordId: OWNER2 } as never, { workOrderId: "wo-1" })).rejects.toThrow(/No service with this id/);
  });
});
