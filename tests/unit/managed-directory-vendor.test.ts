/**
 * A vendor texted by dispatch with no PropLane login: the managed bill posts to `vendor_dir:<id>`, the vendor is told money is
 * waiting, and when the account exists the balance is re-keyed to the vendor's own party (balanced, idempotent).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeOwnerDb, type FakeRow, type OwnerFakeDb } from "../helpers/owner-fake-db";

const sent = vi.hoisted(() => ({ texts: [] as Array<Record<string, unknown>>, ok: true }));
vi.mock("@/lib/one-number/link-text.server", () => ({
  sendWorkspacePhoneText: async (_db: unknown, input: Record<string, unknown>) => { sent.texts.push(input); return sent.ok; },
}));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://app.proplane.test" }));

import {
  claimWaitingDirectoryBalances,
  directoryBalancesByWorkspace,
  rekeyDirectoryBalances,
  textUnclaimedDirectoryBalance,
} from "@/lib/managed-finance/directory-vendor.server";
import { mergeDirectoryVendorPaidRow } from "@/lib/managed-finance/directory-vendor-paid";

const DIR = "vendor-abc";
const USER = "user-1";
const line = (party: string, ws: string | null, cents: number): FakeRow => ({ account: "vendor_payable", party_id: party, workspace_id: ws, amount_cents: cents });

/** A tiny in-memory party ledger behind `post_party_journal`: idempotent on key, rejects a changed replay, appends lines. */
function ledgerDb(seed: Record<string, FakeRow[]> = {}): OwnerFakeDb {
  const journals = new Map<string, string>();
  const f: OwnerFakeDb = fakeOwnerDb(seed, {
    rpc: {
      post_party_journal: (args) => {
        const lines = args.p_lines as Array<Record<string, unknown>>;
        if (lines.reduce((s, l) => s + Number(l.amount_cents), 0) !== 0) throw new Error("journal does not balance");
        const key = String(args.p_key);
        const hash = JSON.stringify(lines);
        if (journals.has(key)) {
          if (journals.get(key) !== hash) throw new Error("different lines");
          return { created: false, journal_id: `j-${key}` };
        }
        journals.set(key, hash);
        for (const l of lines) (f.rows.party_ledger_lines ??= []).push({ account: l.account, party_id: l.party_id, workspace_id: l.workspace_id, amount_cents: l.amount_cents });
        return { created: true, journal_id: `j-${key}` };
      },
    },
  });
  return f;
}

const owed = (rows: FakeRow[], party: string, ws: string | null) =>
  0 - rows.filter((r) => r.party_id === party && r.workspace_id === ws).reduce((s, r) => s + Number(r.amount_cents), 0);

beforeEach(() => { sent.texts.length = 0; sent.ok = true; });

