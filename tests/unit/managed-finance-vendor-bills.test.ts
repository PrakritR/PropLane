import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeOwnerDb, type FakeRow } from "../helpers/owner-fake-db";

const text = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/one-number/link-text.server", () => ({ sendWorkspacePhoneText: text }));
const email = vi.hoisted(() => vi.fn(async () => ({ status: "sent" })));
vi.mock("@/lib/manager-notice-email.server", () => ({ sendManagerNoticeEmail: email }));
vi.mock("@/lib/owner-management/alerts.server", () => ({ alertManagerOfOwnerEvent: vi.fn(async () => true) }));
vi.mock("@/lib/reports/display-context", () => ({ loadManagerReportDisplayContext: vi.fn(async () => ({ propertyLabel: () => "5259 Brooklyn" })) }));

import {
  approvalText,
  approveRoutineExpenses,
  decideOwnerExpense,
  gateAndPostManagedVendorBill,
  listPendingExpensesForOwner,
  type VendorBillInput,
} from "@/lib/managed-finance/vendor-bills.server";

const WS = "ws-1";
const OWNER = "own-1";
const bill = (over: Partial<VendorBillInput> = {}): VendorBillInput => ({
  workspaceId: WS, vendorUserId: "ven-1", amountCents: 24_000, title: "Leak repair", vendorLabel: "Mike's Plumbing", propertyId: "p1",
  sourceType: "work_order", sourceId: "wo-1", ...over,
});

function setup(threshold = 25_000, extra: Record<string, FakeRow[]> = {}) {
  const posted: Array<Record<string, unknown>> = [];
  const f = fakeOwnerDb(
    {
      managed_workspace_fee_policies: [{
        id: "pol-1", workspace_id: WS, owner_user_id: OWNER, status: "active", signed_at: "2026-01-01T00:00:00Z", owner_share_bps: 9000,
        applies_to: "rent", leasing_fee_bps: 0, min_fee_cents: 0, reserve_target_cents: 0, repair_approval_threshold_cents: threshold,
        effective_from: "2026-01-01", accepted_via: "owner_signature", terms_sha256: "h", created_at: "2026-01-01",
      }],
      manager_property_records: [{ id: "p1", workspace_id: WS }],
      portal_workspaces: [{ id: WS, owner_user_id: "mgr" }],
      profiles: [{ id: OWNER, phone: "+12065550100", phone_verified_at: "2026-01-01" }],
      owner_expenses: [],
      ...extra,
    },
    { rpc: { post_party_journal: (args) => { posted.push(args); return { created: true, journal_id: `j-${posted.length}` }; } } },
  );
  return { f, posted };
}

beforeEach(() => { text.mockClear(); email.mockClear(); });

describe("approvalText", () => {
  it("reads like the captain's example and stays plain", () => {
    expect(approvalText({ title: "Leak repair", house: "5259 Brooklyn", amountCents: 24_000, vendorLabel: "Mike's Plumbing" }))
      .toBe("Leak repair at 5259 Brooklyn, $240 from Mike's Plumbing. Approve? Y/N");
  });
  it("strips emoji and curly quotes, and shows cents when there are some", () => {
    const t = approvalText({ title: "Fix “door” \u{1F6AA}", house: "House", amountCents: 12_345, vendorLabel: "Joe’s" });
    expect(t).toBe('Fix "door" at House, $123.45 from Joe\'s. Approve? Y/N');
    expect(/^[\x20-\x7e]+$/.test(t)).toBe(true);
  });
});

describe("a bill at or under the owner's repair amount", () => {
  it("auto-approves and posts: the vendor is owed, the owner is charged", async () => {
    const { f, posted } = setup();
    const r = await gateAndPostManagedVendorBill(f.db, bill());
    expect(r).toMatchObject({ status: "posted", created: true });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ p_kind: "vendor_bill", p_key: "vendor-bill:work_order:wo-1", p_workspace: WS });
    const lines = posted[0]!.p_lines as Array<{ account: string; party_id: string; amount_cents: number }>;
    expect(lines).toEqual([
      { account: "owner_payable", party_id: `owner:${OWNER}`, workspace_id: WS, amount_cents: 24_000 },
      { account: "vendor_payable", party_id: "vendor:ven-1", workspace_id: WS, amount_cents: -24_000 },
    ]);
    expect(lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(0);
    expect(text).not.toHaveBeenCalled();
    expect(f.rows.owner_expenses![0]).toMatchObject({ status: "posted", decided_via: "auto" });
  });
  it("a second call for the same job posts nothing new (idempotent)", async () => {
    const { f, posted } = setup();
    await gateAndPostManagedVendorBill(f.db, bill());
    const again = await gateAndPostManagedVendorBill(f.db, bill());
    expect(again.status).toBe("posted");
    expect(f.rows.owner_expenses).toHaveLength(1);
    expect(posted.every((p) => p.p_key === "vendor-bill:work_order:wo-1")).toBe(true);
  });
});

