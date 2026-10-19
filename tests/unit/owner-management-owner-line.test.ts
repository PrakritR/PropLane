import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeOwnerDb, type FakeRow } from "../helpers/owner-fake-db";

const profile = vi.hoisted(() => ({ value: { id: "own-1", email: "o@x.test" } as { id: string; email: string } | null }));
vi.mock("@/lib/one-number/router-lookups.server", () => ({ findVerifiedProfileByPhone: vi.fn(async () => profile.value) }));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://app.test" }));
vi.mock("@/lib/managed-finance/occupancy.server", () => ({ workspaceOccupancy: vi.fn(async () => ({ houses: 1, units: 5, occupied: 4 })) }));
const lines = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock("@/lib/managed-finance/ledger.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/managed-finance/ledger.server")>("@/lib/managed-finance/ledger.server");
  return { ...actual, readPartyLines: vi.fn(async () => lines.value) };
});
const decide = vi.hoisted(() => vi.fn());
const pending = vi.hoisted(() => ({ value: [] as Array<{ id: string; title: string; amountCents: number }> }));
vi.mock("@/lib/managed-finance/vendor-bills.server", () => ({
  decideOwnerExpense: decide,
  listPendingExpensesForOwner: vi.fn(async () => pending.value),
}));

import { classifyOwnerText, handleOwnerLine } from "@/lib/owner-management/owner-line.server";

const policyRow = (over: Record<string, unknown> = {}): FakeRow => ({
  id: "pol-1", workspace_id: "ws-1", owner_user_id: "own-1", status: "active", signed_at: "2026-01-01T00:00:00Z", owner_share_bps: 9000,
  applies_to: "rent", leasing_fee_bps: 0, min_fee_cents: 0, reserve_target_cents: 5_000, repair_approval_threshold_cents: 25_000,
  effective_from: "2026-01-01", accepted_via: "owner_signature", terms_sha256: "h", created_at: "2026-01-01", ...over,
});
const db = (policies: FakeRow[] = [policyRow()]) => fakeOwnerDb(
  { managed_workspace_fee_policies: policies, portal_workspaces: [{ id: "ws-1", name: "Seattle Homes", owner_user_id: "mgr" }] },
  { rpc: { party_balance: () => [{ owed: 135_000, matured: 90_000, pending: 45_000 }] } },
);

beforeEach(() => {
  profile.value = { id: "own-1", email: "o@x.test" };
  pending.value = [];
  lines.value = [];
  decide.mockReset();
});

describe("classifyOwnerText", () => {
  it("reads approvals, the statement, status and help", () => {
    expect(classifyOwnerText("Y")).toMatchObject({ kind: "approve", approve: true, index: null });
    expect(classifyOwnerText("yes.")).toMatchObject({ kind: "approve", approve: true });
    expect(classifyOwnerText("N 2")).toMatchObject({ kind: "approve", approve: false, index: 2 });
    expect(classifyOwnerText("y1")).toMatchObject({ kind: "approve", approve: true, index: 1 });
    expect(classifyOwnerText("Y all")).toMatchObject({ kind: "approve", approve: true, all: true });
    expect(classifyOwnerText("statement").kind).toBe("statement");
    expect(classifyOwnerText("How's my house doing?").kind).toBe("status");
    expect(classifyOwnerText("balance").kind).toBe("status");
  });
  it("does not read ordinary sentences as owner questions", () => {
    for (const t of ["yes the toilet is broken", "when is the tour", "no thanks", "can I get a statement of work", "hello"]) {
      expect(classifyOwnerText(t).kind).toBe("none");
    }
  });
});