describe("rekeying a directory vendor's balance to their account", () => {
  const seed = () => ({
    party_ledger_lines: [
      line(`vendor_dir:${DIR}`, "ws-1", -12_000), line(`vendor_dir:${DIR}`, "ws-1", -3_000),
      line(`vendor_dir:${DIR}`, "ws-2", -5_000), line("owner:o1", "ws-1", 15_000), line("owner:o2", "ws-2", 5_000),
    ],
  });

  it("reads what is owed per workspace", async () => {
    const f = ledgerDb(seed());
    expect(await directoryBalancesByWorkspace(f.db, DIR)).toEqual(expect.arrayContaining([
      { workspaceId: "ws-1", owedCents: 15_000 }, { workspaceId: "ws-2", owedCents: 5_000 },
    ]));
  });

  it("moves each workspace's balance in one balanced directory_claim journal and leaves the directory party at zero", async () => {
    const f = ledgerDb(seed());
    const r = await rekeyDirectoryBalances(f.db, { directoryId: DIR, vendorUserId: USER });
    expect(r).toEqual({ journals: 2, movedCents: 20_000 });
    const lines = f.rows.party_ledger_lines!;
    expect(owed(lines, `vendor:${USER}`, "ws-1")).toBe(15_000);
    expect(owed(lines, `vendor:${USER}`, "ws-2")).toBe(5_000);
    expect(owed(lines, `vendor_dir:${DIR}`, "ws-1")).toBe(0);
    expect(owed(lines, `vendor_dir:${DIR}`, "ws-2")).toBe(0);
    expect(lines.reduce((s, l) => s + Number(l.amount_cents), 0)).toBe(0);
    const calls = f.rpcCalls.filter((c) => c.name === "post_party_journal");
    expect(calls.every((c) => c.args.p_kind === "directory_claim")).toBe(true);
    const keys = calls.map((c) => String(c.args.p_key));
    expect(keys[0]).toMatch(new RegExp(`^directory-claim:${DIR}:${USER}:ws-1:[0-9a-f]{24}$`));
    expect(keys[1]).toMatch(new RegExp(`^directory-claim:${DIR}:${USER}:ws-2:[0-9a-f]{24}$`));
    expect(new Set(keys).size).toBe(2);
  });

  it("a later batch that totals the SAME cents as an already-claimed one still posts (the key is the lines, not the amount)", async () => {
    const f = ledgerDb(seed());
    await rekeyDirectoryBalances(f.db, { directoryId: DIR, vendorUserId: USER });
    // Exactly 15,000 again on ws-1: an amount-keyed journal replayed as "already recorded" and left it stranded.
    f.rows.party_ledger_lines!.push(line(`vendor_dir:${DIR}`, "ws-1", -15_000), line("owner:o1", "ws-1", 15_000));
    expect(await rekeyDirectoryBalances(f.db, { directoryId: DIR, vendorUserId: USER })).toEqual({ journals: 1, movedCents: 15_000 });
    expect(owed(f.rows.party_ledger_lines!, `vendor:${USER}`, "ws-1")).toBe(30_000);
    expect(owed(f.rows.party_ledger_lines!, `vendor_dir:${DIR}`, "ws-1")).toBe(0);
  });

  it("pages the party's lines: a balance past one page is summed in full", async () => {
    const many = Array.from({ length: 1_400 }, () => line(`vendor_dir:${DIR}`, "ws-1", -100));
    const f = ledgerDb({ party_ledger_lines: [...many, line("owner:o1", "ws-1", 140_000)] });
    expect(await directoryBalancesByWorkspace(f.db, DIR)).toEqual([{ workspaceId: "ws-1", owedCents: 140_000 }]);
  });

  it("is idempotent: a second run posts nothing and moves nothing", async () => {
    const f = ledgerDb(seed());
    await rekeyDirectoryBalances(f.db, { directoryId: DIR, vendorUserId: USER });
    const before = structuredClone(f.rows.party_ledger_lines);
    expect(await rekeyDirectoryBalances(f.db, { directoryId: DIR, vendorUserId: USER })).toEqual({ journals: 0, movedCents: 0 });
    expect(f.rows.party_ledger_lines).toEqual(before);
  });

  it("a bill posted to the directory after the first move is moved by the next run, once", async () => {
    const f = ledgerDb(seed());
    await rekeyDirectoryBalances(f.db, { directoryId: DIR, vendorUserId: USER });
    f.rows.party_ledger_lines!.push(line(`vendor_dir:${DIR}`, "ws-1", -2_500), line("owner:o1", "ws-1", 2_500));
    expect(await rekeyDirectoryBalances(f.db, { directoryId: DIR, vendorUserId: USER })).toEqual({ journals: 1, movedCents: 2_500 });
    expect(owed(f.rows.party_ledger_lines!, `vendor:${USER}`, "ws-1")).toBe(17_500);
  });

  it("refuses without a vendor or an account", async () => {
    const f = ledgerDb();
    await expect(rekeyDirectoryBalances(f.db, { directoryId: "", vendorUserId: USER })).rejects.toThrow();
    await expect(rekeyDirectoryBalances(f.db, { directoryId: DIR, vendorUserId: "" })).rejects.toThrow();
  });
});

