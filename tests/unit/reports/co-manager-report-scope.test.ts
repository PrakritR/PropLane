/**
 * `resolveManagerReportScope` decides whose financial books a report reads AND
 * which of that owner's properties the viewer may actually see rows for.
 *
 * It used to resolve ONLY the owner substitution (`resolveManagerReportOwnerId`):
 * a co-manager granted `financials` on a single property was switched to the
 * OWNER's id with no further narrowing, so every report — income statement,
 * balance sheet, trial balance, GL, rent roll — read that owner's books for
 * EVERY house in EVERY workspace. This pins that the grant now also bounds
 * WHICH of the owner's houses the substituted read may cover, via
 * `grantedPropertyIds`, and that `intersectPropertyScopes` folds that set into
 * the workspace scope without ever widening either side.
 */
import { describe, expect, it } from "vitest";

import { intersectPropertyScopes } from "@/lib/reports/workspace-scope";
import { resolveManagerReportScope } from "@/lib/reports/co-manager-report-scope";

const OWNER = "owner-1";
const DELEGATE = "delegate-1";
const HOUSE_1 = "house-1";
const HOUSE_2 = "house-2";
const HOUSE_3 = "house-3";

type LinkRow = {
  inviter_user_id: string;
  assigned_property_ids: string[];
  property_co_manager_permissions?: unknown;
  house_scope?: string;
};

function makeDb(opts: { owned: boolean; linkRows: LinkRow[] }) {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        limit: async () => (table === "manager_property_records" ? { data: opts.owned ? [{ id: "p1" }] : [], error: null } : { data: null, error: null }),
        in: async () => ({
          data: [
            { id: OWNER, email: "owner@test.com" },
            { id: DELEGATE, email: "delegate@test.com" },
          ],
          error: null,
        }),
        maybeSingle: async () => ({ data: { email: "delegate@test.com" }, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(table === "account_link_invites" ? { data: opts.linkRows, error: null } : { data: [], error: null }).then(resolve),
      };
      return builder;
    },
  } as never;
}

describe("resolveManagerReportScope", () => {
  it("a primary owner reads their own books with no additional narrowing", async () => {
    const scope = await resolveManagerReportScope(makeDb({ owned: true, linkRows: [] }), OWNER);
    expect(scope).toEqual({ managerUserId: OWNER, grantedPropertyIds: null });
  });

  it("a co-manager granted financials on ONE of three houses is bounded to that house", async () => {
    const db = makeDb({
      owned: false,
      linkRows: [
        {
          inviter_user_id: OWNER,
          assigned_property_ids: [HOUSE_1, HOUSE_2, HOUSE_3],
          property_co_manager_permissions: { [HOUSE_1]: { financials: { read: true } } },
          house_scope: "selected",
        },
      ],
    });
    const scope = await resolveManagerReportScope(db, DELEGATE);
    expect(scope.managerUserId).toBe(OWNER);
    expect(scope.grantedPropertyIds).toEqual([HOUSE_1]);
  });

  it("an empty grant never substitutes the owner — the co-manager stays on their own (empty) books", async () => {
    const db = makeDb({
      owned: false,
      linkRows: [
        {
          inviter_user_id: OWNER,
          assigned_property_ids: [HOUSE_1, HOUSE_2, HOUSE_3],
          property_co_manager_permissions: {},
          house_scope: "selected",
        },
      ],
    });
    const scope = await resolveManagerReportScope(db, DELEGATE);
    expect(scope.managerUserId).toBe(DELEGATE);
    expect(scope.grantedPropertyIds).toBeNull();
  });

  it("no accepted link at all falls back to the caller's own id", async () => {
    const scope = await resolveManagerReportScope(makeDb({ owned: false, linkRows: [] }), DELEGATE);
    expect(scope).toEqual({ managerUserId: DELEGATE, grantedPropertyIds: null });
  });
});

describe("intersectPropertyScopes", () => {
  it("no narrowing on either side stays unrestricted", () => {
    expect(intersectPropertyScopes(null, null)).toBeNull();
  });

  it("one side narrowing wins when the other is unrestricted", () => {
    expect(intersectPropertyScopes(null, [HOUSE_1])).toEqual([HOUSE_1]);
    expect(intersectPropertyScopes([HOUSE_1], null)).toEqual([HOUSE_1]);
  });

  it("combines two narrowings to their overlap, never their union", () => {
    expect(intersectPropertyScopes([HOUSE_1, HOUSE_2], [HOUSE_2, HOUSE_3])).toEqual([HOUSE_2]);
  });

  it("an empty grant intersected with an open workspace still covers nothing", () => {
    expect(intersectPropertyScopes([HOUSE_1, HOUSE_2], [])).toEqual([]);
    expect(intersectPropertyScopes([], [HOUSE_1])).toEqual([]);
  });
});
