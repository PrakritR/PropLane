import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb, type FakeDb, type Row } from "../helpers/fake-table-db";
import { boardService } from "../helpers/vendor-line-fixtures";

const mocks = vi.hoisted(() => ({
  thread: vi.fn(),
  bind: vi.fn(),
  deliver: vi.fn(),
  owned: vi.fn(),
  request: vi.fn(),
  yes: vi.fn(),
  ai: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));
vi.mock("@/lib/portal-inbox-delivery", () => ({ deliverPortalMessageThreadSide: mocks.thread, scopeForRole: () => "vendor" }));
vi.mock("@/lib/vendor-sponsored-outbound.server", () => ({ bindVendorReplyTarget: mocks.bind }));
vi.mock("@/lib/sms/resolve-owned-work-number.server", () => ({ resolveOwnedWorkNumber: mocks.owned }));
vi.mock("@/lib/vendor-work-identity-delivery.server", () => ({
  createVendorWorkIdentityDeliveryProvider: () => ({ configured: () => true, email: vi.fn(), sms: vi.fn() }),
  deliverVendorWorkIdentity: mocks.deliver,
}));
vi.mock("@/lib/agent/vendor-number-ai.server", () => ({ runVendorNumberAiReply: mocks.ai }));
vi.mock("@/lib/vendor-dispatch/responses.server", () => ({ recordVendorYes: mocks.yes }));
vi.mock("@/lib/service-work-board.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/service-work-board.server")>()),
  requestBoardJob: mocks.request,
}));

import { ingestVendorWorkIdentitySms } from "@/lib/vendor-work-identity-inbound.server";
import { asksForWorkOnOwnNumber, parseOwnNumberJobReply } from "@/lib/one-number/vendor-jobs/own-number-intent";

const NOW = new Date("2026-10-25T18:00:00Z");
const VENDOR_NUMBER = "+14255550177";
const VENDOR_PHONE = "+12065550142";
const ALDER_LINE = "+12065550101";

const board = () => [
  boardService("wo-clean", { updated_at: "2026-10-25T10:00:00Z" }, { title: "Move-out clean", category: "cleaning", propertyAddress: "88 Pike Ave, Seattle, WA 98103", publishBudgetCents: null }),
  boardService("wo-tour", { updated_at: "2026-10-24T10:00:00Z" }, { title: "Tour host Sat 11am", category: "cleaning", propertyAddress: "12 Pine Rd, Seattle, WA 98103", publishBudgetCents: null }),
  boardService("wo-faucet", { updated_at: "2026-10-23T10:00:00Z" }, { title: "Faucet repair", category: "plumbing", propertyAddress: "1420 Alder St, Seattle, WA 98105", publishBudgetCents: null }),
];

function offered(extra: Row[] = []): Record<string, Row[]> {
  return {
    manager_vendor_records: [{ id: "mvr-1", vendor_user_id: "vendor-1" }, { id: "mvr-other", vendor_user_id: "vendor-2" }],
    vendor_dispatch_runs: [
      { id: "run-1", owner_user_id: "mgr-ambika", workspace_id: "ws-alder", trade: "plumbing", status: "offering", pay_cents: 18000, source_type: "work_order", source_id: "wo-faucet",
        details: { what: "Faucet repair at 1420 Alder St", area: "U-District", whenLabel: "Anytime", address: "1420 Alder St" } },
      { id: "run-2", owner_user_id: "mgr-ambika", workspace_id: "ws-alder", trade: "cleaning", status: "offering", pay_cents: null, source_type: "manual", source_id: null,
        details: { what: "Deep clean", area: "Wallingford" } },
      ...extra,
    ],
    vendor_dispatch_attempts: [
      { id: "att-1", run_id: "run-1", vendor_directory_id: "mvr-1", status: "offered", offered_at: "2026-10-25T16:00:00Z", timeout_at: "2026-10-26T16:00:00Z" },
      { id: "att-other", run_id: "run-2", vendor_directory_id: "mvr-other", status: "offered", offered_at: "2026-10-25T17:00:00Z", timeout_at: "2026-10-26T16:00:00Z" },
    ],
  };
}

