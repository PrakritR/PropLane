/**
 * The Statements page asks for a year of months at once.
 *
 * `loadOwnerStatements` used to run `queryOwnerStatement` once per month per
 * manager inside a nested `for await` loop — 12 (24 at the cap) serial round
 * trips of three reads each for one page load. This pins the months in flight
 * together so a later refactor cannot quietly re-serialize them.
 */
import { describe, expect, it, vi } from "vitest";

let inFlight = 0;
let maxInFlight = 0;
let calls = 0;

vi.mock("@/lib/reports/queries/ap-reports", () => ({
  queryOwnerStatement: vi.fn(async () => {
    calls += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return { id: "owner-statement", title: "Owner Statement", columns: [], rows: [], meta: { distribution: "$1,200.00" } };
  }),
}));

import type { OwnerGrant } from "@/lib/property-owner/access.server";
import { loadOwnerStatements } from "@/lib/property-owner/summary.server";
import { makeFakeDb } from "./property-owner-fake-db";

const MANAGER = "manager-1";

const grants: OwnerGrant[] = [
  {
    linkId: "link-1",
    managerUserId: MANAGER,
    houses: [{ propertyId: "house-a", performance: false, statements: true, documents: false, messages: false }],
  },
];

describe("loadOwnerStatements", () => {
  it("runs every month at once, not one after another", async () => {
    const db = makeFakeDb({ manager_property_records: [{ id: "house-a", manager_user_id: MANAGER }] });
    const out = await loadOwnerStatements(db, grants, { months: 12 });
    expect(calls).toBe(12);
    expect(out.rows).toHaveLength(12);
    expect(maxInFlight).toBe(12);
    // Newest month first, each month carrying the statement's distribution.
    expect(out.rows[0]!.month > out.rows[11]!.month).toBe(true);
    expect(out.rows[0]!.distributionCents).toBe(120_000);
  });
});
