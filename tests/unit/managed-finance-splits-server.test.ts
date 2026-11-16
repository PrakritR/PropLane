import { describe, expect, it, vi } from "vitest";
import { fakeOwnerDb, type FakeRow } from "../helpers/owner-fake-db";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/owner-management/policies.server", async () => {
  const actual = await vi.importActual<object>("@/lib/owner-management/policies.server");
  return { ...actual, loadActivePolicyForWorkspace: vi.fn(async () => ({ id: "pol", workspaceId: "ws", ownerUserId: "owner", terms: { repairApprovalThresholdCents: 25_000, reserveTargetCents: 0 } })) };
});

import {
  activePayoutHold, applySplitsForPaymentIntent, createSplitRule, endSplitRule, placePayoutHold, releasePayoutHold,
  reverseSplitsForRefund, setBillApprovalThreshold, loadBillApprovalThreshold,
} from "@/lib/managed-finance/splits.server";
import { foldPartyBalances } from "@/lib/managed-finance/admin-payouts.server";
import { billsOutlook, findDuplicateVendorBills } from "@/lib/managed-finance/bill-pay.server";
import { earningsByHouse, earningsCsv } from "@/lib/managed-finance/earnings";

const WS = "ws";
const alloc = (over: FakeRow = {}): FakeRow => ({
  id: "a1", workspace_id: WS, charge_id: "c1", charge_kind: "rent", liability_class: "income", property_id: "p1", owner_user_id: "owner",
  owner_cents: 90_001, available_on: "2026-06-05T00:00:00Z", paid_at: "2026-06-01T12:00:00Z", stripe_payment_intent_id: "pi_1", refunded_owner_cents: 0, ...over,
});
const ruleRow = (over: FakeRow = {}): FakeRow => ({
  id: "rule1", workspace_id: WS, property_id: null, rule_kind: "percent", applies_to: ["rent", "stay_total"], payee_kind: "member", payee_user_id: "m1",
  bps: 1500, fixed_cents: null, effective_from: "2026-01-01T00:00:00Z", ended_at: null, created_at: "2026-01-01T00:00:00Z", ...over,
});

/** A post_party_journal that behaves like the database function: idempotent on the key, a different payload raises. */
function ledger() {
  const journals = new Map<string, { hash: string; id: string; lines: Array<Record<string, unknown>>; kind: string }>();
  return {
    journals,
    handler: (args: Record<string, unknown>) => {
      const key = String(args.p_key);
      const lines = args.p_lines as Array<Record<string, unknown>>;
      const hash = JSON.stringify([args.p_kind, lines]);
      const sum = lines.reduce((s, l) => s + Number(l.amount_cents), 0);
      if (sum !== 0) throw new Error("does not balance");
      const have = journals.get(key);
      if (have) {
        if (have.hash !== hash) throw new Error("already posted with different lines");
        return { created: false, journal_id: have.id };
      }
      const id = `j${journals.size + 1}`;
      journals.set(key, { hash, id, lines, kind: String(args.p_kind) });
      return { created: true, journal_id: id };
    },
  };
}

function setup(seed: Record<string, FakeRow[]> = {}) {
  const l = ledger();
  const f = fakeOwnerDb(
    {
      managed_rent_allocations: [alloc()],
      managed_split_rules: [ruleRow()],
      managed_split_allocations: [],
      payout_staff_actions: [],
      ...seed,
    },
    { rpc: { post_party_journal: (a) => l.handler(a) }, uniques: { managed_split_allocations: [["allocation_id", "rule_id"]] } },
  );
  return { f, l };
}