function seed(extra: Record<string, Row[]> = {}, identity: Row = {}): FakeDb {
  return createFakeDb({
    vendor_work_identities: [{ id: "identity-1", vendor_user_id: "vendor-1", phone_number: VENDOR_NUMBER, sms_state: "ready", sms_receive_ready: true, sms_send_ready: true, attachment_state: "attached", forward_to_phone: true, ...identity }],
    profiles: [
      { id: "vendor-1", phone: "(206) 555-0142", phone_verified_at: "2026-10-01T00:00:00Z", full_name: "Vic Vendor" },
      { id: "mgr-ambika", full_name: "Ambika Rao", phone: null },
    ],
    portal_workspaces: [{ id: "ws-alder", name: "Alder Property Co" }],
    portal_work_order_records: board(),
    work_order_vendor_offers: [],
    vendor_business_profiles: [],
    vendor_work_identity_usage_events: [],
    vendor_work_number_conversations: [],
    agent_sessions: [],
    agent_messages: [],
    ...extra,
  });
}

const run = (db: FakeDb, text: string, sid: string, from = VENDOR_PHONE) =>
  ingestVendorWorkIdentitySms(db as unknown as SupabaseClient, { toPhone: VENDOR_NUMBER, fromPhone: from, text, messageSid: sid }, { now: NOW });
const lastReply = () => String(mocks.deliver.mock.calls.at(-1)![1].text);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.thread.mockResolvedValue({ threadId: "thread-1", action: "created" });
  mocks.deliver.mockResolvedValue({ ok: true, sent: true, providerMessageId: "SM1" });
  mocks.owned.mockImplementation(async (_db: unknown, phone: string) => (phone === ALDER_LINE ? { managerId: "mgr-alder", workspaceId: "ws-alder", messagingServiceSid: "MG1" } : null));
  mocks.request.mockResolvedValue({ ok: true, workOrderId: "wo-clean", choice: "bid" });
  mocks.yes.mockResolvedValue({ outcome: "accepted" });
});

describe("work ask matcher", () => {
  it.each(["any work", "Any work?", "work?", "jobs", "jobs?", "got any jobs", "Got any jobs today?", "anything open", "what's available", "hey any work available", "any jobs near me"])(
    "reads %j as a work ask",
    (text) => expect(asksForWorkOnOwnNumber(text)).toBe(true),
  );
  it.each(["Yes, Thursday 10am", "I can do the work Thursday", "what time can you work", "any work you can do on my sink, it leaks badly and the kitchen floods when we run it", "STOP", "HELP", "2", "ok"])(
    "does not read %j as a work ask",
    (text) => expect(asksForWorkOnOwnNumber(text)).toBe(false),
  );
  it("parses number replies", () => {
    expect(parseOwnNumberJobReply("2")).toEqual({ action: "see", index: 2, priceCents: null });
    expect(parseOwnNumberJobReply("see 3")).toEqual({ action: "see", index: 3, priceCents: null });
    expect(parseOwnNumberJobReply("bid 2 $120")).toEqual({ action: "bid", index: 2, priceCents: 12000 });
    expect(parseOwnNumberJobReply("BID 2 120")).toEqual({ action: "bid", index: 2, priceCents: 12000 });
    expect(parseOwnNumberJobReply("2 $95.50")).toEqual({ action: "bid", index: 2, priceCents: 9550 });
    expect(parseOwnNumberJobReply("2 120")).toBeNull();
    expect(parseOwnNumberJobReply("STOP")).toBeNull();
    expect(parseOwnNumberJobReply("Thursday works")).toBeNull();
  });
});

