import { beforeEach, describe, expect, it, vi } from "vitest";
import { leaseRecordVisibleToManager, managerMayFileLeaseUnderProperty } from "@/lib/auth/manager-lease-scope";

describe("manager-lease-scope", () => {
  it("shows own manager records", () => {
    expect(leaseRecordVisibleToManager({ manager_user_id: "u1", property_id: "p1" }, "u1", new Set())).toBe(true);
  });

  it("shows linked property records", () => {
    expect(
      leaseRecordVisibleToManager({ manager_user_id: "u2", property_id: "p1" }, "u1", new Set(["p1"])),
    ).toBe(true);
    expect(
      leaseRecordVisibleToManager({ manager_user_id: "u2", property_id: "p2" }, "u1", new Set(["p1"])),
    ).toBe(false);
  });
});

/**
 * Filing or MOVING a lease under a property is a write, so the gate is the
 * `leases` grant at EDIT level: wider than direct ownership (a real co-manager
 * flow), narrower than bare link membership (which would let a co-manager write
 * a row they are not allowed to read back). An assignment with no checked
 * permissions is still a full grant, so the ordinary co-manager is unaffected.
 */
describe("managerMayFileLeaseUnderProperty", () => {
  const MANAGER = "manager-1";

  type LinkRow = {
    inviter_user_id: string;
    assigned_property_ids: string[];
    property_co_manager_permissions?: unknown;
  };

  let ownedIds: string[] = [];
  /** Property records that EXIST but belong to another manager. */
  let foreignIds: string[] = [];
  let linkRows: LinkRow[] = [];
  let ownershipError: { message: string } | null = null;

  /** Only the surface this helper and collectLinkedPropertyIdsForUser touch. */
  function makeDb() {
    return {
      from(table: string) {
        const filters: Array<[string, unknown]> = [];
        const builder: Record<string, unknown> = {
          select: () => builder,
          in: () => builder,
          eq: (column: string, value: unknown) => {
            filters.push([column, value]);
            if (table === "account_link_invites" && filters.length === 2) {
              return Promise.resolve({ data: linkRows, error: null });
            }
            return builder;
          },
          maybeSingle() {
            if (table === "profiles") return Promise.resolve({ data: { email: "manager@example.com" }, error: null });
            if (table === "manager_property_records") {
              if (ownershipError) return Promise.resolve({ data: null, error: ownershipError });
              const id = String(filters.find(([column]) => column === "id")?.[1] ?? "");
              if (ownedIds.includes(id)) {
                return Promise.resolve({ data: { id, manager_user_id: MANAGER }, error: null });
              }
              if (foreignIds.includes(id)) {
                return Promise.resolve({ data: { id, manager_user_id: "other-manager" }, error: null });
              }
              return Promise.resolve({ data: null, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
          then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
            return Promise.resolve({ data: [], error: null }).then(resolve, reject);
          },
        };
        return builder;
      },
    };
  }

  const check = (propertyId: string) =>
    managerMayFileLeaseUnderProperty(makeDb() as never, MANAGER, propertyId);

  function linkedWith(permissions?: unknown): LinkRow[] {
    return [
      {
        inviter_user_id: "other-manager",
        assigned_property_ids: ["prop-linked"],
        property_co_manager_permissions: permissions,
      },
    ];
  }

  beforeEach(() => {
    ownedIds = [];
    foreignIds = [];
    linkRows = [];
    ownershipError = null;
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("allows a property the manager owns directly", async () => {
    ownedIds = ["prop-own"];
    expect(await check("prop-own")).toEqual({ ok: true, allowed: true, propertyExists: true });
  });

  it("allows a co-manager holding the leases grant at edit level", async () => {
    foreignIds = ["prop-linked"];
    linkRows = linkedWith({ "prop-linked": { leases: { read: true, edit: true } } });
    expect(await check("prop-linked")).toEqual({ ok: true, allowed: true, propertyExists: true });
  });

  it("refuses a co-manager whose assignment has no checked permissions", async () => {
    // Empty used to mean FULL — the PRP-199 sentinel. Assigning a property is
    // not itself the grant, so filing a lease under it needs `leases` at edit.
    foreignIds = ["prop-linked"];
    linkRows = linkedWith(undefined);
    expect(await check("prop-linked")).toEqual({ ok: true, allowed: false, propertyExists: true });
  });

  it("refuses a co-manager with read-only leases access — filing a lease is a write", async () => {
    foreignIds = ["prop-linked"];
    linkRows = linkedWith({ "prop-linked": { leases: { read: true } } });
    expect(await check("prop-linked")).toEqual({ ok: true, allowed: false, propertyExists: true });
  });

  it("refuses a co-manager whose explicit permissions omit leases entirely", async () => {
    foreignIds = ["prop-linked"];
    linkRows = linkedWith({ "prop-linked": { payments: { read: true, edit: true } } });
    expect(await check("prop-linked")).toEqual({ ok: true, allowed: false, propertyExists: true });
  });

  it("refuses a property owned by another manager and not linked", async () => {
    ownedIds = ["prop-own"];
    foreignIds = ["prop-stranger"];
    linkRows = linkedWith({ "prop-linked": { leases: true } });
    expect(await check("prop-stranger")).toEqual({ ok: true, allowed: false, propertyExists: true });
  });

  /**
   * "Not allowed" and "provably someone else's" are different answers. A
   * deleted listing — and any id that was never persisted as a property record
   * — has no row at all, and the route must be able to tell that apart so an
   * ordinary lease save is not 403'd.
   */
  it("reports an absent property record as not-existing rather than someone else's", async () => {
    ownedIds = ["prop-own"];
    expect(await check("prop-deleted")).toEqual({ ok: true, allowed: false, propertyExists: false });
  });

  it("still honors a linked grant when the property record cannot be read back", async () => {
    linkRows = linkedWith({ "prop-linked": { leases: { read: true, edit: true } } });
    expect(await check("prop-linked")).toEqual({ ok: true, allowed: true, propertyExists: false });
  });

  it("refuses an empty id without a lookup", async () => {
    expect(await check("  ")).toEqual({ ok: true, allowed: false, propertyExists: false });
  });

  it("fails closed and logs when the ownership read errors", async () => {
    ownershipError = { message: "connection reset" };
    expect(await check("prop-own")).toEqual({ ok: false, error: "connection reset" });
    expect(console.error).toHaveBeenCalled();
  });

  /** The co-manager-only path: a swallowed linked-read failure must still be correlatable. */
  it("logs the refusal so a co-manager 403 is not silent", async () => {
    foreignIds = ["prop-linked"];
    linkRows = linkedWith({ "prop-linked": { leases: { read: true } } });
    expect(await check("prop-linked")).toEqual({ ok: true, allowed: false, propertyExists: true });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Lease property filing refused"),
      expect.objectContaining({ userId: MANAGER, propertyId: "prop-linked" }),
    );
  });
});
