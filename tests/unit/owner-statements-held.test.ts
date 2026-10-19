/**
 * A workspace PropLane holds the funds for books its rent in the owner's ledger, never in the manager's own books. The owner's
 * Statements list reads those months from the ledger (one figure per workspace), keeps the books for every other house, and a
 * request narrowed to one house keeps the books because the ledger is per workspace.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const books: string[][] = [];
vi.mock("@/lib/reports/queries/ap-reports", () => ({
  queryOwnerStatement: vi.fn(async (_db: unknown, _manager: string, filters: { workspacePropertyIds: string[] }) => {
    books.push(filters.workspacePropertyIds);
    return { id: "owner-statement", title: "Owner Statement", columns: [], rows: [], meta: { distribution: "$100.00" } };
  }),
}));
const held = new Set<string>();
vi.mock("@/lib/owner-management/policies.server", () => ({
  listManagedWorkspacesForOwner: vi.fn(async () => [...held].map((workspaceId) => ({ workspaceId, workspaceName: workspaceId }))),
}));
const ledgerCalls: { workspaceId: string; months: string[] }[] = [];
vi.mock("@/lib/managed-finance/finances.server", () => ({
  loadOwnerMonthlyNets: vi.fn(async (_db: unknown, input: { workspaceId: string; months: string[] }) => {
    ledgerCalls.push({ workspaceId: input.workspaceId, months: input.months });
    return new Map(input.months.map((m, i) => [m, 5_000 * (i + 1)]));
  }),
}));

import type { OwnerGrant } from "@/lib/property-owner/access.server";
import { loadOwnerStatements } from "@/lib/property-owner/summary.server";
import { makeFakeDb } from "./property-owner-fake-db";

const house = (propertyId: string) => ({ propertyId, performance: true, statements: true, documents: false, messages: false });
const grants: OwnerGrant[] = [
  { linkId: "l1", workspaceId: "ws-held", managerUserId: "m1", houses: [house("held-1"), house("held-2")] },
  { linkId: "l2", workspaceId: "ws-plain", managerUserId: "m1", houses: [house("plain-1")] },
];
const db = () => makeFakeDb({});

beforeEach(() => {
  books.length = 0;
  ledgerCalls.length = 0;
  held.clear();
});

describe("owner statements for a PropLane-held workspace", () => {
  it("reads the held workspace from the ledger and the rest from the books, summed per month", async () => {
    held.add("ws-held");
    const out = await loadOwnerStatements(db(), grants, { months: 3, ownerUserId: "owner-1" });
    expect(ledgerCalls).toHaveLength(1);
    expect(ledgerCalls[0]!.workspaceId).toBe("ws-held");
    // The books are asked only about the plain house.
    expect(books.every((ids) => ids.length === 1 && ids[0] === "plain-1")).toBe(true);
    expect(out.rows).toHaveLength(3);
    // Oldest month: ledger 5,000 + books 10,000. Newest: ledger 15,000 + books 10,000.
    expect(out.rows[2]!.distributionCents).toBe(15_000);
    expect(out.rows[0]!.distributionCents).toBe(25_000);
    expect(out.rows[0]!.houses).toBe(3);
  });

  it("keeps the books for a request narrowed to one house", async () => {
    held.add("ws-held");
    const out = await loadOwnerStatements(db(), grants, { months: 2, ownerUserId: "owner-1", propertyId: "held-1" });
    expect(ledgerCalls).toEqual([]);
    expect(books.length).toBe(2);
    expect(out.rows[0]!.distributionCents).toBe(10_000);
  });

  it("is today's behaviour when no owner id is given, or nothing is held", async () => {
    const plain = await loadOwnerStatements(db(), grants, { months: 2 });
    expect(ledgerCalls).toEqual([]);
    expect(plain.rows[0]!.distributionCents).toBe(10_000);
    const none = await loadOwnerStatements(db(), grants, { months: 2, ownerUserId: "owner-1" });
    expect(ledgerCalls).toEqual([]);
    expect(none.rows[0]!.distributionCents).toBe(10_000);
  });
});