describe("claiming waiting balances at sign-up", () => {
  const world = () => ledgerDb({
    party_ledger_lines: [line(`vendor_dir:${DIR}`, "ws-1", -9_000), line("owner:o1", "ws-1", 9_000), line("vendor_dir:vendor-other", "ws-1", -1_000), line("owner:o1", "ws-1", 1_000)],
    manager_vendor_records: [
      { id: DIR, manager_user_id: "mgr", vendor_user_id: null, row_data: { email: "Pat@Plumb.test", phone: "(206) 555-0100" } },
      { id: "vendor-other", manager_user_id: "mgr", vendor_user_id: null, row_data: { email: "else@x.test", phone: "2065550199" } },
    ],
  });

  it("claims by a PROVEN email and links the row to the account", async () => {
    const f = world();
    const claimed = await claimWaitingDirectoryBalances(f.db, { userId: USER, email: "pat@plumb.test", emailProven: true });
    expect(claimed).toEqual([DIR]);
    expect(f.rows.manager_vendor_records!.find((r) => r.id === DIR)!.vendor_user_id).toBe(USER);
    expect(f.rows.manager_vendor_records!.find((r) => r.id === "vendor-other")!.vendor_user_id).toBeNull();
    expect(owed(f.rows.party_ledger_lines!, `vendor:${USER}`, "ws-1")).toBe(9_000);
  });

  it("claims by a proven phone in any format", async () => {
    const f = world();
    expect(await claimWaitingDirectoryBalances(f.db, { userId: USER, phone: "+12065550100", phoneProven: true })).toEqual([DIR]);
  });

  it("reads only this vendor's own directory rows, never the whole vendor_dir ledger", async () => {
    const f = world();
    // A platform-wide `vendor_dir:%` scan read every vendor_payable line on the platform (up to a million rows
    // over a thousand round trips) just to discover which directory ids exist.
    const seen: string[] = [];
    const db = { ...(f.db as object), from: (table: string) => { seen.push(table); return (f.db as { from: (t: string) => unknown }).from(table); } } as never;
    expect(await claimWaitingDirectoryBalances(db, { userId: USER, phone: "+12065550100", phoneProven: true })).toEqual([DIR]);
    expect(seen[0]).toBe("manager_vendor_records");
    // Every ledger read that follows is scoped to one party, never a `like('party_id', 'vendor_dir:%')` sweep.
    expect(seen.filter((table) => table === "party_ledger_lines").length).toBeGreaterThan(0);
  });

  it("matches a phone stored in a human format, and never another vendor's number", async () => {
    const f = ledgerDb({
      party_ledger_lines: [line(`vendor_dir:${DIR}`, "ws-1", -9_000), line("owner:o1", "ws-1", 9_000)],
      manager_vendor_records: [
        { id: DIR, manager_user_id: "mgr", vendor_user_id: null, row_data: { phone: "(206) 555-0100" } },
        { id: "vendor-near", manager_user_id: "mgr", vendor_user_id: null, row_data: { phone: "206-555-9100" } },
      ],
    });
    expect(await claimWaitingDirectoryBalances(f.db, { userId: USER, phone: "+12065550100", phoneProven: true })).toEqual([DIR]);
    expect(f.rows.manager_vendor_records!.find((r) => r.id === "vendor-near")!.vendor_user_id).toBeNull();
  });

  it("a matching row with nothing waiting is left alone", async () => {
    const f = ledgerDb({
      party_ledger_lines: [],
      manager_vendor_records: [{ id: DIR, manager_user_id: "mgr", vendor_user_id: null, row_data: { email: "pat@plumb.test" } }],
    });
    expect(await claimWaitingDirectoryBalances(f.db, { userId: USER, email: "pat@plumb.test", emailProven: true })).toEqual([]);
    expect(f.rows.manager_vendor_records![0]!.vendor_user_id).toBeNull();
  });

  it("claims nothing by an unproven email or phone (a typed contact proves nothing)", async () => {
    const f = world();
    expect(await claimWaitingDirectoryBalances(f.db, { userId: USER, email: "pat@plumb.test", emailProven: false })).toEqual([]);
    expect(await claimWaitingDirectoryBalances(f.db, { userId: USER, phone: "2065550100", phoneProven: false })).toEqual([]);
    expect(f.rows.manager_vendor_records!.every((r) => r.vendor_user_id === null)).toBe(true);
    expect(f.rpcCalls.filter((c) => c.name === "post_party_journal")).toHaveLength(0);
  });

  it("does not take a row that is already linked to someone else", async () => {
    const f = world();
    f.rows.manager_vendor_records![0]!.vendor_user_id = "someone-else";
    expect(await claimWaitingDirectoryBalances(f.db, { userId: USER, email: "pat@plumb.test", emailProven: true })).toEqual([]);
    expect(f.rpcCalls.filter((c) => c.name === "post_party_journal")).toHaveLength(0);
  });

  it("a failed move gives the link back, so the payable is never stranded on the directory party", async () => {
    const f = ledgerDb({
      party_ledger_lines: [line(`vendor_dir:${DIR}`, "ws-1", -9_000), line("owner:o1", "ws-1", 9_000)],
      manager_vendor_records: [{ id: DIR, manager_user_id: "mgr", vendor_user_id: null, row_data: { email: "pat@plumb.test" } }],
    });
    // The ledger refuses the claim journal: the row must not stay linked, or nothing selects it again.
    const broken = { ...f, db: { ...(f.db as object), rpc: async () => ({ data: null, error: { code: "P0001", message: "ledger down" } }) } as never };
    await expect(claimWaitingDirectoryBalances(broken.db, { userId: USER, email: "pat@plumb.test", emailProven: true })).rejects.toThrow();
    expect(f.rows.manager_vendor_records![0]!.vendor_user_id).toBeNull();
  });

  it("sweeps a balance that is still on the directory party of a row already linked to this account", async () => {
    const f = ledgerDb({
      party_ledger_lines: [line(`vendor_dir:${DIR}`, "ws-1", -4_000), line("owner:o1", "ws-1", 4_000)],
      manager_vendor_records: [{ id: DIR, manager_user_id: "mgr", vendor_user_id: USER, row_data: { email: "pat@plumb.test" } }],
    });
    expect(await claimWaitingDirectoryBalances(f.db, { userId: USER, email: "pat@plumb.test", emailProven: true })).toEqual([DIR]);
    expect(owed(f.rows.party_ledger_lines!, `vendor:${USER}`, "ws-1")).toBe(4_000);
    expect(owed(f.rows.party_ledger_lines!, `vendor_dir:${DIR}`, "ws-1")).toBe(0);
  });
});

