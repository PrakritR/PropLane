import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatchDb } from "./support/dispatch-memory-db";

/**
 * The manager's dispatch tools keep a permanent audit key only for a dispatch that really
 * started (vendor-dispatch-1018 review): a transient failure frees the key so the retry runs,
 * an existing run is described truthfully, and an exhausted run is restarted by a new request.
 */

const auditKeys = vi.hoisted(() => ({ keys: new Set<string>() }));
vi.mock("@/lib/tools/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tools/audit")>();
  return {
    ...actual,
    // The real table has a unique index on dedupe_key; the in-memory db does not, so stand it in here.
    writeAuditLog: async (_actor: unknown, args: { dedupeKey?: string | null }) => {
      if (args.dedupeKey) {
        if (auditKeys.keys.has(args.dedupeKey)) return { recorded: false, duplicate: true };
        auditKeys.keys.add(args.dedupeKey);
      }
      return { recorded: true };
    },
    updateAuditResult: async (_actor: unknown, key: string, _result: unknown, opts: { clearDedupeKey?: boolean } = {}) => {
      if (opts.clearDedupeKey) auditKeys.keys.delete(key);
    },
  };
});

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

import { createDispatchRun } from "@/lib/vendor-dispatch/runs.server";
import type { DispatchRuleRow } from "@/lib/vendor-dispatch/types";
import { approveVendorDispatchTool, dispatchVendorTool } from "@/lib/tools/domains/vendor-dispatch";

const OWNER = "owner-1";
const WS = "ws-1";
const PROP = "prop-1";
const T0 = new Date("2026-10-19T20:00:00Z");

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

beforeEach(() => {
  sent.vendor.length = 0;
  sent.keys.clear();
  auditKeys.keys.clear();
});

const toolCtx = (db: Db) =>
  ({ landlordId: OWNER, userId: OWNER, email: "owner@example.com", roles: ["manager"], isAdmin: false, db }) as never;

describe("dispatch tool retries and replies", () => {
  it("approve_vendor_dispatch frees its audit key when the approval fails, so the retry texts the vendor", async () => {
    const db = world();
    const run = await newRun(db);
    const attempts = rows(db, "vendor_dispatch_attempts").filter((a) => a.run_id === run.id);
    for (const attempt of attempts) attempt.status = "canceled"; // a transient: nobody queued
    await expect(approveVendorDispatchTool.handler(toolCtx(db), { handle: run.handle })).rejects.toThrow(/Nobody is left/);
    expect(sent.vendor).toHaveLength(0);

    for (const attempt of attempts) attempt.status = "queued"; // the transient clears
    const retry = await approveVendorDispatchTool.handler(toolCtx(db), { handle: run.handle });
    expect(retry).toEqual({ reply: `Approved dispatch #${run.handle}. The vendor is being texted now.` });
    expect(sent.vendor.map((v) => v.vendorDirectoryId)).toEqual(["v1"]);
    // A real approval keeps its key: a double confirm cannot approve twice.
    expect(await approveVendorDispatchTool.handler(toolCtx(db), { handle: run.handle })).toEqual({ reply: `Dispatch #${run.handle} was already approved.` });
  });

  it("dispatch_vendor frees its audit key when no vendor can be texted, so the retry after adding one runs", async () => {
    const db = world({ vendors: [], rules: [] });
    await expect(dispatchVendorTool.handler(toolCtx(db), { workOrderId: "wo-1" })).rejects.toThrow(/No vendor on file/);
    expect(auditKeys.keys.size).toBe(0);

    rows(db, "manager_vendor_records").push(vendor("v1", "Sam Locksmith", "(206) 555-0101"));
    const retry = await dispatchVendorTool.handler(toolCtx(db), { workOrderId: "wo-1" });
    expect(retry).toEqual({ reply: "Dispatch #1 started. The first vendor is being texted now." });
    expect(sent.vendor.map((v) => v.vendorDirectoryId)).toEqual(["v1"]);
    // Started for real: the key is kept, so a double confirm texts nobody twice.
    expect(await dispatchVendorTool.handler(toolCtx(db), { workOrderId: "wo-1" })).toEqual({ reply: "This service was already sent to a vendor." });
    expect(sent.vendor).toHaveLength(1);
  });

  it("dispatch_vendor says who accepted when the service already has an accepted run", async () => {
    const db = world();
    const run = await newRun(db);
    Object.assign(rows(db, "vendor_dispatch_runs").find((r) => r.id === run.id)!, { status: "accepted", accepted_vendor_directory_id: "v2" });
    const result = (await dispatchVendorTool.handler(toolCtx(db), { workOrderId: "wo-1" })) as { reply: string };
    expect(result.reply).toBe(`Dispatch #${run.handle} was already accepted by Lee Locks. Nothing new was sent.`);
    expect(result.reply).not.toMatch(/started|being texted/);
    expect(sent.vendor).toHaveLength(0);
    expect(auditKeys.keys.size).toBe(0);
  });

  it("dispatch_vendor starts a fresh run when the earlier one is exhausted, instead of reusing it", async () => {
    const db = world();
    const first = (await dispatchVendorTool.handler(toolCtx(db), { workOrderId: "wo-1" })) as { reply: string };
    expect(first.reply).toBe("Dispatch #1 started. The first vendor is being texted now.");
    Object.assign(rows(db, "vendor_dispatch_runs")[0]!, { status: "exhausted" });
    sent.keys.clear();

    const again = (await dispatchVendorTool.handler(toolCtx(db), { workOrderId: "wo-1" })) as { reply: string };
    expect(again.reply).toBe("Dispatch #2 started. The first vendor is being texted now.");
    expect(rows(db, "vendor_dispatch_runs").map((r) => r.status)).toEqual(["exhausted", "offering"]);
    expect(sent.vendor.map((v) => v.vendorDirectoryId)).toEqual(["v1", "v1"]);
  });

  it("an automatic trigger still gets the exhausted run back and never restarts it", async () => {
    const db = world();
    const run = await newRun(db);
    Object.assign(rows(db, "vendor_dispatch_runs")[0]!, { status: "exhausted" });
    const again = await createDispatchRun(db as never, {
      workspaceId: WS, ownerUserId: OWNER, sourceType: "work_order", sourceId: "wo-1", trade: "locksmith", issue: "lockout",
      urgency: "emergency", propertyId: PROP, at: T0, details: { what: "Lockout" },
    });
    expect(again).toMatchObject({ ok: true, created: false });
    expect(again.ok && again.run.id).toBe(run.id);
    expect(rows(db, "vendor_dispatch_runs")).toHaveLength(1);
  });

  it("dispatch_vendor never says started for a run that is merely out to a vendor", async () => {
    const db = world();
    const run = await newRun(db);
    Object.assign(rows(db, "vendor_dispatch_runs").find((r) => r.id === run.id)!, { status: "offering" });
    const result = (await dispatchVendorTool.handler(toolCtx(db), { workOrderId: "wo-1" })) as { reply: string };
    expect(result.reply).toBe(`Dispatch #${run.handle} is already out to a vendor. Nothing new was sent.`);
  });
});