describe("the verified vendor asking their own number for work", () => {
  it("lists jobs sent to them first, then the open board, numbered, in the exact format", async () => {
    const db = seed(offered());
    expect(await run(db, "any work?", "SM1")).toEqual({ handled: true });
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.deliver.mock.calls[0]![1]).toMatchObject({ channel: "sms", recipient: VENDOR_PHONE, vendorUserId: "vendor-1" });
    const text = lastReply();
    expect(text).toBe("1. Faucet repair, U-District, sent to you by Ambika. 2. Move-out clean, Fremont and Wallingford, open to all. 3. Tour host Sat 11am, Fremont and Wallingford, open to all. Reply a number to see it or bid.");
    expect(text).toMatch(/^1\. Faucet repair, U-District, sent to you by Ambika\. 2\. /);
    expect(text).toMatch(/Move-out clean, [^,]+, open to all\./);
    expect(text).toMatch(/Tour host Sat 11am, [^,]+, open to all\./);
    expect(text.endsWith(" Reply a number to see it or bid.")).toBe(true);
  });

  it("dedupes a job that is both offered and public, shows it once as sent to you, and never lists another vendor's offer", async () => {
    const db = seed(offered());
    await run(db, "any work", "SM2");
    const text = lastReply();
    expect(text.match(/Faucet repair/g)).toHaveLength(1);
    expect(text).not.toMatch(/Faucet repair, [^,]+, open to all/);
    expect(text).not.toContain("Deep clean");
  });

  it("caps the list at 5 and stays within two GSM-7 segments with no street, unit or resident", async () => {
    const many = Array.from({ length: 6 }, (_, i) => boardService(`wo-x${i}`, { updated_at: `2026-10-2${i}T10:00:00Z` }, { title: `Paint touch up ${i}`, propertyAddress: `10${i} Oak St, Seattle, WA 98103`, publishBudgetCents: null }));
    const db = seed({ ...offered(), portal_work_order_records: [...board(), ...many] });
    await run(db, "got any jobs", "SM3");
    const text = lastReply();
    expect(text.match(/\d\. /g)!.length).toBeLessThanOrEqual(5);
    expect(text.length).toBeLessThanOrEqual(306);
    expect(text).toMatch(/^[\x20-\x7E]+$/);
    for (const secret of ["1420", "Alder St", "88 Pike", "4B", "SECRET RESIDENT", "ref-wo", "mgr-ambika", "att-1"]) expect(text).not.toContain(secret);
  });

  it("says nothing is open when nothing is", async () => {
    await run(seed({ portal_work_order_records: [] }), "jobs?", "SM4");
    expect(lastReply()).toBe("Nothing open near you right now.");
  });

  it("an expired offer is not listed", async () => {
    const o = offered();
    o.vendor_dispatch_attempts![0]!.timeout_at = "2026-10-25T17:00:00Z";
    await run(seed({ ...o, portal_work_order_records: [] }), "any jobs", "SM5");
    expect(lastReply()).toBe("Nothing open near you right now.");
  });
});

