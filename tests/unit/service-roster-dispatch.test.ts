import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatchDb } from "./support/dispatch-memory-db";
/**
 * PropLane Service roster x the dispatch engine: a job in an is_service workspace is offered to the workspace's own
 * vendors and then the service roster (trade, not paused, not removed, not STOPped); a workspace that is not a service
 * workspace never sees the roster; the approver is the service manager; a roster vendor's YES arrives on the PropLane
 * line (the service owner's number) and assigns the job in the client's workspace.
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


import { createDispatchRun, approveDispatchRun } from "@/lib/vendor-dispatch/runs.server";
import { workspaceHasMatchingRule } from "@/lib/vendor-dispatch/match.server";
import { handleManagerDispatchReply, handleVendorDispatchReply } from "@/lib/vendor-dispatch/inbound.server";
import { canActorApprove, resolveApprovers } from "@/lib/vendor-dispatch/engine.server";
import { serviceRosterVendorsForTrade } from "@/lib/service/service-vendors.server";

const SO = "svc-owner";
const CLIENT = "client-ambika";
const CLIENT2 = "client-vinod";
const OTHER = "plain-owner";
const WS_A = "ws-ambika";
const WS_V = "ws-vinod";
const WS_P = "ws-plain";
const WS_SO = "ws-service-owner";
const PROP_A = "prop-a";
const PROP_V = "prop-v";
const PROP_P = "prop-p";
const T0 = new Date("2026-10-19T20:00:00Z");

type Row = Record<string, unknown>;

function rosterVendor(id: string, name: string, phone: string, trades: string[], extra: Row = {}): Row {
  return {
    id,
    manager_user_id: SO,
    vendor_user_id: null,
    row_data: { id, name, trade: "", phone, email: "", notes: "", active: true, serviceRoster: true, dispatchTrades: trades, serviceArea: "", ...extra },
  };
}
function ownVendor(id: string, name: string, phone: string, owner: string, trade = "Plumbing"): Row {
  return { id, manager_user_id: owner, vendor_user_id: null, row_data: { id, name, trade, trades: [trade], phone, email: "", notes: "", active: true } };
}

function world(extra: Record<string, Row[]> = {}) {
  return createDispatchDb({
    platform_service_settings: [{ singleton: true, owner_user_id: SO }],
    portal_workspaces: [
      { id: WS_A, name: "1. Ambika", owner_user_id: CLIENT, is_default: true, is_service: true },
      { id: WS_V, name: "2. Vinod", owner_user_id: CLIENT2, is_default: true, is_service: true },
      { id: WS_P, name: "Plain", owner_user_id: OTHER, is_default: true, is_service: false },
      { id: WS_SO, name: "Service owner", owner_user_id: SO, is_default: true, is_service: false },
    ],
    manager_property_records: [
      { id: PROP_A, manager_user_id: CLIENT, workspace_id: WS_A, property_data: { address: "5259 Brooklyn Ave NE, Seattle, WA 98105", title: "5259 Brooklyn" } },
      { id: PROP_V, manager_user_id: CLIENT2, workspace_id: WS_V, property_data: { address: "4709A 8th Ave NE, Seattle, WA 98105", title: "4709A 8th" } },
      { id: PROP_P, manager_user_id: OTHER, workspace_id: WS_P, property_data: { address: "1 Plain St, Seattle, WA 98105", title: "Plain" } },
    ],
    manager_vendor_records: [
      rosterVendor("svcv-pat", "Pat Plumber", "+12065550201", ["plumber"]),
      rosterVendor("svcv-lou", "Lou Locks", "+12065550202", ["locksmith"]),
      rosterVendor("svcv-paused", "Paused Plumber", "+12065550203", ["plumber"], { dispatchAvailable: false }),
      rosterVendor("svcv-gone", "Removed Plumber", "+12065550204", ["plumber"], { active: false, rosterRemovedAt: "2026-10-01T00:00:00Z" }),
      rosterVendor("svcv-stop", "Stopped Plumber", "+12065550205", ["plumber"]),
      ownVendor("c-own", "Client Plumber", "+12065550301", CLIENT),
      // The service owner's own, non-roster vendor must never be offered to a client's workspace.
      ownVendor("so-own", "Owner Private Plumber", "+12065550302", SO),
      ownVendor("p-own", "Plain Plumber", "+12065550303", OTHER),
    ],
    portal_work_order_records: [
      { id: "wo-a", manager_user_id: CLIENT, vendor_user_id: null, row_data: { id: "wo-a", reference: "WO-A", propertyName: "5259 Brooklyn", unit: "R3", title: "Leak", priority: "Urgent", status: "Submitted", bucket: "open", description: "Kitchen leak", scheduled: "—", cost: "—", propertyAddress: "5259 Brooklyn Ave NE, Seattle, WA 98105", propertyId: PROP_A, managerUserId: CLIENT, residentName: "Dana Lee", residentEmail: "dana@example.com", category: "plumbing" } },
      { id: "wo-v", manager_user_id: CLIENT2, vendor_user_id: null, row_data: { id: "wo-v", reference: "WO-V", propertyName: "4709A 8th", unit: "R1", title: "Leak", priority: "Urgent", status: "Submitted", bucket: "open", description: "Leak", scheduled: "—", cost: "—", propertyAddress: "4709A 8th Ave NE, Seattle, WA 98105", propertyId: PROP_V, managerUserId: CLIENT2, residentName: "Vic", residentEmail: "vic@example.com", category: "plumbing" } },
    ],
    profiles: [{ id: SO, email: "so@example.com", full_name: "Prakrit" }, { id: CLIENT, email: "a@example.com", full_name: "Ambika" }],
    ...extra,
  });
}
type Db = ReturnType<typeof world>;

async function newRun(db: Db, over: Partial<Parameters<typeof createDispatchRun>[1]> = {}) {
  const created = await createDispatchRun(db as never, {
    workspaceId: WS_A,
    ownerUserId: CLIENT,
    sourceType: "work_order",
    sourceId: "wo-a",
    trade: "plumber",
    issue: "leak",
    urgency: "urgent",
    propertyId: PROP_A,
    residentEmail: "dana@example.com",
    createdBy: null,
    at: T0,
    details: { what: "Leak", area: "Wedgwood", houseLabel: "5259 Brooklyn", address: "5259 Brooklyn Ave NE, Seattle, WA 98105" },
    ...over,
  });
  return created;
}
const attemptVendors = (db: Db, runId: string) =>
  (db.__tables.vendor_dispatch_attempts ?? []).filter((a) => a.run_id === runId).sort((a, b) => Number(a.position) - Number(b.position)).map((a) => String(a.vendor_directory_id));

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

describe("who a service workspace's job is offered to", () => {
  it("the workspace's own vendors first, then the roster vendors of the trade; never paused, removed, other-trade or the owner's private vendors", async () => {
    const db = world();
    const created = await newRun(db);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(attemptVendors(db, created.run.id)).toEqual(["c-own", "svcv-pat", "svcv-stop"]);
  });

  it("a different trade picks the roster vendors of that trade only", async () => {
    const db = world();
    const created = await createDispatchRun(db as never, {
      workspaceId: WS_A, ownerUserId: CLIENT, sourceType: "manual", sourceId: "lock-1", trade: "locksmith", issue: "lockout", urgency: "urgent",
      propertyId: PROP_A, createdBy: null, at: T0, details: { what: "Lockout", area: "Wedgwood", houseLabel: "5259 Brooklyn" },
    });
    expect(created.ok).toBe(true);
    if (created.ok) expect(attemptVendors(db, created.run.id)).toEqual(["svcv-lou"]);
  });

  it("a number that texted STOP is not in the chain", async () => {
    sent.optedOut.add("+12065550205");
    const db = world();
    const created = await newRun(db);
    expect(created.ok && attemptVendors(db, created.run.id)).toEqual(["c-own", "svcv-pat"]);
  });

  it("a workspace that is NOT a service workspace never sees the roster", async () => {
    const db = world();
    const created = await newRun(db, { workspaceId: WS_P, ownerUserId: OTHER, sourceId: "wo-p", propertyId: PROP_P });
    expect(created.ok && attemptVendors(db, created.run.id)).toEqual(["p-own"]);
    // And with no vendor of its own there is nobody to ask: the roster does not fill in.
    const none = await createDispatchRun(db as never, {
      workspaceId: WS_P, ownerUserId: OTHER, sourceType: "manual", sourceId: "lock-p", trade: "locksmith", urgency: "urgent",
      propertyId: PROP_P, createdBy: null, at: T0, details: { what: "Lockout", area: "x", houseLabel: "Plain" },
    });
    expect(none).toMatchObject({ ok: false, reason: "no_vendors" });
  });

  it("a service workspace needs no rule of its own while the roster has someone for the trade", async () => {
    const db = world();
    const input = { ownerUserId: CLIENT, workspaceId: WS_A, urgency: "urgent" as const };
    expect(await workspaceHasMatchingRule(db as never, { ...input, trade: "plumber" })).toBe(true);
    expect(await workspaceHasMatchingRule(db as never, { ...input, trade: "electrician" })).toBe(false);
    expect(await workspaceHasMatchingRule(db as never, { ownerUserId: OTHER, workspaceId: WS_P, urgency: "urgent", trade: "locksmith" })).toBe(false);
  });

  it("the paycore hook returns the reachable roster for a service workspace and [] for any other", async () => {
    const db = world();
    expect((await serviceRosterVendorsForTrade(db as never, { workspaceId: WS_A, trade: "plumber" })).map((v) => v.vendorDirectoryId)).toEqual(["svcv-pat", "svcv-stop"]);
    expect(await serviceRosterVendorsForTrade(db as never, { workspaceId: WS_P, trade: "plumber" })).toEqual([]);
  });
});

describe("approval is the service manager's", () => {
  it("asks the service owner, not the view-only client, and the client cannot answer", async () => {
    const db = world();
    const created = await newRun(db);
    expect(created.ok).toBe(true);
    expect(sent.team.map((t) => t.memberUserId)).toEqual([SO]);
    const run = created.ok ? created.run : null;
    expect(await resolveApprovers(db as never, run!)).toEqual([SO]);
    expect(await canActorApprove(db as never, run!, SO)).toBe(true);
    expect(await canActorApprove(db as never, run!, CLIENT)).toBe(false);
  });

  it("job numbers come from one counter across the service, so 'Y 1' names exactly one job", async () => {
    const db = world();
    const a = await newRun(db);
    const v = await newRun(db, { workspaceId: WS_V, ownerUserId: CLIENT2, sourceId: "wo-v", propertyId: PROP_V });
    expect(a.ok && v.ok).toBe(true);
    if (a.ok && v.ok) expect(new Set([a.run.handle, v.run.handle]).size).toBe(2);
  });

  it("the service manager answers across every service workspace; a bare Y with two waiting asks which", async () => {
    const db = world();
    const a = await newRun(db);
    const v = await newRun(db, { workspaceId: WS_V, ownerUserId: CLIENT2, sourceId: "wo-v", propertyId: PROP_V });
    if (!a.ok || !v.ok) throw new Error("setup");
    const scopes = [{ ownerUserId: CLIENT, workspaceId: WS_A }, { ownerUserId: CLIENT2, workspaceId: WS_V }];
    const ask = await handleManagerDispatchReply(db as never, { ownerUserId: SO, workspaceId: WS_SO, actorUserId: SO, body: "Y", scopes, assistantProposalOpen: async () => false });
    expect(ask).toMatchObject({ handled: true });
    expect((ask as { reply?: string }).reply).toMatch(/^Which one\? Reply Y \d+ or Y \d+$/);
    const approved = await handleManagerDispatchReply(db as never, { ownerUserId: SO, workspaceId: WS_SO, actorUserId: SO, body: `Y ${v.run.handle}`, scopes, assistantProposalOpen: async () => false });
    expect((approved as { reply?: string }).reply).toContain(`Approved #${v.run.handle}`);
    const runV = (db.__tables.vendor_dispatch_runs ?? []).find((r) => r.id === v.run.id);
    const runA = (db.__tables.vendor_dispatch_runs ?? []).find((r) => r.id === a.run.id);
    expect(runV?.status).toBe("offering");
    expect(runA?.status).toBe("awaiting_approval");
    // The client owner's own text cannot approve a service job.
    const refused = await handleManagerDispatchReply(db as never, { ownerUserId: CLIENT, workspaceId: WS_A, actorUserId: CLIENT, body: `Y ${a.run.handle}` });
    expect(refused.handled).toBe(false);
  });
});

describe("a roster vendor's YES arrives on the PropLane line and assigns the job", () => {
  it("the service owner's number finds the offer made for the client's workspace; the first YES wins", async () => {
    const db = world();
    const created = await newRun(db);
    if (!created.ok) throw new Error("setup");
    const approved = await approveDispatchRun(db as never, { runId: created.run.id, ownerUserId: CLIENT, actorUserId: SO, channel: "sms", now: T0 });
    expect(approved.ok).toBe(true);
    expect(sent.vendor.map((s) => s.vendorDirectoryId)).toContain("c-own");

    // Sequential: the workspace's own vendor was offered first; their NO (on the PropLane line) moves the job on to the roster.
    const declined = await handleVendorDispatchReply(db as never, { ownerUserId: SO, workspaceId: WS_SO, phoneE164: "+12065550301", body: "NO", messageSid: "SM1", now: T0 });
    expect(declined.handled).toBe(true);

    expect(sent.vendor.map((s) => s.vendorDirectoryId)).toContain("svcv-pat");
    const yes = await handleVendorDispatchReply(db as never, { ownerUserId: SO, workspaceId: WS_SO, phoneE164: "+12065550201", body: "YES", messageSid: "SM2", now: T0 });
    expect(yes.handled).toBe(true);
    const run = (db.__tables.vendor_dispatch_runs ?? []).find((r) => r.id === created.run.id);
    expect(run?.status).toBe("accepted");
    expect(run?.accepted_vendor_directory_id).toBe("svcv-pat");
    const wo = (db.__tables.portal_work_order_records ?? []).find((r) => r.id === "wo-a");
    expect((wo?.row_data as Row).vendorId).toBe("svcv-pat");
    expect((wo?.row_data as Row).vendorName).toBe("Pat Plumber");
  });

  it("a stranger's YES on the PropLane line matches nothing", async () => {
    const db = world();
    const created = await newRun(db);
    if (!created.ok) throw new Error("setup");
    await approveDispatchRun(db as never, { runId: created.run.id, ownerUserId: CLIENT, actorUserId: SO, channel: "sms", now: T0 });
    const stranger = await handleVendorDispatchReply(db as never, { ownerUserId: SO, workspaceId: WS_SO, phoneE164: "+12065559999", body: "YES", messageSid: "SM3", now: T0 });
    expect(stranger.handled).toBe(false);
  });

  it("another owner's number never reaches a service workspace's runs", async () => {
    const db = world();
    const created = await newRun(db);
    if (!created.ok) throw new Error("setup");
    await approveDispatchRun(db as never, { runId: created.run.id, ownerUserId: CLIENT, actorUserId: SO, channel: "sms", now: T0 });
    const wrong = await handleVendorDispatchReply(db as never, { ownerUserId: OTHER, workspaceId: WS_P, phoneE164: "+12065550301", body: "YES", messageSid: "SM4", now: T0 });
    expect(wrong.handled).toBe(false);
  });
});