describe("a bill above the owner's repair amount", () => {
  it("texts the owner Y/N and posts nothing until they answer", async () => {
    const { f, posted } = setup(10_000);
    const r = await gateAndPostManagedVendorBill(f.db, bill());
    expect(r.status).toBe("pending_owner");
    expect(posted).toHaveLength(0);
    expect(text).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(text.mock.calls[0])).toContain("Approve? Y/N");
    expect(email).toHaveBeenCalledTimes(1);
    expect(f.rows.owner_expenses![0]).toMatchObject({ status: "pending_owner", approval_phone_key: "+12065550100" });
  });
  it("asks only once however often the manager retries", async () => {
    const { f } = setup(10_000);
    await gateAndPostManagedVendorBill(f.db, bill());
    await gateAndPostManagedVendorBill(f.db, bill());
    expect(text).toHaveBeenCalledTimes(1);
  });
  it("posts after the owner approves, and refuses after they decline", async () => {
    const { f, posted } = setup(10_000);
    await gateAndPostManagedVendorBill(f.db, bill());
    const id = String(f.rows.owner_expenses![0]!.id);
    expect(await decideOwnerExpense(f.db, { expenseId: id, ownerUserId: OWNER, approve: true, via: "sms" })).toMatchObject({ status: "approved" });
    expect((await gateAndPostManagedVendorBill(f.db, bill())).status).toBe("posted");
    expect(posted).toHaveLength(1);

    const g = setup(10_000);
    await gateAndPostManagedVendorBill(g.f.db, bill({ sourceId: "wo-2" }));
    const id2 = String(g.f.rows.owner_expenses![0]!.id);
    await decideOwnerExpense(g.f.db, { expenseId: id2, ownerUserId: OWNER, approve: false, via: "portal" });
    expect((await gateAndPostManagedVendorBill(g.f.db, bill({ sourceId: "wo-2" }))).status).toBe("declined");
    expect(g.posted).toHaveLength(0);
  });
  it("gate-only mode clears an approved bill without posting", async () => {
    const { f, posted } = setup();
    const r = await gateAndPostManagedVendorBill(f.db, bill(), new Date(), { gateOnly: true });
    expect(r.status).toBe("cleared");
    expect(posted).toHaveLength(0);
  });
  it("a changed amount is a new question, not the old yes", async () => {
    const { f } = setup(10_000);
    await gateAndPostManagedVendorBill(f.db, bill());
    const id = String(f.rows.owner_expenses![0]!.id);
    await decideOwnerExpense(f.db, { expenseId: id, ownerUserId: OWNER, approve: true, via: "sms" });
    const r = await gateAndPostManagedVendorBill(f.db, bill({ amountCents: 90_000 }));
    expect(r.status).toBe("pending_owner");
    expect(text).toHaveBeenCalledTimes(2);
  });
});

