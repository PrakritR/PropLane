/**
 * A PropLane Service workspace proposes dispatch by default (the manager's Y texts the roster); a self-serve workspace stays off
 * but is told once that "Reply DISPATCH" texts their vendors; DISPATCH opens that run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeOwnerDb, type OwnerFakeDb } from "../helpers/owner-fake-db";

const s = vi.hoisted(() => ({
  runCalls: [] as Array<{ id: string; requireRule: boolean | undefined; restart?: boolean | undefined }>,
  runOutcome: "created" as string,
  queue: [] as string[],
  notices: [] as Array<Record<string, unknown>>,
  legacyUsed: 0,
  /** Which workspace a property belongs to (the DISPATCH scope check reads this). */
  workspaceByProperty: {} as Record<string, string>,
}));

vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: async (_db: unknown, a: Record<string, unknown>) => { s.notices.push(a); } }));
vi.mock("@/lib/vendor-dispatch/triggers.server", () => ({
  maybeCreateRuleRunForWorkOrder: async (_db: unknown, id: string, opts?: { requireRule?: boolean; restart?: boolean }) => {
    s.runCalls.push({ id, requireRule: opts?.requireRule, ...(opts?.restart === undefined ? {} : { restart: opts.restart }) });
    return s.queue.length ? s.queue.shift()! : s.runOutcome;
  },
  resolveOwnerAndWorkspace: async (_db: unknown, input: { ownerUserId?: string; propertyId?: string | null }) => ({
    ownerUserId: input.ownerUserId ?? "mgr",
    workspaceId: s.workspaceByProperty[String(input.propertyId ?? "")] ?? "ws-1",
  }),
}));
vi.mock("@/lib/tools/domains/work-orders", () => ({
  loadVendorsForMatching: async () => { s.legacyUsed += 1; return []; },
  loadManagerWorkOrders: async () => [],
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: () => undefined }));
vi.mock("@/lib/agent/vendor-agent.server", () => ({ ensureVendorAgentSession: async () => undefined }));
vi.mock("@/lib/google-calendar/sync.server", () => ({ syncWorkOrderToGoogleCalendar: async (_d: unknown, _o: unknown, row: unknown) => row }));

import { prepareDispatch } from "@/lib/work-order-dispatch.server";
import { handleManagerDispatchReply } from "@/lib/vendor-dispatch/inbound.server";
import { isDispatchKeyword, resolveDispatchSettings } from "@/lib/vendor-dispatch/service-default.server";

const row = (over: Record<string, unknown> = {}) => ({
  id: "wo-1", title: "Leaking faucet", category: "plumbing", bucket: "open", propertyId: "p-1", propertyName: "Maple Court", ...over,
});
function world(opts: { service: boolean; saved?: unknown; wo?: Record<string, unknown> } = { service: true }): OwnerFakeDb {
  return fakeOwnerDb({
    portal_work_order_records: [{ id: "wo-1", manager_user_id: "mgr", updated_at: new Date().toISOString(), row_data: row(opts.wo) }],
    portal_workspaces: [{ id: "ws-1", is_service: opts.service }],
    manager_automation_settings: opts.saved === undefined ? [] : [{ manager_user_id: "mgr", vendor_dispatch: opts.saved }],
    audit_log: [],
  }, { uniques: { audit_log: [["dedupe_key"]] } });
}

beforeEach(() => { s.queue.length = 0; s.runCalls.length = 0; s.runOutcome = "created"; s.notices.length = 0; s.legacyUsed = 0; s.workspaceByProperty = {}; });

describe("effective dispatch settings", () => {
  it("a service workspace with nothing saved proposes (mode approve); an explicit off stays off", async () => {
    expect((await resolveDispatchSettings(world({ service: true }).db, "mgr", "ws-1"))).toMatchObject({ serviceDefault: true, settings: { mode: "approve" } });
    expect((await resolveDispatchSettings(world({ service: true, saved: { mode: "off" } }).db, "mgr", "ws-1"))).toMatchObject({ serviceDefault: false, explicit: true, settings: { mode: "off" } });
    expect((await resolveDispatchSettings(world({ service: true, saved: { mode: "auto" } }).db, "mgr", "ws-1")).settings.mode).toBe("auto");
  });
  it("a self-serve workspace stays off", async () => {
    expect(await resolveDispatchSettings(world({ service: false }).db, "mgr", "ws-1")).toMatchObject({ serviceDefault: false, settings: { mode: "off" } });
  });
});