describe("applySplitsForPaymentIntent", () => {
  it("posts ONE balanced journal that debits the owner and credits the payee, owner keeps the remainder", async () => {
    const { f, l } = setup();
    const r = await applySplitsForPaymentIntent(f.db, { workspaceId: WS, paymentIntentId: "pi_1" });
    expect(r).toEqual({ journals: 1, paidOutCents: 13_500 });
    const journal = [...l.journals.values()][0]!;
    expect(journal.kind).toBe("split_allocation");
    expect(journal.lines.reduce((s, x) => s + Number(x.amount_cents), 0)).toBe(0);
    expect(journal.lines[0]).toMatchObject({ account: "owner_payable", party_id: "owner:owner", amount_cents: 13_500, available_on: "2026-06-05T00:00:00Z" });
    expect(journal.lines[1]).toMatchObject({ account: "owner_payable", party_id: "owner:m1", amount_cents: -13_500, available_on: "2026-06-05T00:00:00Z" });
    expect(f.rows.managed_split_allocations).toHaveLength(1);
  });

  it("is idempotent: a replay posts nothing twice and writes no second row", async () => {
    const { f, l } = setup();
    await applySplitsForPaymentIntent(f.db, { workspaceId: WS, paymentIntentId: "pi_1" });
    const again = await applySplitsForPaymentIntent(f.db, { workspaceId: WS, paymentIntentId: "pi_1" });
    expect(again.journals).toBe(0);
    expect(l.journals.size).toBe(1);
    expect(f.rows.managed_split_allocations).toHaveLength(1);
  });

  it("a rule created AFTER the payment never splits it, even on a late redelivery", async () => {
    const { f, l } = setup({ managed_split_rules: [ruleRow({ effective_from: "2026-07-01T00:00:00Z" })] });
    expect(await applySplitsForPaymentIntent(f.db, { workspaceId: WS, paymentIntentId: "pi_1" })).toEqual({ journals: 0, paidOutCents: 0 });
    expect(l.journals.size).toBe(0);
  });

  it("a rule ended after the payment still splits it (the version in force on the payment date)", async () => {
    const { f } = setup({ managed_split_rules: [ruleRow({ ended_at: "2026-06-15T00:00:00Z" })] });
    expect((await applySplitsForPaymentIntent(f.db, { workspaceId: WS, paymentIntentId: "pi_1" })).journals).toBe(1);
  });

  it("does nothing for deposits, a missing table or a workspace with no rules", async () => {
    const dep = setup({ managed_rent_allocations: [alloc({ liability_class: "deposit", owner_cents: 0 })] });
    expect((await applySplitsForPaymentIntent(dep.f.db, { workspaceId: WS, paymentIntentId: "pi_1" })).journals).toBe(0);
    const none = setup({ managed_split_rules: [] });
    expect((await applySplitsForPaymentIntent(none.f.db, { workspaceId: WS, paymentIntentId: "pi_1" })).journals).toBe(0);
    const l = ledger();
    const broken = fakeOwnerDb({}, { broken: ["managed_rent_allocations"], rpc: { post_party_journal: (a) => l.handler(a) } });
    expect(await applySplitsForPaymentIntent(broken.db, { workspaceId: WS, paymentIntentId: "pi_1" })).toEqual({ journals: 0, paidOutCents: 0 });
  });

  it("a vendor payee is credited on the vendor payable, same journal", async () => {
    const { f, l } = setup({ managed_split_rules: [ruleRow({ payee_kind: "vendor", payee_user_id: "v1", rule_kind: "fixed", bps: null, fixed_cents: 5_000 })] });
    await applySplitsForPaymentIntent(f.db, { workspaceId: WS, paymentIntentId: "pi_1" });
    expect([...l.journals.values()][0]!.lines[1]).toMatchObject({ account: "vendor_payable", party_id: "vendor:v1", amount_cents: -5_000 });
  });
});

describe("reverseSplitsForRefund", () => {
  const seeded = (refundedOwner: number) => {
    const { f, l } = setup({ managed_rent_allocations: [alloc({ refunded_owner_cents: refundedOwner })] });
    return { f, l };
  };
  const withSplit = async (refundedOwner: number) => {
    const { f, l } = seeded(0);
    await applySplitsForPaymentIntent(f.db, { workspaceId: WS, paymentIntentId: "pi_1" });
    (f.rows.managed_rent_allocations![0] as FakeRow).refunded_owner_cents = refundedOwner;
    // The fake upsert does not apply column defaults; the database gives every row an id and reversed_cents = 0.
    (f.rows.managed_split_allocations as FakeRow[]).forEach((row, i) => Object.assign(row, { id: `sa${i}`, reversed_cents: 0 }));
    return { f, l };
  };
  it("a full refund returns the whole share to the owner in one balanced journal", async () => {
    const { f, l } = await withSplit(90_001);
    const r = await reverseSplitsForRefund(f.db, { allocationId: "a1", refundId: "re_1" });
    expect(r.reversedCents).toBe(13_500);
    const j = l.journals.get("split-reversal:re_1:a1")!;
    expect(j.lines.reduce((s, x) => s + Number(x.amount_cents), 0)).toBe(0);
    expect(j.lines.find((x) => x.party_id === "owner:m1")).toMatchObject({ amount_cents: 13_500 });
    expect((f.rows.managed_split_allocations![0] as FakeRow).reversed_cents).toBe(13_500);
  });
  it("is idempotent per refund", async () => {
    const { f, l } = await withSplit(90_001);
    await reverseSplitsForRefund(f.db, { allocationId: "a1", refundId: "re_1" });
    const again = await reverseSplitsForRefund(f.db, { allocationId: "a1", refundId: "re_1" });
    expect(again.reversedCents).toBe(0);
    expect([...l.journals.keys()].filter((k) => k.startsWith("split-reversal"))).toHaveLength(1);
  });
  it("two partial refunds never reverse more than the share in total", async () => {
    const { f } = await withSplit(30_000);
    const first = await reverseSplitsForRefund(f.db, { allocationId: "a1", refundId: "re_1" });
    (f.rows.managed_rent_allocations![0] as FakeRow).refunded_owner_cents = 90_001;
    const second = await reverseSplitsForRefund(f.db, { allocationId: "a1", refundId: "re_2" });
    expect(first.reversedCents + second.reversedCents).toBe(13_500);
  });
  it("an allocation that was never split reverses nothing", async () => {
    const { f } = seeded(10);
    expect(await reverseSplitsForRefund(f.db, { allocationId: "a1", refundId: "re_9" })).toEqual({ reversedCents: 0 });
  });
});

