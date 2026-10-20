/**
 * The filing year is a PACIFIC calendar year, and the window that defines it is now applied in exactly two
 * places: the SQL read (`readPartyLines`'s `fromIso`/`toIso`) and `buildTaxPackage`. A third copy as a JS
 * `.filter()` over the same rows was a no-op that left three spellings of one rule to keep in agreement.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readPartyLines: vi.fn(),
  listPolicies: vi.fn(),
  display: vi.fn(),
}));

vi.mock("@/lib/managed-finance/ledger.server", async (original) => ({
  ...(await original<typeof import("@/lib/managed-finance/ledger.server")>()),
  readPartyLines: mocks.readPartyLines,
}));
vi.mock("@/lib/owner-management/policies.server", async (original) => ({
  ...(await original<typeof import("@/lib/owner-management/policies.server")>()),
  listPoliciesForWorkspace: mocks.listPolicies,
}));
vi.mock("@/lib/reports/display-context", () => ({ loadManagerReportDisplayContext: mocks.display }));

import { loadOwnerTaxPackage } from "@/lib/managed-finance/tax-package.server";
import { pacificMonthStartIso } from "@/lib/owner-management/fee-math";

const OWNER = "own-1";
const WS = "ws-1";

const rentLine = (postedAt: string, cents: number) => ({
  journalId: `j-${postedAt}`,
  account: "owner_payable" as const,
  partyId: `owner:${OWNER}`,
  workspaceId: WS,
  amountCents: -cents,
  availableOn: null,
  postedAt,
  kind: "rent_capture",
  detail: { charges: [{ property_id: "p1", owner_cents: cents, fee_cents: 0 }] },
  sourceType: null,
  sourceId: null,
});

function db() {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            gte: () => ({ lt: () => ({ order: () => ({ order: () => ({ range: async () => ({ data: [], error: null }) }) }) }) }),
          }),
          in: async () => ({ data: [], error: null }),
          maybeSingle: async () => ({ data: table === "portal_workspaces" ? { owner_user_id: "mgr-1" } : null, error: null }),
        }),
      }),
    }),
  } as never;
}

describe("the owner tax package's Pacific year", () => {
  it("asks the ledger for the Pacific window and keeps every row it returns", async () => {
    mocks.listPolicies.mockResolvedValue([{ ownerUserId: OWNER, signedAt: "2026-01-01T00:00:00Z" }]);
    mocks.display.mockResolvedValue(null);
    // 2026-12-31 21:00 Pacific is 2027-01-01T05:00Z: inside the Pacific year, outside a UTC-string year end.
    mocks.readPartyLines.mockResolvedValue([rentLine("2027-01-01T05:00:00.000Z", 150_000)]);

    const view = await loadOwnerTaxPackage(db(), { ownerUserId: OWNER, workspaceId: WS, year: 2026 });

    expect(mocks.readPartyLines).toHaveBeenCalledWith(expect.anything(), {
      account: "owner_payable",
      partyId: `owner:${OWNER}`,
      workspaceId: WS,
      fromIso: pacificMonthStartIso("2026-01"),
      toIso: pacificMonthStartIso("2027-01"),
    });
    expect(view.package.totals.rentsReceivedCents).toBe(150_000);
  });

  it("leaves the windowing to the SQL read and buildTaxPackage, with no duplicate JS filter", () => {
    const source = readFileSync("src/lib/managed-finance/tax-package.server.ts", "utf8");
    expect(source).not.toContain("l.postedAt >= fromIso");
    expect(source).toContain("fromIso, toIso");
  });
});
