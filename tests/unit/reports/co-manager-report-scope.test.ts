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
import { beforeEach, describe, expect, it, vi } from "vitest";

import { intersectPropertyScopes } from "@/lib/reports/workspace-scope";
import { resolveManagerReportScope } from "@/lib/reports/co-manager-report-scope";

vi.mock("@/lib/service/service-mode.server", () => ({ loadServiceStaffScope: vi.fn() }));
vi.mock("@/lib/scope/settings-scope", () => ({ serviceStaffSettingsAccess: vi.fn() }));
import { loadServiceStaffScope } from "@/lib/service/service-mode.server";
import { serviceStaffSettingsAccess } from "@/lib/scope/settings-scope";

beforeEach(() => {
  vi.mocked(loadServiceStaffScope).mockReset().mockResolvedValue(null);
  vi.mocked(serviceStaffSettingsAccess).mockReset();
});

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
  it("managed staff read the selected owner's books even when they own houses or an admin selector names another owner", async () => {
    vi.mocked(loadServiceStaffScope).mockResolvedValue({ workspaceId: "managed", propertyIds: [HOUSE_1] });
    vi.mocked(serviceStaffSettingsAccess).mockResolvedValue({ kind: "ok", ownerUserId: OWNER, fullGrant: true });
    const scope = await resolveManagerReportScope(makeDb({ owned: true, linkRows: [] }), DELEGATE, { adminManagerUserId: "other-owner" });
    expect(scope).toEqual({ managerUserId: OWNER, grantedPropertyIds: [HOUSE_1] });
    expect(serviceStaffSettingsAccess).toHaveBeenCalledWith(expect.anything(), DELEGATE, "managed", "read");
  });

  it("limited staff need a financials grant inside the active workspace", async () => {
    vi.mocked(loadServiceStaffScope).mockResolvedValue({ workspaceId: "managed", propertyIds: [HOUSE_1, HOUSE_2] });
    vi.mocked(serviceStaffSettingsAccess).mockResolvedValue({ kind: "ok", ownerUserId: OWNER, fullGrant: false });
    const db = makeDb({ owned: true, linkRows: [{ inviter_user_id: OWNER,
      assigned_property_ids: [HOUSE_1, HOUSE_2, HOUSE_3], house_scope: "selected",
      property_co_manager_permissions: { [HOUSE_1]: { financials: { read: true } }, [HOUSE_3]: { financials: { read: true } } },
    }] });
    expect(await resolveManagerReportScope(db, DELEGATE)).toEqual({ managerUserId: OWNER, grantedPropertyIds: [HOUSE_1] });
  });

  it("staff without a financials grant get no properties", async () => {
    vi.mocked(loadServiceStaffScope).mockResolvedValue({ workspaceId: "managed", propertyIds: [HOUSE_1] });
    vi.mocked(serviceStaffSettingsAccess).mockResolvedValue({ kind: "ok", ownerUserId: OWNER, fullGrant: false });
    expect(await resolveManagerReportScope(makeDb({ owned: true, linkRows: [] }), DELEGATE))
      .toEqual({ managerUserId: OWNER, grantedPropertyIds: [] });
  });

  it("an empty managed workspace never falls back to all owner properties", async () => {
    vi.mocked(loadServiceStaffScope).mockResolvedValue({ workspaceId: "managed", propertyIds: [] });
    vi.mocked(serviceStaffSettingsAccess).mockResolvedValue({ kind: "ok", ownerUserId: OWNER, fullGrant: true });
    expect(await resolveManagerReportScope(makeDb({ owned: true, linkRows: [] }), DELEGATE))
      .toEqual({ managerUserId: OWNER, grantedPropertyIds: [] });
  });

  it.each(["none", "unavailable", "read_only"] as const)("refuses unresolved staff access: %s", async (kind) => {
    vi.mocked(loadServiceStaffScope).mockResolvedValue({ workspaceId: "managed", propertyIds: [HOUSE_1] });
    vi.mocked(serviceStaffSettingsAccess).mockResolvedValue({ kind });
    await expect(resolveManagerReportScope(makeDb({ owned: true, linkRows: [] }), DELEGATE))
      .rejects.toThrow("Could not verify financial access");
  });

  it("preserves an authenticated admin's explicit selector outside service mode", async () => {
    expect(await resolveManagerReportScope(makeDb({ owned: true, linkRows: [] }), DELEGATE, { adminManagerUserId: OWNER }))
      .toEqual({ managerUserId: OWNER, grantedPropertyIds: null });
  });


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
