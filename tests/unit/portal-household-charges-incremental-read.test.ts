/**
 * Plan load-followups-1007, item 3 — `GET /api/portal-household-charges?updatedSince=`.
 * The window only ever narrows what the viewer's scope already allows; an invalid watermark falls
 * back to the full read; scope/auth run before any read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Call = { table: string; filters: Array<[string, string, unknown]>; limit: number | null };

const getUser = vi.fn();
const fetchRowsForManagerWithLinked = vi.fn(async (): Promise<Row[]> => []);

const state = {
  role: "manager" as "manager" | "resident",
  calls: [] as Call[],
  /** rows returned per call number; defaults to `rows` */
  rows: [] as Row[],
  profileRows: [] as Row[],
  chargeRowOverride: null as null | ((call: Call) => Row[]),
  tablesRead: [] as string[],
};

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerHasCoManagerPermissionForProperty: async () => false,
}));
vi.mock("@/lib/auth/co-manager-module-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/co-manager-module-scope")>();
  return {
    ...actual,
    fetchRowsForManagerWithLinked: (...a: unknown[]) => fetchRowsForManagerWithLinked(...(a as [])),
    linkedPropertyIdsForModule: async () => new Set<string>(["prop-linked"]),
    resolveManagerWorkspaceRowScope: async () => ({ propertyIds: null, untaggedOwnedVisible: true }),
  };
});
vi.mock("@/lib/household-charge-payment-eligibility.server", () => ({
  enrichHouseholdChargesFromPropertyRecords: async (_db: unknown, charges: unknown[]) => charges,
}));
vi.mock("@/lib/payment-reminder-lifecycle.server", () => ({
  cancelFuturePaymentRemindersForCharge: async () => undefined,
  restoreFuturePaymentRemindersForCharge: async () => undefined,
}));
vi.mock("@/lib/payment-automation-settings", () => ({
  DEFAULT_MANAGER_AUTOMATION_SETTINGS: {},
  loadManagerAutomationSettings: async () => ({}),
}));
vi.mock("@/lib/payment-reminder-bootstrap", () => ({
  ensureChargeDueDateForReminders: (charge: unknown) => charge,
}));
vi.mock("@/lib/reports/ledger-sync", () => ({
  deleteLedgerEntriesForCharge: async () => undefined,
  householdChargeLedgerFingerprint: () => "fp",
  reconcileDuplicateChargeList: async () => undefined,
  syncLedgerChargeEntry: async () => undefined,
  syncLedgerPaymentEntry: async () => undefined,
}));
vi.mock("@/lib/domain-action-events.server", () => ({ emitHouseholdChargeTransition: async () => undefined }));
vi.mock("@/lib/payments/property-payout-owner.server", () => ({
  resolvePropertyPayoutOwners: async () => new Map(),
}));

function readChain(table: string, rowsFor: (call: Call) => Row[]) {
  const call: Call = { table, filters: [], limit: null };
  const chain: Record<string, unknown> = {
    select: () => chain,
    order: () => chain,
    limit: (n: number) => {
      call.limit = n;
      return chain;
    },
    or: (clause: string) => {
      call.filters.push(["or", "", clause]);
      return chain;
    },
    gte: (column: string, value: unknown) => {
      call.filters.push(["gte", column, value]);
      return chain;
    },
    then: (resolve: (value: unknown) => unknown) => {
      state.calls.push(call);
      return Promise.resolve({ data: rowsFor(call), error: null }).then(resolve);
    },
  };
  return chain;
}

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from(table: string) {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { email: "viewer@test.local", role: state.role } }) }),
          }),
        };
      }
      if (table === "profile_roles") {
        return { select: () => ({ eq: async () => ({ data: [{ role: state.role }] }) }) };
      }
      if (table === "portal_recurring_rent_profile_records") {
        state.tablesRead.push(table);
        return readChain(table, () => state.profileRows);
      }
      if (table === "portal_household_charge_records") {
        state.tablesRead.push(table);
        return readChain(table, (call) => (state.chargeRowOverride ? state.chargeRowOverride(call) : state.rows));
      }
      throw new Error(`unexpected table: ${table}`);
    },
  }),
}));

const VIEWER_ID = "11111111-1111-4111-8111-111111111111";
const { GET } = await import("@/app/api/portal-household-charges/route");

const request = (query = "") => new Request(`http://localhost/api/portal-household-charges${query}`);
const chargeCalls = () => state.calls.filter((call) => call.table === "portal_household_charge_records");
const profileCalls = () => state.calls.filter((call) => call.table === "portal_recurring_rent_profile_records");
const gtes = (call: Call) => call.filters.filter(([kind]) => kind === "gte");
const row = (id: string, updatedAt: string): Row => ({
  id,
  manager_user_id: VIEWER_ID,
  updated_at: updatedAt,
  row_data: { id, status: "pending" },
});

beforeEach(() => {
  state.role = "manager";
  state.calls = [];
  state.rows = [row("chg-1", "2026-10-07T12:00:00.000Z")];
  state.profileRows = [];
  state.chargeRowOverride = null;
  state.tablesRead = [];
  fetchRowsForManagerWithLinked.mockReset();
  fetchRowsForManagerWithLinked.mockResolvedValue([]);
  getUser.mockReset();
  getUser.mockResolvedValue({ data: { user: { id: VIEWER_ID, email: "viewer@test.local", user_metadata: {} } } });
});