describe("prepareDispatch", () => {
  it("service workspace: the rule path first, then a rule-less run (roster chain) that waits for the manager's Y; no legacy proposal, no notice", async () => {
    s.queue.push("no_rule", "created");
    await prepareDispatch(world({ service: true }).db as never, "wo-1");
    expect(s.runCalls).toEqual([{ id: "wo-1", requireRule: undefined }, { id: "wo-1", requireRule: false }]);
    expect(s.legacyUsed).toBe(0);
    expect(s.notices).toHaveLength(0);
  });

  it("service workspace with a matching rule keeps the rule's run and does not ask twice", async () => {
    s.queue.push("created");
    await prepareDispatch(world({ service: true }).db as never, "wo-1");
    expect(s.runCalls).toHaveLength(1);
  });

  it("service workspace that SAVED off stays off: no run, and the manager is told they can reply DISPATCH", async () => {
    s.queue.push("no_rule");
    await prepareDispatch(world({ service: true, saved: { mode: "off" } }).db as never, "wo-1");
    expect(s.runCalls).toHaveLength(1);
    expect(s.notices).toHaveLength(1);
    expect(String(s.notices[0]!.text)).toContain("Reply DISPATCH to text your vendors");
  });

  it("self-serve with dispatch off: no run, one notice saying Reply DISPATCH, and a replay does not tell them again", async () => {
    s.queue.push("no_rule", "no_rule");
    const f = world({ service: false });
    await prepareDispatch(f.db as never, "wo-1");
    await prepareDispatch(f.db as never, "wo-1");
    expect(s.runCalls.every((c) => c.requireRule === undefined)).toBe(true);
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toMatchObject({ landlordId: "mgr", threadType: "dispatch_proposal", workspaceId: "ws-1" });
    expect(String(s.notices[0]!.subject)).toContain("Leaking faucet");
    expect(s.legacyUsed).toBe(0);
  });

  it("self-serve that turned dispatch on keeps the legacy proposal and sends no DISPATCH notice", async () => {
    s.queue.push("no_rule");
    await prepareDispatch(world({ service: false, saved: { mode: "approve" } }).db as never, "wo-1");
    expect(s.legacyUsed).toBe(1);
    expect(s.notices.every((n) => !String(n.text).includes("Reply DISPATCH"))).toBe(true);
  });

  it("a repair the manager filed themselves or that already has a vendor says nothing", async () => {
    await prepareDispatch(world({ service: false, wo: { managerInitiated: true } }).db as never, "wo-1");
    await prepareDispatch(world({ service: false, wo: { vendorId: "v-1" } }).db as never, "wo-1");
    expect(s.notices).toHaveLength(0);
    expect(s.runCalls).toHaveLength(0);
  });
});

describe("DISPATCH keyword", () => {
  it("is recognised on its own only", () => {
    expect(isDispatchKeyword("DISPATCH")).toBe(true);
    expect(isDispatchKeyword(" dispatch. ")).toBe(true);
    expect(isDispatchKeyword("dispatch the plumber")).toBe(false);
    expect(isDispatchKeyword("Y")).toBe(false);
  });

  it("opens a run for the newest unassigned repair and asks for Y", async () => {
    s.runOutcome = "created";
    const r = await handleManagerDispatchReply(world({ service: false }).db as never, { ownerUserId: "mgr", workspaceId: "ws-1", actorUserId: "mgr", body: "DISPATCH" });
    expect(r).toMatchObject({ handled: true });
    expect((r as { reply: string }).reply).toMatch(/Reply Y/);
    // The manager asked for it themselves, so a finished run for the repair does not stand in the way.
    expect(s.runCalls).toEqual([{ id: "wo-1", requireRule: false, restart: true }]);
  });

  it("reports an existing run, and no vendors, in plain words", async () => {
    s.runOutcome = "existing";
    expect(((await handleManagerDispatchReply(world().db as never, { ownerUserId: "mgr", workspaceId: "ws-1", actorUserId: "mgr", body: "dispatch" })) as { reply: string }).reply).toMatch(/already with dispatch/);
    s.runOutcome = "no_vendors";
    expect(((await handleManagerDispatchReply(world().db as never, { ownerUserId: "mgr", workspaceId: "ws-1", actorUserId: "mgr", body: "dispatch" })) as { reply: string }).reply).toMatch(/None of your vendors/);
  });

  it("is not ours when there is no open unassigned repair, or the repair is already assigned", async () => {
    const assigned = world({ service: false, wo: { vendorId: "v-1" } });
    expect(await handleManagerDispatchReply(assigned.db as never, { ownerUserId: "mgr", workspaceId: "ws-1", actorUserId: "mgr", body: "DISPATCH" })).toEqual({ handled: false });
    const other = fakeOwnerDb({ portal_work_order_records: [] });
    expect(await handleManagerDispatchReply(other.db as never, { ownerUserId: "mgr", workspaceId: "ws-1", actorUserId: "mgr", body: "DISPATCH" })).toEqual({ handled: false });
    expect(s.runCalls).toEqual([]);
  });

  it("only dispatches a repair of the workspace whose number was texted", async () => {
    // One owner, two workspaces: DISPATCH to this number must not open a run against the other workspace's
    // repair, which would land the work and its bill on the wrong workspace's ledger and calendar.
    s.workspaceByProperty = { "p-1": "ws-2" };
    const f = world({ service: false });
    expect(await handleManagerDispatchReply(f.db as never, { ownerUserId: "mgr", workspaceId: "ws-1", actorUserId: "mgr", body: "DISPATCH" })).toEqual({ handled: false });
    expect(s.runCalls).toEqual([]);
    // The same repair on the texted number's own workspace is dispatched as before.
    s.workspaceByProperty = { "p-1": "ws-1" };
    expect(await handleManagerDispatchReply(world({ service: false }).db as never, { ownerUserId: "mgr", workspaceId: "ws-1", actorUserId: "mgr", body: "DISPATCH" })).toMatchObject({ handled: true });
    expect(s.runCalls).toEqual([{ id: "wo-1", requireRule: false, restart: true }]);
  });

  it("only reads the work number owner's repairs", async () => {
    const f = world({ service: false });
    expect(await handleManagerDispatchReply(f.db as never, { ownerUserId: "someone-else", workspaceId: "ws-1", actorUserId: "x", body: "DISPATCH" })).toEqual({ handled: false });
  });
});
