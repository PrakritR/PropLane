import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";

/**
 * Server-owned withdrawal stamp on POST /api/manager-applications.
 *
 * The manager panel mirrors its whole cached row into this route, and the same
 * write provisions the resident account once the row lands in `approved`. So a
 * manager whose panel went stale before the resident withdrew would otherwise
 * (a) erase `withdrawnAt` from the stored blob and (b) provision the account for
 * someone who explicitly pulled out — making every downstream check that reads
 * that blob fail with it. `withdrawnAt` is therefore re-anchored from the STORED
 * row, and an approve on a withdrawn record is refused outright.
 */

const getUser = vi.fn();
let PROFILE: { role: string; email: string } | null;
let WITHDRAW_BEFORE_UPDATE = false;
let STORED_ROWS: { id: string; row_data: DemoApplicantRow }[];
let STORED_ERROR: { message: string } | null;
let UPSERTS: { id: string; row_data: DemoApplicantRow }[];
/** Sizes of every `.in("id", …)` filter sent to manager_application_records. */
let ID_FILTER_SIZES: number[];
const provisionApprovedResidentAccount = vi.fn(async () => ({ ok: true }));

vi.mock("@/lib/auth/guest-application-upsert", () => ({
  prepareGuestApplicationUpsert: vi.fn(),
}));
vi.mock("@/lib/auth/link-resident-on-application-submit", () => ({
  linkResidentOnApplicationSubmit: vi.fn(async (_db: unknown, args: { row: DemoApplicantRow }) => ({
    ok: true,
    row: args.row,
  })),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => true) }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerHasCoManagerPermissionForProperty: vi.fn(async () => true),
}));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  linkedOwnerForProperty: vi.fn(async () => null),
  linkedPropertyIdsForModule: vi.fn(async () => []),
}));
vi.mock("@/lib/auth/provision-approved-resident", () => ({ provisionApprovedResidentAccount }));
vi.mock("@/lib/manager-applications-storage", () => ({
  MANAGER_APPLICATIONS_EVENT: "axis:manager-applications",
  isDraftApplicationRow: (row: { bucket?: string; stage?: string }) => row.bucket === "pending" && row.stage?.trim().toLowerCase() === "in progress",
  normalizeApplicationAxisId: (id: string) => id.trim(),
}));
vi.mock("@/lib/screening/order-screening", () => ({ tryAutoOrderScreening: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

/** Chainable Supabase stub honoring `.in("id", …)` so the stored-row load is real. */
function makeDb() {
  return {
    from(table: string) {
      const state: { ids: string[] | null } = { ids: null };
      let pending: { id: string; row_data: DemoApplicantRow } | null = null;
      const filters: Record<string, string | null> = {};
      const builder: Record<string, unknown> = {
        select() {
          return builder;
        },
        update(values: typeof pending) {
          if (WITHDRAW_BEFORE_UPDATE && STORED_ROWS[0]) STORED_ROWS[0].row_data = { ...STORED_ROWS[0].row_data, withdrawnAt: "2026-07-22T00:00:00.000Z" };
          pending = values; return builder;
        },
        is(column: string) { filters[column] = null; return builder; },
        insert() {
          return Promise.resolve({ error: null });
        },
        upsert(values: { id: string; row_data: DemoApplicantRow }) {
          UPSERTS.push(values);
          return Promise.resolve({ error: null });
        },
        delete() {
          return builder;
        },
        eq(column: string, value: string) { filters[column] = value; return builder; },
        ilike() {
          return builder;
        },
        in(column: string, values: string[]) {
          if (column === "id") {
            state.ids = values;
            if (table === "manager_application_records") ID_FILTER_SIZES.push(values.length);
          }
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return builder;
        },
        maybeSingle() {
          if (table === "profiles") return Promise.resolve({ data: PROFILE, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
          if (table === "manager_application_records" && pending) {
            const match = STORED_ROWS.find((row) => Object.entries(filters).every(([column, expected]) => {
              const value = column.startsWith("row_data->>")
                ? (row.row_data as unknown as Record<string, unknown>)[column.slice("row_data->>".length)]
                : (row as unknown as Record<string, unknown>)[column];
              return (value ?? null) === expected;
            }));
            if (match) UPSERTS.push(pending);
            return Promise.resolve({ data: match ? [{ id: match.id }] : [], error: null }).then(resolve);
          }
          if (table === "manager_application_records") {
            if (STORED_ERROR) return Promise.resolve({ data: null, error: STORED_ERROR }).then(resolve);
            const rows = state.ids ? STORED_ROWS.filter((r) => state.ids?.includes(r.id)) : STORED_ROWS;
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

function appRow(over: Partial<DemoApplicantRow>): DemoApplicantRow {
  return {
    id: "AXIS-9001",
    name: "Withdrawn Applicant",
    property: "The Pioneer",
    propertyId: "mgr-demo-pioneer",
    stage: "Submitted",
    bucket: "pending",
    detail: "",
    email: "applicant@example.com",
    ...over,
  };
}

function post(body: unknown) {
  return new Request("http://localhost/api/manager-applications", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/manager-applications — withdrawnAt is server-owned on a manager write", () => {
  beforeEach(() => {
    WITHDRAW_BEFORE_UPDATE = false;
    getUser.mockReset();
    getUser.mockResolvedValue({ data: { user: { id: "mgr-1", email: "mgr@example.com", user_metadata: {} } } });
    PROFILE = { role: "manager", email: "mgr@example.com" };
    STORED_ROWS = [{ id: "AXIS-9001", row_data: appRow({ withdrawnAt: "2026-07-22T00:00:00.000Z" }) }];
    STORED_ERROR = null;
    UPSERTS = [];
    ID_FILTER_SIZES = [];
    provisionApprovedResidentAccount.mockClear();
  });

  it("refuses a stale-cache approve of a withdrawn row and never provisions the account", async () => {
    const { POST } = await import("@/app/api/manager-applications/route");
    // The manager's cached blob predates the withdrawal, so it carries no stamp.
    const res = await POST(post({ row: appRow({ bucket: "approved", stage: "Approved", withdrawnAt: undefined }) }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/withdrawn/i);
    expect(UPSERTS).toHaveLength(0);
    expect(provisionApprovedResidentAccount).not.toHaveBeenCalled();
  });

  it("re-anchors the stored stamp so a stale mirror cannot erase the withdrawal", async () => {
    const { POST } = await import("@/app/api/manager-applications/route");
    const res = await POST(post({ row: appRow({ detail: "Manager note", withdrawnAt: undefined }) }));
    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
    expect(UPSERTS[0].row_data.withdrawnAt).toBe("2026-07-22T00:00:00.000Z");
  });

  it("refuses a draft update when withdrawal races the conditional write", async () => {
    const draft = appRow({ stage: "In progress" });
    STORED_ROWS = [{ id: draft.id, row_data: draft }];
    WITHDRAW_BEFORE_UPDATE = true;
    const { persistNormalizedRow } = await import("@/lib/rental-application/signed-in-application-write.server");
    await expect(persistNormalizedRow(makeDb() as never, draft.id, draft, { id: draft.id, row_data: draft }, null, null, true)).rejects.toMatchObject({ code: "40001" });
    expect(UPSERTS).toHaveLength(0);
    expect(STORED_ROWS[0]?.row_data.withdrawnAt).toBe("2026-07-22T00:00:00.000Z");
  });

  it("fails CLOSED when the stored row cannot be read", async () => {
    STORED_ERROR = { message: "connection reset" };
    const { POST } = await import("@/app/api/manager-applications/route");
    const res = await POST(post({ row: appRow({ bucket: "approved", stage: "Approved" }) }));
    expect(res.status).toBe(500);
    expect(UPSERTS).toHaveLength(0);
    expect(provisionApprovedResidentAccount).not.toHaveBeenCalled();
  });

  it("still approves a normal (non-withdrawn) application", async () => {
    STORED_ROWS = [{ id: "AXIS-9001", row_data: appRow({}) }];
    const { POST } = await import("@/app/api/manager-applications/route");
    const res = await POST(post({ row: appRow({ bucket: "approved", stage: "Approved" }) }));
    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
    expect(provisionApprovedResidentAccount).toHaveBeenCalledTimes(1);
  });

  it("leaves an ALREADY-approved row that carries a withdrawnAt stamp editable", async () => {
    // Production residue of the gap this closes. The guard keys on the transition
    // into approved, so an edit that keeps the row approved must still save.
    STORED_ROWS = [
      { id: "AXIS-9001", row_data: appRow({ bucket: "approved", withdrawnAt: "2026-07-22T00:00:00.000Z" }) },
    ];
    const { POST } = await import("@/app/api/manager-applications/route");
    const res = await POST(
      post({ row: appRow({ bucket: "approved", stage: "Approved", detail: "Edited resident" }) }),
    );
    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
    expect(UPSERTS[0].row_data.withdrawnAt).toBe("2026-07-22T00:00:00.000Z");
  });
});

describe("POST /api/manager-applications action:\"replace\" — the path the manager Approve actually takes", () => {
  beforeEach(() => {
    WITHDRAW_BEFORE_UPDATE = false;
    getUser.mockReset();
    getUser.mockResolvedValue({ data: { user: { id: "mgr-1", email: "mgr@example.com", user_metadata: {} } } });
    PROFILE = { role: "manager", email: "mgr@example.com" };
    STORED_ROWS = [{ id: "AXIS-9001", row_data: appRow({ withdrawnAt: "2026-07-22T00:00:00.000Z" }) }];
    STORED_ERROR = null;
    UPSERTS = [];
    ID_FILTER_SIZES = [];
    provisionApprovedResidentAccount.mockClear();
  });

  it("does not persist or provision a withdrawn row the mirror marks approved, and keeps the other rows", async () => {
    STORED_ROWS = [
      { id: "AXIS-9001", row_data: appRow({ withdrawnAt: "2026-07-22T00:00:00.000Z" }) },
      { id: "AXIS-9002", row_data: appRow({ id: "AXIS-9002", email: "other@example.com" }) },
    ];
    const { POST } = await import("@/app/api/manager-applications/route");
    const res = await POST(
      post({
        action: "replace",
        rows: [
          appRow({ bucket: "approved", stage: "Approved", withdrawnAt: undefined }),
          appRow({ id: "AXIS-9002", email: "other@example.com", detail: "Still pending" }),
        ],
      }),
    );
    expect(res.status).toBe(409);
    expect(provisionApprovedResidentAccount).not.toHaveBeenCalled();
    expect(UPSERTS.map((u) => u.id)).toEqual(["AXIS-9002"]);
  });

  it("preserves the stored withdrawnAt when the mirror writes a stale blob", async () => {
    const { POST } = await import("@/app/api/manager-applications/route");
    const res = await POST(
      post({ action: "replace", rows: [appRow({ detail: "Stale mirror", withdrawnAt: undefined })] }),
    );
    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
    expect(UPSERTS[0].row_data.withdrawnAt).toBe("2026-07-22T00:00:00.000Z");
  });

  it("fails CLOSED when the batched stored-row read errors", async () => {
    STORED_ERROR = { message: "connection reset" };
    const { POST } = await import("@/app/api/manager-applications/route");
    const res = await POST(
      post({ action: "replace", rows: [appRow({ bucket: "approved", stage: "Approved" })] }),
    );
    expect(res.status).toBe(500);
    expect(UPSERTS).toHaveLength(0);
    expect(provisionApprovedResidentAccount).not.toHaveBeenCalled();
  });

  it("chunks the stored-row lookup so a large mirror is never rejected for size alone", async () => {
    // The mirror posts the manager's WHOLE cached set; one .in() carrying every id
    // would overrun the URI buffer and — because this read fails closed — silently
    // reject the entire batch.
    const rows = Array.from({ length: 250 }, (_, index) =>
      appRow({ id: `AXIS-B${index}`, email: `applicant${index}@example.com` }),
    );
    STORED_ROWS = rows.map((r) => ({ id: r.id, row_data: r }));
    const { POST } = await import("@/app/api/manager-applications/route");
    const res = await POST(post({ action: "replace", rows }));

    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(250);
    expect(ID_FILTER_SIZES.length).toBeGreaterThan(1);
    expect(Math.max(...ID_FILTER_SIZES)).toBeLessThanOrEqual(100);
  });

  it("still mirrors an approve of a non-withdrawn application", async () => {
    STORED_ROWS = [{ id: "AXIS-9001", row_data: appRow({}) }];
    const { POST } = await import("@/app/api/manager-applications/route");
    const res = await POST(
      post({ action: "replace", rows: [appRow({ bucket: "approved", stage: "Approved" })] }),
    );
    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
    expect(provisionApprovedResidentAccount).toHaveBeenCalledTimes(1);
  });
});
