/**
 * Vendor portal dispatch offers (vendor-dispatch-1018): a vendor sees and answers
 * only offers on their own roster record, and an answer is a compare-and-set so the
 * SMS reply and the portal tap cannot both win.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row as FakeRow } from "../helpers/fake-table-db";
import { createDispatchDb } from "./support/dispatch-memory-db";

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

import { answerVendorDispatchOffer, listVendorDispatchOffers } from "@/lib/vendor-dispatch/vendor-offers.server";
import { approveDispatchRun, cancelDispatchRun, createDispatchRun } from "@/lib/vendor-dispatch/runs.server";
import type { DispatchRuleRow } from "@/lib/vendor-dispatch/types";

const OWNER = "owner-1";
const WS = "ws-1";
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

const VENDOR_USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ATT_MINE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ATT_BACKUP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ATT_OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = new Date("2026-10-18T12:00:00.000Z");

let db: FakeDb;

function seed(): Record<string, FakeRow[]> {
  return {
    manager_vendor_records: [
      { id: "v-mine", vendor_user_id: VENDOR_USER, manager_user_id: "m1" },
      { id: "v-backup", vendor_user_id: OTHER_USER, manager_user_id: "m1" },
      { id: "v-other", vendor_user_id: OTHER_USER, manager_user_id: "m1" },
    ],
    vendor_dispatch_runs: [
      {
        id: RUN,
        handle: 7,
        trade: "locksmith",
        issue: "lockout",
        urgency: "emergency",
        offer_text: "Lockout in Capitol Hill. $120.",
        pay_cents: 12000,
        status: "offering",
        accepted_vendor_directory_id: null,
        property_id: "secret-house",
        workspace_id: "ws-secret",
      },
    ],
    vendor_dispatch_attempts: [
      { id: ATT_MINE, run_id: RUN, vendor_directory_id: "v-mine", position: 0, wave: 0, status: "offered", timeout_at: "2026-10-18T12:10:00.000Z", offered_at: "2026-10-18T12:00:00.000Z" },
      { id: ATT_BACKUP, run_id: RUN, vendor_directory_id: "v-backup", position: 1, wave: 0, status: "queued", timeout_at: null, offered_at: null },
      { id: ATT_OTHER, run_id: RUN, vendor_directory_id: "v-other", position: 2, wave: 0, status: "offered", timeout_at: "2026-10-18T12:10:00.000Z", offered_at: "2026-10-18T12:00:00.000Z" },
    ],
  };
}

beforeEach(() => {
  sent.vendor.length = 0;
  sent.keys.clear();
  sent.team.length = 0;
  sent.resident.length = 0;
  sent.workOrderEvents.length = 0;
  sent.unreachable.clear();
  sent.optedOut.clear();
  sent.teammates.length = 0;
  db = createFakeDb(seed());
});

describe("listVendorDispatchOffers", () => {
  it("lists only the vendor's own live offers, with the general-area text and no house or workspace", async () => {
    const result = await listVendorDispatchOffers(db as never, VENDOR_USER, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offers).toHaveLength(1);
    const offer = result.offers[0]!;
    expect(offer).toMatchObject({ attemptId: ATT_MINE, handle: 7, tradeLabel: "Locksmith", issueLabel: "Lockout", payCents: 12000, status: "offered" });
    expect(offer.offerText).toBe("Lockout in Capitol Hill. $120.");
    expect(JSON.stringify(offer)).not.toMatch(/secret-house|ws-secret/);
  });

  it("drops an offer past its deadline and one on a run that is no longer offering", async () => {
    expect(((await listVendorDispatchOffers(db as never, VENDOR_USER, new Date("2026-10-18T12:30:00.000Z"))) as { offers: unknown[] }).offers).toEqual([]);
    db.tables.vendor_dispatch_runs![0]!.status = "canceled";
    expect(((await listVendorDispatchOffers(db as never, VENDOR_USER, NOW)) as { offers: unknown[] }).offers).toEqual([]);
  });

  it("lists nothing for a user with no roster record", async () => {
    expect(await listVendorDispatchOffers(db as never, "99999999-9999-4999-8999-999999999999", NOW)).toEqual({ ok: true, offers: [] });
  });
});

/**
 * The portal answer runs the real engine (`recordVendorYes` / `recordVendorNo`) over the
 * in-memory dispatch database, so a portal tap lands exactly where the same SMS reply would.
 * v1 is the signed-in vendor's own roster record; v2 and v3 belong to someone else.
 */