describe("replying a number", () => {
  it("shows a public job, then requests it through the board's own request path pinned to the vendor", async () => {
    const db = seed(offered());
    await run(db, "any work", "SM10");
    const list = lastReply();
    const publicN = Number(/(\d)\. Move-out clean/.exec(list)![1]);
    await run(db, String(publicN), "SM11");
    expect(lastReply()).toMatch(new RegExp(`^${publicN}\\. Move-out clean, `));
    expect(mocks.request).not.toHaveBeenCalled();
    await run(db, `bid ${publicN} $120`, "SM12");
    expect(mocks.request).toHaveBeenCalledWith(expect.anything(), { userId: "vendor-1", role: "vendor" }, { ref: "ref-wo-clean", choice: "bid" });
    expect(lastReply()).toMatch(/^Requested: Move-out clean/);
    expect(lastReply()).toContain("$120");
  });

  it("bids on a job sent to them through the dispatch engine's own YES, after re-checking it is theirs", async () => {
    const db = seed(offered());
    await run(db, "any work", "SM20");
    await run(db, "bid 1 $150", "SM21");
    expect(mocks.yes).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ownerUserId: "mgr-ambika", attemptId: "att-1", priceCents: 15000 }));
    expect(lastReply()).toContain("Faucet repair");
    await run(db, "bid 1", "SM22");
    expect(lastReply()).toBe("Reply BID 1 $amount to bid on it.");
  });

  it("refuses an attempt that is no longer the vendor's (roster row removed) and a number off the list", async () => {
    const db = seed(offered());
    await run(db, "any work", "SM30");
    db.tables.manager_vendor_records![0]!.vendor_user_id = "vendor-9";
    await run(db, "bid 1 $150", "SM31");
    expect(mocks.yes).not.toHaveBeenCalled();
    expect(lastReply()).toBe("That job is no longer open.");
    await run(db, "9", "SM32");
    expect(lastReply()).toMatch(/do not have a job 9/);
  });

  it("a number with no live list falls through to the relay as today", async () => {
    const db = seed({ vendor_work_number_conversations: [{ id: "c1", identity_id: "identity-1", counterpart_phone: ALDER_LINE, workspace_name: "Alder Property Co", manager_user_id: "mgr-alder", last_activity_at: new Date(NOW.getTime() - 3_600_000).toISOString() }] });
    await run(db, "2", "SM40");
    expect(mocks.deliver.mock.calls[0]![1]).toMatchObject({ recipient: ALDER_LINE, text: "2" });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("a stale list (over 45 minutes) is not resolved", async () => {
    const db = seed(offered());
    await run(db, "any work", "SM41");
    for (const m of db.tables.agent_messages!) m.created_at = new Date(NOW.getTime() - 3 * 3_600_000).toISOString();
    await run(db, "1", "SM42");
    expect(mocks.deliver.mock.calls.at(-1)![1].text).not.toMatch(/^1\. Faucet/);
  });
});

describe("everything else keeps today's behaviour", () => {
  const convo = (): Row => ({ id: "c1", identity_id: "identity-1", counterpart_phone: ALDER_LINE, workspace_name: "Alder Property Co", manager_user_id: "mgr-alder", last_activity_at: new Date(NOW.getTime() - 2 * 3_600_000).toISOString() });

  it("a non-work text from the vendor is still relayed to the manager", async () => {
    await run(seed({ vendor_work_number_conversations: [convo()] }), "Yes, Thursday 10am", "SM50");
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.deliver.mock.calls[0]![1]).toMatchObject({ recipient: ALDER_LINE, text: "Yes, Thursday 10am", idempotencyKey: "vendor-route:SM50" });
  });

  it("STOP and HELP are never intercepted", async () => {
    expect(asksForWorkOnOwnNumber("STOP")).toBe(false);
    expect(asksForWorkOnOwnNumber("HELP")).toBe(false);
    expect(parseOwnNumberJobReply("STOP")).toBeNull();
  });

  it("a client texting the vendor's number asking for work gets no job list", async () => {
    const db = seed(offered());
    await run(db, "any work?", "SM60", "+13605550000");
    expect(mocks.deliver).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ idempotencyKey: expect.stringContaining("vendor-work-list") }), expect.anything());
    expect(mocks.thread).toHaveBeenCalledTimes(1);
  });

  it("the vendor texting from an unverified phone is treated as a counterpart, not given the list", async () => {
    const db = seed(offered(), {});
    db.tables.profiles![0]!.phone_verified_at = null;
    await run(db, "any work?", "SM61");
    const keys = mocks.deliver.mock.calls.map((c) => String(c[1].idempotencyKey));
    expect(keys.some((k) => k.startsWith("vendor-work-list"))).toBe(false);
  });
});