describe("telling an unclaimed directory vendor that money is waiting", () => {
  const world = (record: Partial<FakeRow> = {}) => fakeOwnerDb({
    party_ledger_lines: [line(`vendor_dir:${DIR}`, "ws-1", -12_550), line("owner:o1", "ws-1", 12_550)],
    manager_vendor_records: [{ id: DIR, manager_user_id: "mgr", vendor_user_id: null, row_data: { name: "Pat", email: "pat@plumb.test", phone: "2065550100" }, ...record }],
    profiles: [{ id: "mgr", full_name: "Sam Manager" }],
    vendor_invites: [],
  });

  it("texts the amount and a sign-up link from the workspace number, once per day", async () => {
    const f = world();
    expect(await textUnclaimedDirectoryBalance(f.db, { directoryId: DIR, workspaceId: "ws-1", now: new Date("2026-10-19T18:00:00Z") })).toBe(true);
    expect(sent.texts).toHaveLength(1);
    expect(sent.texts[0]).toMatchObject({
      workspaceId: "ws-1", phoneKey: "+12065550100", role: "vendor",
      idempotencyKey: `dir-balance-waiting:${DIR}:2026-10-19`,
    });
    expect(String(sent.texts[0]!.body)).toContain("$125.50 waiting");
    expect(String(sent.texts[0]!.body)).toContain("https://app.proplane.test/auth/vendor-register");
  });

  it("is silent when the vendor already has an account, has no phone, or nothing is owed", async () => {
    expect(await textUnclaimedDirectoryBalance(world({ vendor_user_id: "u9" }).db, { directoryId: DIR, workspaceId: "ws-1" })).toBe(false);
    expect(await textUnclaimedDirectoryBalance(world({ row_data: { name: "Pat" } }).db, { directoryId: DIR, workspaceId: "ws-1" })).toBe(false);
    const empty = fakeOwnerDb({ party_ledger_lines: [], manager_vendor_records: [{ id: DIR, manager_user_id: "mgr", vendor_user_id: null, row_data: { phone: "2065550100" } }] });
    expect(await textUnclaimedDirectoryBalance(empty.db, { directoryId: DIR, workspaceId: "ws-1" })).toBe(false);
    expect(sent.texts).toHaveLength(0);
  });

  it("never throws when the send fails", async () => {
    sent.ok = false;
    expect(await textUnclaimedDirectoryBalance(world().db, { directoryId: DIR, workspaceId: "ws-1" })).toBe(false);
    expect(await textUnclaimedDirectoryBalance({ from: () => { throw new Error("db down"); } } as never, { directoryId: DIR, workspaceId: "ws-1" })).toBe(false);
  });
});

describe("the paid-state merge for a service whose vendor has no login", () => {
  it("applies only the allowed keys to the current row and keeps an earlier completion and paid date", () => {
    const merged = mergeDirectoryVendorPaidRow(
      { id: "wo-1", title: "Leak", bucket: "open", completedAt: "2026-10-01", paidAt: undefined, expenseEntryIds: ["e1"], someone: "else" },
      { id: "WRONG", title: "WRONG", bucket: "completed", status: "Completed", vendorCostCents: 35_000, completedAt: "2026-10-19", paidAt: "2026-10-19", expenseEntryIds: ["e2", "e1"], vendorPaymentChannel: "balance" },
    );
    expect(merged).toMatchObject({
      id: "wo-1", title: "Leak", someone: "else", bucket: "completed", status: "Completed", vendorCostCents: 35_000,
      completedAt: "2026-10-01", automationStatus: "paid", paidAt: "2026-10-19", vendorPaymentChannel: "balance",
    });
    expect((merged.expenseEntryIds as string[]).sort()).toEqual(["e1", "e2"]);
  });
  it("never moves a paid date that is already set", () => {
    expect(mergeDirectoryVendorPaidRow({ paidAt: "2026-10-05" }, { paidAt: "2026-10-19" }).paidAt).toBe("2026-10-05");
  });
});