function answerWorld(mode: "sequential" | "broadcast" = "sequential") {
  const db = world({ rules: [rule({ mode, broadcast_size: 3 })] });
  for (const record of db.__tables.manager_vendor_records!) record.vendor_user_id = record.id === "v1" ? VENDOR_USER : OTHER_USER;
  return db;
}

async function offeredRun(mode: "sequential" | "broadcast" = "sequential") {
  const db = answerWorld(mode);
  const run = await newRun(db);
  await approve(db, run.id);
  const mine = attemptsOf(db, run.id).find((a) => a.vendor_directory_id === "v1")!;
  return { db, run, mine, attemptId: String(mine.id) };
}

const answer = (db: Db, attemptId: string, choice: "accept" | "decline", now: Date = T0, vendorUserId = VENDOR_USER) =>
  answerVendorDispatchOffer(db as never, { vendorUserId, attemptId, answer: choice }, now);

describe("answerVendorDispatchOffer", () => {
  it("accept claims the run, marks the attempt, and supersedes the other vendors", async () => {
    const { db, run, attemptId } = await offeredRun("broadcast");
    expect(attemptsOf(db, run.id).map((a) => a.status)).toEqual(["offered", "offered", "offered"]);
    expect(await answer(db, attemptId, "accept")).toEqual({ ok: true, status: "accepted" });
    expect(runById(db, run.id)).toMatchObject({ status: "accepted", accepted_vendor_directory_id: "v1" });
    expect(Object.fromEntries(attemptsOf(db, run.id).map((a) => [a.vendor_directory_id, a.status]))).toEqual({
      v1: "accepted",
      v2: "superseded",
      v3: "superseded",
    });
    expect(sent.team.at(-1)!.text).toContain("accepted");
  });

  it("a second answer to the same offer loses", async () => {
    const { db, attemptId } = await offeredRun("broadcast");
    await answer(db, attemptId, "accept");
    expect(await answer(db, attemptId, "accept")).toEqual({ ok: false, reason: "already_answered" });
    expect(await answer(db, attemptId, "decline")).toEqual({ ok: false, reason: "already_answered" });
  });

  it("decline marks the attempt declined and the engine offers the next vendor", async () => {
    const { db, run, attemptId } = await offeredRun();
    expect(await answer(db, attemptId, "decline")).toEqual({ ok: true, status: "declined" });
    expect(attemptsOf(db, run.id).map((a) => [a.vendor_directory_id, a.status])).toEqual([
      ["v1", "declined"],
      ["v2", "offered"],
      ["v3", "queued"],
    ]);
    expect(runById(db, run.id).status).toBe("offering");
    expect(sent.vendor.at(-1)).toMatchObject({ vendorDirectoryId: "v2" });
  });

  it("reads another vendor's attempt as not found and changes nothing", async () => {
    const { db, run, attemptId } = await offeredRun("broadcast");
    expect(await answer(db, attemptId, "accept", T0, OTHER_USER)).toEqual({ ok: false, reason: "not_found" });
    expect(runById(db, run.id).status).toBe("offering");
    expect(attemptsOf(db, run.id).every((a) => a.status === "offered")).toBe(true);
  });

  it("refuses an expired offer", async () => {
    const { db, run, attemptId } = await offeredRun();
    expect(await answer(db, attemptId, "accept", new Date(T0.getTime() + 30 * 60_000))).toEqual({ ok: false, reason: "expired" });
    expect(runById(db, run.id).status).toBe("offering");
  });

  it("does not stand when the run was canceled first", async () => {
    const { db, run, attemptId } = await offeredRun("broadcast");
    expect(await cancelDispatchRun(db as never, { ownerUserId: OWNER, actorUserId: OWNER, channel: "portal", runId: run.id, now: T0 })).toMatchObject({ ok: true });
    expect(await answer(db, attemptId, "accept")).toEqual({ ok: false, reason: "already_answered" });
    expect(runById(db, run.id).status).toBe("canceled");
    expect(runById(db, run.id).accepted_vendor_directory_id ?? null).toBeNull();
    expect(attemptsOf(db, run.id).every((a) => a.status === "canceled")).toBe(true);
  });

  it("rejects a malformed attempt id", async () => {
    const { db } = await offeredRun();
    expect(await answer(db, "nope", "accept")).toEqual({ ok: false, reason: "not_found" });
  });
});
