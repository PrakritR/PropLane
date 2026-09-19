import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HouseholdCharge } from "@/lib/household-charges";

/**
 * Route-level coverage for POST /api/admin/backfill-ledger: the one-time
 * historical sweep restored per the "ledger-backfill-removed-no-migration"
 * review decision. Exercises the real handler + backfillLedgerFromCharges
 * against an in-memory Supabase fake so gating, the synced count, and the
 * real removedDuplicates count (not a hardcoded 0) are all observable.
 */

type Row = Record<string, unknown>;

function makeFakeDb(tables: Record<string, Row[]>) {
  let ledgerIdSeq = 1000;

  function builder(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    const filters: ((row: Row) => boolean)[] = [];
    let op: "select" | "delete" = "select";
    let orderBy: string | null = null;
    let rangeArg: [number, number] | null = null;

    const api = {
      select() {
        return api;
      },
      delete() {
        op = "delete";
        return api;
      },
      insert(newRows: Row | Row[]) {
        const list = Array.isArray(newRows) ? newRows : [newRows];
        for (const row of list) {
          rows.push({ id: row.id ?? `le-${ledgerIdSeq++}`, ...row });
        }
        return Promise.resolve({ data: null, error: null });
      },
      upsert(newRows: Row | Row[]) {
        const list = Array.isArray(newRows) ? newRows : [newRows];
        for (const row of list) {
          const idx = rows.findIndex((r) => r.id === row.id);
          if (idx === -1) rows.push({ id: row.id ?? `le-${ledgerIdSeq++}`, ...row });
          else rows[idx] = { ...rows[idx], ...row };
        }
        return Promise.resolve({ data: null, error: null });
      },
      eq(col: string, value: unknown) {
        filters.push((row) => row[col] === value);
        return api;
      },
      in(col: string, values: unknown[]) {
        filters.push((row) => values.includes(row[col]));
        return api;
      },
      order(col: string) {
        orderBy = col;
        return api;
      },
      range(from: number, to: number) {
        rangeArg = [from, to];
        return api;
      },
      maybeSingle() {
        const data = rows.filter((row) => filters.every((f) => f(row)))[0] ?? null;
        return Promise.resolve({ data, error: null });
      },
      then(resolve: (value: { data: Row[] | null; error: null }) => unknown) {
        if (op === "delete") {
          for (let i = rows.length - 1; i >= 0; i--) {
            if (filters.every((f) => f(rows[i]!))) rows.splice(i, 1);
          }
          return Promise.resolve(resolve({ data: null, error: null }));
        }
        let data = rows.filter((row) => filters.every((f) => f(row)));
        if (orderBy) {
          const col = orderBy;
          data = [...data].sort((a, b) => String(a[col]).localeCompare(String(b[col])));
        }
        if (rangeArg) data = data.slice(rangeArg[0], rangeArg[1] + 1);
        return Promise.resolve(resolve({ data, error: null }));
      },
    };
    return api;
  }

  return { from: builder, tables };
}

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  adminIds: new Set<string>(),
  db: null as unknown,
  portalSessionViewerId: vi.fn(() => {
    throw new Error("A server route must not read client portal session state while its module is collected.");
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
}));

vi.mock("@/lib/auth/admin-preview", () => ({
  isAdminUser: async (userId: string) => state.adminIds.has(userId),
}));

vi.mock("@/lib/auth/portal-session-gate", () => ({
  notePortalResponse: vi.fn(),
  onPortalSessionViewerChange: vi.fn(),
  portalSessionEnded: vi.fn(() => false),
  portalSessionViewerId: state.portalSessionViewerId,
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => state.db,
}));

const MANAGER_ID = "3b9c2c65-6f0f-4d3a-9a3e-0b7f6f8a1c2d";
const ADMIN_ID = "9d1f0a2b-1111-4222-8333-444455556666";