describe("only the owner of record decides", () => {
  it("another person, a missing expense and a replay are all handled without a second decision", async () => {
    const { f } = setup(10_000);
    await gateAndPostManagedVendorBill(f.db, bill());
    const id = String(f.rows.owner_expenses![0]!.id);
    expect((await decideOwnerExpense(f.db, { expenseId: id, ownerUserId: "intruder", approve: true, via: "sms" })).status).toBe("not_found");
    expect((await decideOwnerExpense(f.db, { expenseId: "nope", ownerUserId: OWNER, approve: true, via: "sms" })).status).toBe("not_found");
    expect((await decideOwnerExpense(f.db, { expenseId: id, ownerUserId: OWNER, approve: false, via: "sms" })).status).toBe("declined");
    expect((await decideOwnerExpense(f.db, { expenseId: id, ownerUserId: OWNER, approve: true, via: "sms" })).status).toBe("already_decided");
    expect(f.rows.owner_expenses![0]!.status).toBe("declined");
  });
  it("lists only the owner's own pending approvals", async () => {
    const { f } = setup(10_000);
    await gateAndPostManagedVendorBill(f.db, bill());
    expect(await listPendingExpensesForOwner(f.db, OWNER)).toHaveLength(1);
    expect(await listPendingExpensesForOwner(f.db, "someone-else")).toHaveLength(0);
  });
  it("approve-all-under-$X approves only the routine ones", async () => {
    const { f } = setup(1_000);
    await gateAndPostManagedVendorBill(f.db, bill({ sourceId: "a", amountCents: 12_000 }));
    await gateAndPostManagedVendorBill(f.db, bill({ sourceId: "b", amountCents: 40_000 }));
    expect(await approveRoutineExpenses(f.db, OWNER, WS, 20_000)).toBe(1);
    const statuses = Object.fromEntries(f.rows.owner_expenses!.map((r) => [r.source_id as string, r.status]));
    expect(statuses).toEqual({ a: "approved", b: "pending_owner" });
  });
});

describe("refusals", () => {
  it("rejects a workspace that is not managed, a tiny bill, a missing vendor and a house from another workspace", async () => {
    const { f } = setup();
    await expect(gateAndPostManagedVendorBill(f.db, bill({ workspaceId: "other" }))).rejects.toMatchObject({ status: 409 });
    await expect(gateAndPostManagedVendorBill(f.db, bill({ amountCents: 50 }))).rejects.toMatchObject({ status: 400 });
    await expect(gateAndPostManagedVendorBill(f.db, bill({ vendorUserId: null, vendorDirectoryId: null }))).rejects.toMatchObject({ status: 400 });
    const g = setup(25_000, { manager_property_records: [{ id: "p1", workspace_id: "elsewhere" }] });
    await expect(gateAndPostManagedVendorBill(g.f.db, bill())).rejects.toMatchObject({ status: 409 });
  });
  it("a vendor without an account is owed under their directory entry", async () => {
    const { f, posted } = setup();
    await gateAndPostManagedVendorBill(f.db, bill({ vendorUserId: null, vendorDirectoryId: "dir-9" }));
    const lines = posted[0]!.p_lines as Array<{ party_id: string }>;
    expect(lines[1]!.party_id).toBe("vendor_dir:dir-9");
  });
});

describe("daily auto-approve cap", () => {
  const cap = { dailyAutoApproveCapThresholds: 4 };
  it("auto-approves up to the cap, then asks the owner instead of rejecting", async () => {
    const { f } = setup(25_000);
    const now = new Date("2026-10-18T12:00:00Z");
    for (let i = 0; i < 4; i++) {
      const r = await gateAndPostManagedVendorBill(f.db, bill({ sourceType: "manual", sourceId: `m-${i}`, amountCents: 25_000 }), now, cap);
      expect(r.status).toBe("posted");
    }
    const over = await gateAndPostManagedVendorBill(f.db, bill({ sourceType: "manual", sourceId: "m-4", amountCents: 1_000 }), now, cap);
    expect(over.status).toBe("pending_owner");
    expect(f.rows.owner_expenses!.at(-1)).toMatchObject({ status: "pending_owner", decided_via: null });
  });
  it("yesterday's auto-approvals do not count, and without the option nothing changes", async () => {
    const old = new Date("2026-10-17T00:00:00Z").toISOString();
    const { f } = setup(25_000, { owner_expenses: [{ id: "e0", workspace_id: WS, amount_cents: 100_000, decided_via: "auto", decided_at: old, status: "posted", source_type: "manual", source_id: "old" }] });
    const now = new Date("2026-10-18T12:00:00Z");
    expect((await gateAndPostManagedVendorBill(f.db, bill({ sourceType: "manual", sourceId: "n-1", amountCents: 20_000 }), now, cap)).status).toBe("posted");
    const g = setup(25_000, { owner_expenses: [{ id: "e1", workspace_id: WS, amount_cents: 100_000, decided_via: "auto", decided_at: now.toISOString(), status: "posted", source_type: "manual", source_id: "x" }] });
    expect((await gateAndPostManagedVendorBill(g.f.db, bill({ sourceType: "manual", sourceId: "n-2", amountCents: 20_000 }), now)).status).toBe("posted");
  });
});