describe("the owner lane", () => {
  it("passes everything through for a person who is not the owner of record of a managed workspace", async () => {
    profile.value = null;
    expect(await handleOwnerLine(db().db, { fromPhone: "+12065550100", body: "balance" })).toEqual({ handled: false });
    profile.value = { id: "someone", email: "s@x.test" };
    expect(await handleOwnerLine(db().db, { fromPhone: "+12065550100", body: "balance" })).toEqual({ handled: false });
    expect(await handleOwnerLine(db([policyRow({ status: "ended" })]).db, { fromPhone: "+12065550100", body: "balance" })).toEqual({ handled: false });
  });
  it("answers 'how's my house doing' from the ledger: occupancy, rent this month, balance and what can be withdrawn", async () => {
    const r = await handleOwnerLine(db().db, { fromPhone: "+12065550100", body: "How's my house doing?" });
    expect(r).toMatchObject({ handled: true });
    const reply = (r as { reply: string }).reply;
    expect(reply).toContain("Seattle Homes:");
    expect(reply).toContain("4 of 5 rooms occupied");
    expect(reply).toContain("balance $1,350.00");
    expect(reply).toContain("$850.00 available to withdraw"); // matured 900 less the $50 reserve
  });
  it("sends the statement as a sign-in link to the owner's own workspace", async () => {
    const r = await handleOwnerLine(db().db, { fromPhone: "+12065550100", body: "statement" });
    expect((r as { reply: string }).reply).toContain("/auth/sign-in?next=");
    expect((r as { reply: string }).reply).toContain(encodeURIComponent("/portal/owner/finances?workspace=ws-1"));
  });
  it("a Y or N means nothing unless a repair is waiting on this person", async () => {
    expect(await handleOwnerLine(db().db, { fromPhone: "+12065550100", body: "Y" })).toEqual({ handled: false });
    expect(decide).not.toHaveBeenCalled();
  });
  it("one waiting repair: Y approves it as this owner, over SMS", async () => {
    pending.value = [{ id: "e1", title: "Leak repair", amountCents: 24_000 }];
    decide.mockResolvedValue({ status: "approved", expenseId: "e1" });
    const r = await handleOwnerLine(db().db, { fromPhone: "+12065550100", body: "Y" });
    expect(decide).toHaveBeenCalledWith(expect.anything(), { expenseId: "e1", ownerUserId: "own-1", approve: true, via: "sms" }, expect.any(Date));
    expect((r as { reply: string }).reply).toContain("Approved: Leak repair");
  });
  it("N declines", async () => {
    pending.value = [{ id: "e1", title: "Leak repair", amountCents: 24_000 }];
    decide.mockResolvedValue({ status: "declined", expenseId: "e1" });
    expect((await handleOwnerLine(db().db, { fromPhone: "+12065550100", body: "n" }) as { reply: string }).reply).toContain("Declined");
  });
  it("several waiting: a bare Y asks which, Y2 picks the second, Y all approves every one", async () => {
    pending.value = [{ id: "e1", title: "Leak", amountCents: 24_000 }, { id: "e2", title: "Fence", amountCents: 90_000 }];
    decide.mockResolvedValue({ status: "approved" });
    const ask = await handleOwnerLine(db().db, { fromPhone: "+12065550100", body: "Y" });
    expect((ask as { reply: string }).reply).toContain("2 repairs waiting");
    expect(decide).not.toHaveBeenCalled();
    await handleOwnerLine(db().db, { fromPhone: "+12065550100", body: "Y2" });
    expect(decide.mock.calls[0]![1]).toMatchObject({ expenseId: "e2" });
    decide.mockClear();
    const all = await handleOwnerLine(db().db, { fromPhone: "+12065550100", body: "Y all" });
    expect(decide).toHaveBeenCalledTimes(2);
    expect((all as { reply: string }).reply).toBe("Approved 2 repairs.");
  });
  it("an answer already given is said so, and an out-of-range number asks again", async () => {
    pending.value = [{ id: "e1", title: "Leak", amountCents: 24_000 }];
    decide.mockResolvedValue({ status: "already_decided" });
    expect((await handleOwnerLine(db().db, { fromPhone: "+12065550100", body: "Y" }) as { reply: string }).reply).toContain("already answered");
    pending.value = [{ id: "e1", title: "Leak", amountCents: 24_000 }, { id: "e2", title: "Fence", amountCents: 1_000 }];
    expect((await handleOwnerLine(db().db, { fromPhone: "+12065550100", body: "Y9" }) as { reply: string }).reply).toContain("2 repairs waiting");
  });
});
