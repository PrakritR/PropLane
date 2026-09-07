/**
 * The staff property-cap override, where it actually bites: `assertManagerPropertyListingQuota`.
 *
 * An override that only showed on an admin screen would be worse than none — staff would comp an
 * account a bigger cap, the manager would still be refused, and the screen would say the cap was
 * lifted. So the same resolver the Billing list reads is the one the server gate reads.
 *
 * The two rules it must not break while doing it:
 *
 * - It gates the TRANSITION INTO a listing slot, never the state of being over the cap. Lowering an
 *   account's cap below what it already holds refuses the NEXT listing and touches nothing that
 *   exists. Block creation; never delete or hide a manager's records.
 * - A cap that cannot be READ is a 500, exactly like a plan that cannot be read. Falling back to
 *   the plan default would refuse a manager staff had explicitly comped a bigger cap, on a
 *   transient database error, with copy telling them to upgrade.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FREE_MAX_PROPERTIES } from "@/lib/manager-access";

let EFFECTIVE_TIER: string | null = "free";
let TIER_READ_ERROR: string | null = null;
let SLOT_ROWS: { id: string; manager_user_id: string; status: string }[] = [];
let SETTINGS_ROW: Record<string, unknown> | null = null;
let SETTINGS_READ_ERROR: { message: string } | null = null;

vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: async () =>
    TIER_READ_ERROR ? { ok: false, error: TIER_READ_ERROR } : { ok: true, tier: EFFECTIVE_TIER },
}));

const { assertManagerPropertyListingQuota } = await import("@/lib/manager-property-quota.server");

/** Just enough of the client for the two reads the gate makes: the settings row and the slot count. */
function makeDb() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const q = {
        select(_cols: string, opts?: { count?: string; head?: boolean }) {
          if (opts?.count) filters.__count = true;
          return q;
        },
        eq(col: string, value: unknown) {
          filters[col] = value;
          return q;
        },
        in(col: string, values: unknown[]) {
          filters[`in:${col}`] = values;
          return q;
        },
        neq(col: string, value: unknown) {
          filters[`neq:${col}`] = value;
          return q;
        },
        async maybeSingle() {
          if (SETTINGS_READ_ERROR) return { data: null, error: SETTINGS_READ_ERROR };
          return { data: SETTINGS_ROW, error: null };
        },
        then(resolve: (v: { count: number | null; error: unknown }) => unknown) {
          const statuses = (filters["in:status"] ?? []) as string[];
          const rows = SLOT_ROWS.filter(
            (r) =>
              r.manager_user_id === filters.manager_user_id &&
              statuses.includes(r.status) &&
              r.id !== filters["neq:id"],
          );
          void table;
          return Promise.resolve({ count: rows.length, error: null }).then(resolve);
        },
      };
      return q;
    },
  } as never;
}

const OWNER = "mgr-1";

function assertQuota(overrides: Partial<{ recordId: string; existingStatus: string | null }> = {}) {
  return assertManagerPropertyListingQuota(makeDb(), {
    ownerUserId: OWNER,
    recordId: overrides.recordId ?? "new-listing",
    nextStatus: "live",
    existingStatus: overrides.existingStatus ?? null,
  });
}

function liveRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, manager_user_id: OWNER, status: "live" }));
}

function withCap(cap: number | null) {
  SETTINGS_ROW = { row_data: cap === null ? {} : { billingOverrides: { propertyCap: cap } } };
}

beforeEach(() => {
  EFFECTIVE_TIER = "free";
  TIER_READ_ERROR = null;
  SLOT_ROWS = [];
  SETTINGS_ROW = null;
  SETTINGS_READ_ERROR = null;
});

describe("with no override, the plan cap is unchanged", () => {
  it("allows the first free listing", async () => {
    expect(await assertQuota()).toEqual({ ok: true });
  });

  it("refuses the second with the plan's own copy", async () => {
    SLOT_ROWS = liveRows(FREE_MAX_PROPERTIES);
    const verdict = await assertQuota();
    expect(verdict).toMatchObject({ ok: false, status: 403, limit: FREE_MAX_PROPERTIES });
    expect((verdict as { error: string }).error).toContain("Free includes");
  });
});

describe("a staff cap override replaces the plan cap", () => {
  it("lifts it: a free account comped 3 publishes a second and a third", async () => {
    withCap(3);
    SLOT_ROWS = liveRows(2);
    expect(await assertQuota()).toEqual({ ok: true });
  });

  it("still refuses once the pinned cap is reached", async () => {
    withCap(3);
    SLOT_ROWS = liveRows(3);
    const verdict = await assertQuota();
    expect(verdict).toMatchObject({ ok: false, status: 403, limit: 3, current: 3 });
  });

  it("does not tell them to upgrade — upgrading would not move a number staff typed", async () => {
    withCap(3);
    SLOT_ROWS = liveRows(3);
    const verdict = (await assertQuota()) as { error: string };
    expect(verdict.error).toContain("limit of 3 properties");
    expect(verdict.error).not.toContain("Upgrade");
    expect(verdict.error).not.toContain("Free includes");
  });

  it("lowers it below a paid plan's cap", async () => {
    EFFECTIVE_TIER = "business";
    withCap(2);
    SLOT_ROWS = liveRows(2);
    expect(await assertQuota()).toMatchObject({ ok: false, status: 403, limit: 2 });
  });

  it("treats 0 as a real cap, refusing every new listing", async () => {
    withCap(0);
    const verdict = (await assertQuota()) as { ok: boolean; error: string };
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("not currently allowed to publish");
  });

  it("caps a legacy account that had no plan limit at all", async () => {
    EFFECTIVE_TIER = null; // legacy / uncapped
    withCap(1);
    SLOT_ROWS = liveRows(1);
    expect(await assertQuota()).toMatchObject({ ok: false, status: 403, limit: 1 });
  });
});

describe("it never costs a manager a record", () => {
  it("leaves an over-cap account free to edit what it already has", async () => {
    // Cap lowered to 1 under an account holding 4: the existing rows are untouched and an ordinary
    // edit of one of them is not re-charged for its slot.
    withCap(1);
    SLOT_ROWS = liveRows(4);
    expect(await assertQuota({ recordId: "p0", existingStatus: "live" })).toEqual({ ok: true });
  });

  it("never charges a draft or an unlisted write", async () => {
    withCap(0);
    expect(
      await assertManagerPropertyListingQuota(makeDb(), {
        ownerUserId: OWNER,
        recordId: "draft-1",
        nextStatus: "draft",
        existingStatus: null,
      }),
    ).toEqual({ ok: true });
  });
});

describe("a cap it could not read", () => {
  it("is a 500, never a silent fall back to the plan default", async () => {
    SETTINGS_READ_ERROR = { message: "boom" };
    expect(await assertQuota()).toMatchObject({ ok: false, status: 500 });
  });

  it("is checked after the plan, so an unreadable plan still reports as one", async () => {
    TIER_READ_ERROR = "Could not read this account's plan.";
    SETTINGS_READ_ERROR = { message: "boom" };
    expect(await assertQuota()).toMatchObject({
      ok: false,
      status: 500,
      error: "Could not read this account's plan.",
    });
  });
});