describe("GET /api/portal-household-charges incremental read", () => {
  it("without the param: full read, no time filter, no incremental flag, plus a syncedAt", async () => {
    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(chargeCalls()).toHaveLength(1);
    expect(gtes(chargeCalls()[0]!)).toEqual([]);
    expect(gtes(profileCalls()[0]!)).toEqual([]);
    expect(body.incremental).toBeUndefined();
    expect(Number.isFinite(Date.parse(body.syncedAt))).toBe(true);
    expect(Object.keys(body).sort()).toEqual(["charges", "rentProfiles", "syncedAt", "viewerRole"]);
    expect(chargeCalls()[0]!.limit).toBe(2000);
    expect(profileCalls()[0]!.limit).toBe(500);
  });

  it("GET() with no request object is the full read", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(gtes(chargeCalls()[0]!)).toEqual([]);
  });

  it("applies updated_at >= updatedSince - 2s to charges and rent profiles, on top of the scope", async () => {
    const since = "2026-10-07T11:59:00.000Z";
    const before = Date.now();
    const res = await GET(request(`?updatedSince=${encodeURIComponent(since)}`));
    const body = await res.json();
    const after = Date.now();

    const cutoff = "2026-10-07T11:58:58.000Z";
    expect(body.incremental).toBe(true);
    expect(gtes(chargeCalls()[0]!)).toEqual([["gte", "updated_at", cutoff]]);
    expect(gtes(profileCalls()[0]!)).toEqual([["gte", "updated_at", cutoff]]);
    // The scope clause is still applied.
    expect(chargeCalls()[0]!.filters.some(([kind, , value]) => kind === "or" && String(value).includes(VIEWER_ID))).toBe(true);
    // syncedAt is taken before the read, inside the request window.
    expect(Date.parse(body.syncedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(body.syncedAt)).toBeLessThanOrEqual(after);
  });

  it("scopes a resident the same way and only narrows it", async () => {
    state.role = "resident";
    const res = await GET(request(`?updatedSince=${encodeURIComponent("2026-10-07T11:59:00.000Z")}`));
    const body = await res.json();
    expect(body.incremental).toBe(true);
    const filters = chargeCalls()[0]!.filters;
    expect(filters.some(([kind, , value]) => kind === "or" && String(value).includes("resident_email.eq.viewer@test.local"))).toBe(true);
    expect(gtes(chargeCalls()[0]!)).toHaveLength(1);
  });

  it.each([
    ["not a date", "?updatedSince=banana"],
    ["empty", "?updatedSince="],
    ["date without time", "?updatedSince=2026-10-07"],
    ["a number", "?updatedSince=12345"],
    ["far in the future", `?updatedSince=${encodeURIComponent("2099-01-01T00:00:00.000Z")}`],
    ["before 2000", `?updatedSince=${encodeURIComponent("1970-01-01T00:00:00.000Z")}`],
    ["impossible calendar date", `?updatedSince=${encodeURIComponent("2026-13-45T99:99:99Z")}`],
  ])("ignores an invalid updatedSince (%s) and answers with the full read", async (_label, query) => {
    const res = await GET(request(query));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.incremental).toBeUndefined();
    expect(gtes(chargeCalls()[0]!)).toEqual([]);
    expect(gtes(profileCalls()[0]!)).toEqual([]);
  });

  it("narrows co-manager linked rows to the same window", async () => {
    fetchRowsForManagerWithLinked.mockResolvedValue([
      row("linked-old", "2026-10-07T11:00:00.000Z"),
      row("linked-new", "2026-10-07T11:59:30.000Z"),
      { id: "linked-no-stamp", row_data: { id: "linked-no-stamp" }, updated_at: null },
    ]);
    state.rows = [];
    const res = await GET(request(`?updatedSince=${encodeURIComponent("2026-10-07T11:59:00.000Z")}`));
    const body = await res.json();
    expect(body.charges.map((charge: { id: string }) => charge.id)).toEqual(["linked-new"]);

    // Without the param every linked row is returned, as before.
    const full = await (await GET(request())).json();
    expect(full.charges.map((charge: { id: string }) => charge.id).sort()).toEqual(["linked-new", "linked-no-stamp", "linked-old"]);
  });

  it("falls back to the full read when the incremental window fills the row cap", async () => {
    state.chargeRowOverride = (call) =>
      gtes(call).length > 0
        ? Array.from({ length: 2000 }, (_, i) => row(`chg-${i}`, "2026-10-07T12:00:00.000Z"))
        : [row("chg-1", "2026-10-07T12:00:00.000Z")];
    const res = await GET(request(`?updatedSince=${encodeURIComponent("2026-10-07T11:59:00.000Z")}`));
    const body = await res.json();
    expect(body.incremental).toBeUndefined();
    expect(body.charges).toHaveLength(1);
    expect(chargeCalls().map((call) => gtes(call).length)).toEqual([1, 0]);
  });

  it("refuses an unauthenticated caller before reading anything", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const res = await GET(request(`?updatedSince=${encodeURIComponent("2026-10-07T11:59:00.000Z")}`));
    expect(res.status).toBe(401);
    expect(state.tablesRead).toEqual([]);
  });
});
