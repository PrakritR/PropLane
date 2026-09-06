/**
 * Route-level regression: `GET /api/manager-applications` as a manager.
 *
 * An application's `manager_user_id` is resolved once at submit time
 * (`linkResidentOnApplicationSubmit`) and never re-resolved once the resident
 * stops touching the draft — nothing re-runs that resolution for an abandoned
 * "Incomplete" application. So if a property's ownership ever changes (a
 * transfer, a re-assigned co-manager grant, or a one-off historical
 * resolution gap), an application submitted under the OLD attribution would
 * be permanently invisible to the property's CURRENT owner — even though the
 * manager's own empty-state copy promises "as soon as they enter their
 * email" it shows up under Pending.
 *
 * `fetchApplicationsForManagerUser` must therefore also match by property
 * ownership (queried fresh from `manager_property_records`), not only by the
 * frozen `manager_user_id` stamp on the application row — while never
 * surfacing a row for a property this manager does NOT own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";

type StoredRecord = {
  id: string;
  row_data: DemoApplicantRow;
  manager_user_id: string | null;
  property_id: string | null;
  assigned_property_id: string | null;
  updated_at: string;
};

const getUser = vi.fn();
let PROFILE: { role: string; email: string } | null;
let PROPERTIES: { id: string; manager_user_id: string }[];
let APP_ROWS: StoredRecord[];

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => false) }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  // Isolate the OWNED-property fallback from co-manager linking, which has its own coverage.
  linkedPropertyIdsForModule: vi.fn(async () => new Set<string>()),
}));
vi.mock("@/lib/auth/provision-approved-resident", () => ({
  provisionApprovedResidentAccount: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

/** Minimal chainable Supabase stub covering exactly the tables/filters this route touches. */
function makeDb() {
  return {
    from(table: string) {
      const filters: { eqCol: string | null; eqVal: string | null; inCol: string | null; inVals: string[] | null } = {
        eqCol: null,
        eqVal: null,
        inCol: null,
        inVals: null,
      };
      const rowsFor = (): unknown[] => {
        if (table === "manager_property_records") {
          if (filters.eqCol === "manager_user_id") return PROPERTIES.filter((p) => p.manager_user_id === filters.eqVal);
          return PROPERTIES;
        }
        if (table === "manager_application_records") {
          let rows = APP_ROWS;
          if (filters.eqCol === "manager_user_id") rows = rows.filter((r) => r.manager_user_id === filters.eqVal);
          if (filters.inCol) rows = rows.filter((r) => filters.inVals?.includes(String((r as StoredRecord)[filters.inCol as keyof StoredRecord] ?? "")));
          return rows;
        }
        return [];
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq(column: string, value: string) {
          filters.eqCol = column;
          filters.eqVal = value;
          return builder;
        },
        in(column: string, values: string[]) {
          filters.inCol = column;
          filters.inVals = values;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle() {
          if (table === "profiles") return Promise.resolve({ data: PROFILE, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
          return Promise.resolve({ data: rowsFor(), error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

async function getApplications() {
  const { GET } = await import("@/app/api/manager-applications/route");
  const res = await GET(new Request("https://example.test/api/manager-applications"));
  return { status: res.status, body: (await res.json()) as { rows?: DemoApplicantRow[]; error?: string } };
}

const NEW_OWNER = "mgr-new-owner";
const OLD_OWNER = "mgr-old-owner-frozen-on-the-row";
const OTHER_MANAGER = "mgr-unrelated-portfolio";
const LISTING = "mgr-the-magnolia-2b";
const OTHER_LISTING = "mgr-someone-elses-listing";

function row(over: Partial<StoredRecord>): StoredRecord {
  return {
    id: "PROPLANE-TESTAX1",
    row_data: {
      id: "PROPLANE-TESTAX1",
      name: "Maya Alvarez",
      email: "maya.alvarez@example.com",
      property: "The Magnolia · 2B",
      propertyId: LISTING,
      stage: "In progress",
      bucket: "pending",
      detail: "",
      managerUserId: OLD_OWNER,
    },
    manager_user_id: OLD_OWNER,
    property_id: LISTING,
    assigned_property_id: null,
    updated_at: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  PROFILE = { role: "manager", email: "owner@test.proplane.local" };
  getUser.mockResolvedValue({
    data: { user: { id: NEW_OWNER, email: "owner@test.proplane.local", user_metadata: {} } },
    error: null,
  });
  PROPERTIES = [];
  APP_ROWS = [];
});

describe("GET /api/manager-applications — owned-property fallback", () => {
  it("surfaces an Incomplete application whose stored attribution is stale, once the manager owns the listing", async () => {
    PROPERTIES = [{ id: LISTING, manager_user_id: NEW_OWNER }];
    APP_ROWS = [row({})]; // manager_user_id on the row is still OLD_OWNER — frozen, never re-resolved.

    const { status, body } = await getApplications();

    expect(status).toBe(200);
    expect(body.rows).toHaveLength(1);
    expect(body.rows?.[0]?.id).toBe("PROPLANE-TESTAX1");
  });

  it("still finds it via the ordinary manager_user_id match when attribution is current (no regression)", async () => {
    PROPERTIES = [{ id: LISTING, manager_user_id: NEW_OWNER }];
    APP_ROWS = [row({ manager_user_id: NEW_OWNER, row_data: { ...row({}).row_data, managerUserId: NEW_OWNER } })];

    const { status, body } = await getApplications();

    expect(status).toBe(200);
    expect(body.rows).toHaveLength(1);
  });

  it("never surfaces another manager's application just because the ids look similar", async () => {
    // This manager owns nothing named LISTING; the row belongs to a totally
    // different manager's portfolio and must stay invisible.
    PROPERTIES = [{ id: "mgr-new-owner-own-property", manager_user_id: NEW_OWNER }];
    APP_ROWS = [
      row({
        id: "PROPLANE-VICTIMROW",
        manager_user_id: OTHER_MANAGER,
        property_id: OTHER_LISTING,
        row_data: { ...row({}).row_data, id: "PROPLANE-VICTIMROW", propertyId: OTHER_LISTING, managerUserId: OTHER_MANAGER },
      }),
    ];

    const { status, body } = await getApplications();

    expect(status).toBe(200);
    expect(body.rows).toHaveLength(0);
  });

  it("matches via assigned_property_id too (assigned after a room/bundle pick)", async () => {
    PROPERTIES = [{ id: LISTING, manager_user_id: NEW_OWNER }];
    APP_ROWS = [row({ property_id: null, assigned_property_id: LISTING })];

    const { status, body } = await getApplications();

    expect(status).toBe(200);
    expect(body.rows).toHaveLength(1);
  });
});
