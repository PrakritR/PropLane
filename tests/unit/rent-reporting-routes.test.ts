/**
 * The resident rent-reporting route (`/api/resident/rent-reporting`):
 *
 * 1. Refuses to start when the manager's add-on is off, with a plain reason.
 * 2. A successful start encrypts legal name + DOB at rest (never plaintext in the row).
 * 3. Stopping sets `stopped_at` and the row drops out of the next month's export set —
 *    "stops the next cycle" is a durable status change, never a delete.
 */
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

function createFakeDb(seed: Record<string, Row[]> = {}) {
  const store: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(seed)) store[table] = rows.map((r) => ({ ...r }));

  function parseOrClause(expr: string): Array<{ col: string; val: string }> {
    return expr.split(",").map((clause) => {
      const firstDot = clause.indexOf(".");
      const col = clause.slice(0, firstDot);
      const rest = clause.slice(firstDot + 1);
      const secondDot = rest.indexOf(".");
      const val = rest.slice(secondDot + 1);
      return { col, val };
    });
  }

  function from(table: string) {
    const rows = (store[table] ??= []);
    let filtered = rows;
    let pendingPatch: Row | null = null;
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;
    let wantCount = false;

    function ordered() {
      let result = filtered;
      if (orderCol) {
        const col = orderCol;
        result = [...result].sort((a, b) => {
          const av = String(a[col] ?? "");
          const bv = String(b[col] ?? "");
          return orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (limitN != null) result = result.slice(0, limitN);
      return result;
    }

    const api = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        wantCount = Boolean(opts?.count);
        return api;
      },
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return api;
      },
      in(col: string, vals: unknown[]) {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return api;
      },
      or(expr: string) {
        const clauses = parseOrClause(expr);
        filtered = filtered.filter((r) => clauses.some(({ col, val }) => String(r[col] ?? "") === val));
        return api;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderCol = col;
        orderAsc = opts?.ascending !== false;
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      update(patch: Row) {
        pendingPatch = patch;
        return api;
      },
      upsert(values: Row | Row[], opts?: { onConflict?: string }) {
        const list = Array.isArray(values) ? values : [values];
        const keys = (opts?.onConflict ?? "id").split(",");
        for (const v of list) {
          const idx = rows.findIndex((r) => keys.every((k) => r[k] === v[k]));
          if (idx >= 0) rows[idx] = { ...rows[idx], ...v };
          else rows.push({ ...v });
        }
        filtered = rows.filter((r) => list.some((v) => keys.every((k) => r[k] === v[k])));
        return api;
      },
      async maybeSingle() {
        if (pendingPatch) for (const row of filtered) Object.assign(row, pendingPatch);
        const result = ordered();
        return { data: result[0] ?? null, error: null };
      },
      then(
        resolve: (v: { data: Row[] | null; error: null; count?: number }) => unknown,
        reject?: (e: unknown) => unknown,
      ) {
        if (pendingPatch) for (const row of filtered) Object.assign(row, pendingPatch);
        const result = ordered();
        return Promise.resolve(resolve({ data: result, error: null, count: wantCount ? result.length : undefined })).then(
          undefined,
          reject,
        );
      },
    };
    return api;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from, store } as any;
}

let db: ReturnType<typeof createFakeDb>;
let tier: "free" | "pro" | "business" = "pro";

vi.mock("@/lib/auth/resident-role-access", () => ({
  authorizeResidentRole: async () => true,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "res-1" } } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => db,
}));
vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: async () => ({ ok: true, tier }),
}));

const { GET, PUT } = await import("@/app/api/resident/rent-reporting/route");
const { loadActiveRentReportingEnrollments } = await import("@/lib/rent-reporting/consent.server");

function seedTenancy() {
  db.store.profiles = [{ id: "res-1", email: "resident@example.com", role: "resident" }];
  db.store.portal_recurring_rent_profile_records = [
    {
      manager_user_id: "mgr-1",
      property_id: "prop-1",
      active: true,
      resident_user_id: "res-1",
      resident_email: "resident@example.com",
      row_data: { propertyLabel: "123 Main St" },
    },
  ];
}

function put(body: unknown) {
  return PUT(
    new Request("https://prop-lane.space/api/resident/rent-reporting", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "key-1");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ "key-1": randomBytes(32).toString("base64") }));
  db = createFakeDb();
  tier = "pro";
  seedTenancy();
});

describe("add-on gating", () => {
  it("refuses to start when the manager has not turned the add-on on", async () => {
    const res = await put({ action: "start", legalName: "Jamie Rivera", dob: "1990-05-01", consent: true });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/not turned on rent reporting/i);
    expect(db.store.resident_rent_reporting ?? []).toHaveLength(0);
  });

  it("refuses to start on a Free plan even if the add-on flag were somehow on", async () => {
    tier = "free";
    db.store.manager_automation_settings = [
      { manager_user_id: "mgr-1", row_data: { rentReportingAddon: { enabled: true } } },
    ];
    const res = await put({ action: "start", legalName: "Jamie Rivera", dob: "1990-05-01", consent: true });
    expect(res.status).toBe(403);
  });
});

describe("start", () => {
  beforeEach(() => {
    db.store.manager_automation_settings = [
      { manager_user_id: "mgr-1", row_data: { rentReportingAddon: { enabled: true } } },
    ];
  });

  it("encrypts legal name and DOB at rest and marks the row active", async () => {
    const res = await put({ action: "start", legalName: "Jamie Rivera", dob: "1990-05-01", consent: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("active");

    const rows = db.store.resident_rent_reporting ?? [];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.status).toBe("active");
    expect(row.consented_at).toBeTruthy();
    expect(row.legal_name_encrypted).toMatch(/^proplane:v1:/);
    expect(row.dob_encrypted).toMatch(/^proplane:v1:/);
    expect(String(row.legal_name_encrypted)).not.toContain("Jamie Rivera");
    expect(String(row.dob_encrypted)).not.toContain("1990-05-01");
    expect(row.partner_subject_id).toBeTruthy();
  });

  it("refuses without consent", async () => {
    const res = await put({ action: "start", legalName: "Jamie Rivera", dob: "1990-05-01", consent: false });
    expect(res.status).toBe(400);
  });

  it("GET reflects the started enrollment", async () => {
    await put({ action: "start", legalName: "Jamie Rivera", dob: "1990-05-01", consent: true });
    const res = await GET();
    const body = await res.json();
    expect(body.eligible).toBe(true);
    expect(body.addonAvailable).toBe(true);
    expect(body.status).toBe("active");
    expect(body.reportedAs).toContain("Jamie Rivera");
    expect(body.bureaus).toBe("Experian · TransUnion · Equifax");
  });
});

describe("stop", () => {
  beforeEach(() => {
    db.store.manager_automation_settings = [
      { manager_user_id: "mgr-1", row_data: { rentReportingAddon: { enabled: true } } },
    ];
  });

  it("sets stopped_at, and the row drops out of the next export's active set", async () => {
    await put({ action: "start", legalName: "Jamie Rivera", dob: "1990-05-01", consent: true });
    const startedId = (db.store.resident_rent_reporting ?? [])[0]!.id as string;

    const res = await put({ action: "stop" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("stopped");

    const row = (db.store.resident_rent_reporting ?? [])[0]!;
    expect(row.status).toBe("stopped");
    expect(row.stopped_at).toBeTruthy();

    const active = await loadActiveRentReportingEnrollments(db);
    expect(active.some((e) => e.id === startedId)).toBe(false);
  });
});