describe("createSplitRule / endSplitRule: audit first, server-derived eligibility", () => {
  const facts = (): Record<string, FakeRow[]> => ({
    managed_split_rules: [],
    account_link_invites: [{ id: "i1", workspace_id: WS, status: "accepted", invitee_user_id: "m1", team_role: "co_manager", is_owner_of_record: false }],
    manager_property_records: [{ id: "p1", workspace_id: WS }],
    profiles: [{ id: "v1", stripe_connect_account_id: "acct_v1" }],
    profile_roles: [{ user_id: "v1", role: "vendor" }],
  });
  const draft = { propertyId: null, ruleKind: "percent" as const, appliesTo: ["rent"], payeeKind: "member" as const, payeeUserId: "m1", bps: 1500, fixedCents: null };

  it("writes the audit row before the rule and stamps effective_from at now", async () => {
    const { f } = setup(facts());
    const now = new Date("2026-06-10T00:00:00Z");
    const created = await createSplitRule(f.db, { actorUserId: "admin", workspaceId: WS, draft }, now);
    expect(created.effectiveFrom).toBe(now.toISOString());
    const order = f.writes.filter((w) => w.table === "payout_staff_actions" || w.table === "managed_split_rules").map((w) => w.table);
    expect(order).toEqual(["payout_staff_actions", "managed_split_rules"]);
    expect((f.rows.payout_staff_actions![0] as FakeRow).action).toBe("split_rule_created");
  });
  it("refuses a payee who is not on the workspace's team, with no audit row and no rule", async () => {
    const { f } = setup(facts());
    await expect(createSplitRule(f.db, { actorUserId: "admin", workspaceId: WS, draft: { ...draft, payeeUserId: "stranger" } })).rejects.toMatchObject({ status: 422 });
    expect(f.rows.payout_staff_actions).toHaveLength(0);
    expect(f.rows.managed_split_rules).toHaveLength(0);
  });
  it("refuses the Property owner seat as a team payee and a house in another workspace", async () => {
    const seed = facts();
    seed.account_link_invites = [{ id: "i2", workspace_id: WS, status: "accepted", invitee_user_id: "m9", team_role: "property_owner" }];
    const { f } = setup(seed);
    await expect(createSplitRule(f.db, { actorUserId: "admin", workspaceId: WS, draft: { ...draft, payeeUserId: "m9" } })).rejects.toMatchObject({ status: 422 });
    const other = setup(facts());
    await expect(createSplitRule(other.f.db, { actorUserId: "admin", workspaceId: WS, draft: { ...draft, propertyId: "p-elsewhere" } })).rejects.toMatchObject({ status: 422 });
  });
  it("a vendor needs the vendor role AND a connected account", async () => {
    const ok = setup(facts());
    await expect(createSplitRule(ok.f.db, { actorUserId: "admin", workspaceId: WS, draft: { ...draft, payeeKind: "vendor", payeeUserId: "v1" } })).resolves.toMatchObject({ payeeKind: "vendor" });
    const seed = facts();
    seed.profiles = [{ id: "v1", stripe_connect_account_id: null }];
    const no = setup(seed);
    await expect(createSplitRule(no.f.db, { actorUserId: "admin", workspaceId: WS, draft: { ...draft, payeeKind: "vendor", payeeUserId: "v1" } })).rejects.toMatchObject({ status: 422 });
  });
  it("total percent over 100% is refused against the rules in force", async () => {
    const seed = facts();
    seed.managed_split_rules = [ruleRow({ bps: 9500, applies_to: ["rent"] })];
    const { f } = setup(seed);
    await expect(createSplitRule(f.db, { actorUserId: "admin", workspaceId: WS, draft: { ...draft, bps: 600 } })).rejects.toMatchObject({ status: 422 });
  });
  it("ending a rule audits first, sets ended_at once, and never edits its terms", async () => {
    const { f } = setup({ ...facts(), managed_split_rules: [ruleRow()] });
    await endSplitRule(f.db, { actorUserId: "admin", workspaceId: WS, ruleId: "rule1" }, new Date("2026-06-20T00:00:00Z"));
    const row = f.rows.managed_split_rules![0] as FakeRow;
    expect(row.ended_at).toBe("2026-06-20T00:00:00.000Z");
    expect(row.bps).toBe(1500);
    await expect(endSplitRule(f.db, { actorUserId: "admin", workspaceId: WS, ruleId: "rule1" })).rejects.toMatchObject({ status: 409 });
    await expect(endSplitRule(f.db, { actorUserId: "admin", workspaceId: "other-ws", ruleId: "rule1" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("payout holds and the bill approval threshold", () => {
  const PARTY = "owner:11111111-1111-1111-1111-111111111111";
  it("a hold is audited first, blocks the party (in its workspace and workspace-less), and release clears it", async () => {
    const { f } = setup({ managed_payout_holds: [] });
    await placePayoutHold(f.db, { actorUserId: "admin", partyId: PARTY, workspaceId: WS, reason: "Chargeback review" });
    expect(f.writes.filter((w) => w.table === "payout_staff_actions" || w.table === "managed_payout_holds").map((w) => w.table)).toEqual(["payout_staff_actions", "managed_payout_holds"]);
    expect(await activePayoutHold(f.db, PARTY, WS)).toMatchObject({ reason: "Chargeback review" });
    expect(await activePayoutHold(f.db, PARTY, null)).not.toBeNull();
    expect(await activePayoutHold(f.db, PARTY, "other-ws")).toBeNull();
    const id = String((f.rows.managed_payout_holds![0] as FakeRow).id);
    await releasePayoutHold(f.db, { actorUserId: "admin", holdId: id });
    expect(await activePayoutHold(f.db, PARTY, WS)).toBeNull();
    await expect(releasePayoutHold(f.db, { actorUserId: "admin", holdId: id })).rejects.toMatchObject({ status: 409 });
  });
  it("refuses a hold with no reason or a malformed party", async () => {
    const { f } = setup({ managed_payout_holds: [] });
    await expect(placePayoutHold(f.db, { actorUserId: "admin", partyId: PARTY, workspaceId: WS, reason: " " })).rejects.toMatchObject({ status: 400 });
    await expect(placePayoutHold(f.db, { actorUserId: "admin", partyId: "owner:x", workspaceId: WS, reason: "because" })).rejects.toMatchObject({ status: 400 });
  });
  it("an unreadable hold fails closed (the withdrawal is refused, never skipped)", async () => {
    const f = fakeOwnerDb({}, { broken: [] });
    (f.rows as Record<string, FakeRow[]>).managed_payout_holds = [];
    const failing = { from: () => ({ select: () => ({ eq: () => ({ is: () => ({ limit: async () => ({ data: null, error: { code: "XX000", message: "down" } }) }) }) }) }) };
    await expect(activePayoutHold(failing as never, PARTY, WS)).rejects.toMatchObject({ status: 503 });
  });
  it("the threshold defaults to the fee policy's own (null) and is audited when set", async () => {
    const { f } = setup({ managed_payout_settings: [] });
    expect(await loadBillApprovalThreshold(f.db, WS)).toBeNull();
    await setBillApprovalThreshold(f.db, { actorUserId: "admin", workspaceId: WS, cents: 50_000 });
    expect(await loadBillApprovalThreshold(f.db, WS)).toBe(50_000);
    expect((f.rows.payout_staff_actions![0] as FakeRow).action).toBe("bill_threshold_set");
    await expect(setBillApprovalThreshold(f.db, { actorUserId: "admin", workspaceId: WS, cents: -1 })).rejects.toMatchObject({ status: 400 });
  });
});

describe("admin and earnings folds", () => {
  it("foldPartyBalances: owner per workspace, vendor across workspaces, fee revenue separate, pending vs matured", () => {
    const now = Date.parse("2026-06-10T00:00:00Z");
    const { parties, feeRevenueCents } = foldPartyBalances(
      [
        { account: "owner_payable", party_id: "owner:o", workspace_id: "w1", amount_cents: -10_000, available_on: "2026-06-01T00:00:00Z" },
        { account: "owner_payable", party_id: "owner:o", workspace_id: "w1", amount_cents: -4_000, available_on: "2026-06-20T00:00:00Z" },
        { account: "owner_payable", party_id: "owner:o", workspace_id: "w1", amount_cents: 2_000, available_on: null },
        { account: "vendor_payable", party_id: "vendor:v", workspace_id: "w1", amount_cents: -500, available_on: null },
        { account: "vendor_payable", party_id: "vendor:v", workspace_id: "w2", amount_cents: -700, available_on: null },
        { account: "proplane_fee_revenue", party_id: null, workspace_id: "w1", amount_cents: -1_100, available_on: null },
      ],
      now,
    );
    expect(feeRevenueCents).toBe(1_100);
    expect(parties.get("owner_payable|owner:o|w1")).toMatchObject({ owed: 12_000, matured: 8_000 });
    expect(parties.get("vendor_payable|vendor:v|")).toMatchObject({ owed: 1_200, matured: 1_200 });
  });
  it("earningsByHouse nets rent shares, splits, refunds and vendor charges per house; withdrawals are not earnings", () => {
    const line = (kind: string, amountCents: number, detail: Record<string, unknown>) => ({ journalId: kind, amountCents, availableOn: null, postedAt: "2026-06-01", kind, detail, sourceType: null, sourceId: null });
    const houses = earningsByHouse([
      line("rent_capture", -90_000, { charges: [{ property_id: "p1", owner_cents: 60_000 }, { property_id: "p2", owner_cents: 30_000 }] }),
      line("split_allocation", 13_500, { property_id: "p1" }),
      line("vendor_bill", 5_000, { property_id: "p2" }),
      line("withdrawal_reserve", 20_000, {}),
    ]);
    expect(houses).toEqual([{ propertyId: "p1", cents: 46_500 }, { propertyId: "p2", cents: 25_000 }]);
  });
  it("the CSV neutralises a formula label and quotes commas", () => {
    const csv = earningsCsv([{ id: "j:rent", date: "2026-06-01T00:00:00Z", kind: "rent", label: "=HYPERLINK(\"x\")", amountCents: 12_345, workspaceName: "A, B" }]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('"A, B"');
    expect(csv).toContain("123.45");
  });
});

describe("bill pay guards", () => {
  it("findDuplicateVendorBills matches the same vendor, amount and house inside the window, and not a declined one", async () => {
    const now = new Date("2026-06-10T00:00:00Z");
    const f = fakeOwnerDb({
      owner_expenses: [
        { id: "e1", workspace_id: WS, vendor_party_id: "vendor:v1", amount_cents: 20_000, status: "posted", property_id: "p1", vendor_label: "Mike", source_id: "old", created_at: "2026-06-08T00:00:00Z" },
        { id: "e2", workspace_id: WS, vendor_party_id: "vendor:v1", amount_cents: 20_000, status: "declined", property_id: "p1", vendor_label: "Mike", source_id: "old2", created_at: "2026-06-09T00:00:00Z" },
      ],
    });
    const hits = await findDuplicateVendorBills(f.db, { workspaceId: WS, vendorPartyId: "vendor:v1", amountCents: 20_000, propertyId: "p1", sourceId: "new", now });
    expect(hits.map((h) => h.id)).toEqual(["e1"]);
    const other = await findDuplicateVendorBills(f.db, { workspaceId: WS, vendorPartyId: "vendor:v2", amountCents: 20_000, propertyId: "p1", sourceId: "new", now });
    expect(other).toEqual([]);
  });
  it("billsOutlook: the shortfall is what is needed beyond what is available, never positive", () => {
    expect(billsOutlook({ availableCents: 100_000, pendingCents: 0, awaitingApprovalCents: 30_000, dueOutsideCents: 20_000 }).shortfallCents).toBe(0);
    expect(billsOutlook({ availableCents: 10_000, pendingCents: 5_000, awaitingApprovalCents: 30_000, dueOutsideCents: 20_000 }).shortfallCents).toBe(-40_000);
  });
});