function seedCharges(): Record<string, Row[]> {
  const rent: HouseholdCharge = {
    id: "hc-rent-1",
    createdAt: "2026-06-01T00:00:00.000Z",
    residentEmail: "res@test.com",
    residentName: "Res Ident",
    residentUserId: null,
    propertyId: "prop-1",
    propertyLabel: "Unit 1",
    managerUserId: MANAGER_ID,
    kind: "rent",
    title: "Monthly rent",
    amountLabel: "$1,200.00",
    balanceLabel: "$1,200.00",
    status: "pending",
    blocksLeaseUntilPaid: false,
    rentMonth: "2026-06",
  };
  const canonicalFee: HouseholdCharge = {
    ...rent,
    id: "hc_app_fee_app123",
    applicationId: "app123",
    kind: "application_fee",
    title: "Application fee",
    amountLabel: "$50.00",
    balanceLabel: "$0.00",
    status: "paid",
    paidAt: "2026-06-02T00:00:00.000Z",
    rentMonth: undefined,
  };
  // Legacy fallback row for the same fee (same resident + property, no
  // applicationId linkage) — the duplicate the sweep must remove.
  const fallbackFee: HouseholdCharge = {
    ...canonicalFee,
    id: "hc_app_fee_res_test_com_prop_1",
    applicationId: undefined,
    createdAt: "2026-05-30T00:00:00.000Z",
  };

  return {
    portal_household_charge_records: [
      { id: rent.id, manager_user_id: MANAGER_ID, row_data: rent },
      { id: canonicalFee.id, manager_user_id: MANAGER_ID, row_data: canonicalFee },
      { id: fallbackFee.id, manager_user_id: MANAGER_ID, row_data: fallbackFee },
    ],
    ledger_entries: [
      // Stale entry pointing at the duplicate row — must be deleted so income
      // is not double-counted.
      {
        id: "le-stale",
        manager_user_id: MANAGER_ID,
        source_charge_id: fallbackFee.id,
        entry_type: "charge",
        amount_cents: 5000,
      },
    ],
  };
}

describe("POST /api/admin/backfill-ledger", () => {
  beforeEach(() => {
    state.user = null;
    state.adminIds = new Set([ADMIN_ID]);
    state.db = makeFakeDb(seedCharges());
    vi.clearAllMocks();
    vi.resetModules();
  });

  function post(body?: unknown) {
    return import("@/app/api/admin/backfill-ledger/route").then(({ POST }) =>
      POST(
        new Request("https://example.com/api/admin/backfill-ledger", {
          method: "POST",
          ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
        }),
      ),
    );
  }

  it("collects without evaluating client portal session state", async () => {
    const { runtime } = await import("@/app/api/admin/backfill-ledger/route");
    expect(runtime).toBe("nodejs");
    expect(state.portalSessionViewerId).not.toHaveBeenCalled();
  });

  it("rejects anonymous callers with 401", async () => {
    const res = await post();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized." });
  });

  it("rejects signed-in non-admins with 403 and leaves data untouched", async () => {
    state.user = { id: MANAGER_ID };
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden." });
    const db = state.db as ReturnType<typeof makeFakeDb>;
    expect(db.tables.portal_household_charge_records).toHaveLength(3);
    expect(db.tables.ledger_entries).toHaveLength(1);
  });

  it("rejects a non-uuid managerUserId with 400 before touching any data", async () => {
    state.user = { id: ADMIN_ID };
    const res = await post({ managerUserId: "mgr-1'; DROP TABLE ledger_entries;--" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "managerUserId must be a uuid." });
    const db = state.db as ReturnType<typeof makeFakeDb>;
    expect(db.tables.portal_household_charge_records).toHaveLength(3);
    expect(db.tables.ledger_entries).toHaveLength(1);
  });

  it("sweeps charges into the ledger for admins and reports the real duplicates-removed count", async () => {
    state.user = { id: ADMIN_ID };
    const res = await post({});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, synced: 2, removedDuplicates: 1 });

    const db = state.db as ReturnType<typeof makeFakeDb>;
    // Duplicate fallback fee row and its stale ledger entry are gone.
    const chargeIds = db.tables.portal_household_charge_records!.map((r) => r.id);
    expect(chargeIds.sort()).toEqual(["hc-rent-1", "hc_app_fee_app123"]);
    expect(db.tables.ledger_entries!.some((r) => r.source_charge_id === "hc_app_fee_res_test_com_prop_1")).toBe(false);

    // Pending rent → one charge entry; paid app fee → charge + payment entries.
    const byKey = new Map(
      db.tables.ledger_entries!.map((r) => [`${r.source_charge_id}:${r.entry_type}`, r]),
    );
    expect([...byKey.keys()].sort()).toEqual([
      "hc-rent-1:charge",
      "hc_app_fee_app123:charge",
      "hc_app_fee_app123:payment",
    ]);
    expect(byKey.get("hc-rent-1:charge")).toMatchObject({ amount_cents: 120000, manager_user_id: MANAGER_ID });
    expect(byKey.get("hc_app_fee_app123:payment")).toMatchObject({ amount_cents: 5000 });
  });
});
