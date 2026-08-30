/**
 * Route-level regression: `POST /api/manager-applications` with
 * `action: "delete"` as a manager.
 *
 * The Applications LIST shows an "Incomplete" draft on a property the manager
 * owns TODAY, matched by property ownership — but the delete guard
 * (`assertCanDeleteApplicationRecords`) used to authorize managers only by the
 * frozen `manager_user_id` stamp OR a co-manager "delete" grant, with NO
 * direct-property-ownership fallback. A draft keeps a stale (or zero-UUID)
 * stamp, so the direct owner saw the row yet got "You do not have permission to
 * delete this application" — the same list-vs-guard divergence that produced the
 * sibling "resident is not in your portfolio" bug on the other delete path.
 *
 * The guard now resolves ownership through the SAME shared predicate the list
 * and the other by-id actions use (`managerCanAccessApplicationRecord`, at level
 * "delete"): a direct owner always passes regardless of the stamp; a co-manager
 * needs the granular "delete" level; a manager who controls neither is refused.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { CoManagerPermissionLevel } from "@/lib/co-manager-permissions";

type StoredRecord = {
  id: string;
  row_data: DemoApplicantRow;
  manager_user_id: string | null;
  resident_email: string | null;
  property_id: string | null;
  assigned_property_id: string | null;
};

const getUser = vi.fn();
let PROFILE: { role: string; email: string } | null;
let PROPERTIES: { id: string; manager_user_id: string }[];
let APP_ROWS: StoredRecord[];
let DELETED_IDS: string[];
// userId -> propertyId -> levels the co-manager link grants
let CO_MANAGER_GRANTS: Record<string, Record<string, CoManagerPermissionLevel[]>>;

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => false) }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  linkedPropertyIdsForModule: vi.fn(async () => new Set<string>()),
  linkedOwnerForProperty: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerHasCoManagerPermissionForProperty: vi.fn(
    async (_db: unknown, userId: string, propertyId: string, _module: string, level: CoManagerPermissionLevel = "read") =>
      (CO_MANAGER_GRANTS[userId]?.[propertyId] ?? []).includes(level),
  ),
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
          if (filters.inCol === "id") rows = rows.filter((r) => filters.inVals?.includes(r.id));
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
        delete() {
          // The route hard-deletes through `purgeApplicationPortalData`, which
          // fans out over sibling tables with `.eq(...)` and a JSON-path
          // `.filter(...)`. Only the application table is asserted here; the
          // rest just have to succeed rather than blow up the request.
          const applyDelete = (values: string[]) => {
            if (table === "manager_application_records") {
              DELETED_IDS.push(...values);
              APP_ROWS = APP_ROWS.filter((r) => !values.includes(r.id));
            }
            return Promise.resolve({ error: null });
          };
          return {
            in: (_column: string, values: string[]) => applyDelete(values),
            eq: (_column: string, value: string) => applyDelete([value]),
            filter: () => Promise.resolve({ error: null }),
          };
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

async function deleteApplication(id: string) {
  const { POST } = await import("@/app/api/manager-applications/route");
  const req = new Request("http://localhost/api/manager-applications", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", id }),
  });
  const res = await POST(req);
  return { status: res.status, body: (await res.json()) as { ok?: boolean; deleted?: number; error?: string } };
}

const OWNER = "mgr-owner-1";
const STRANGER = "mgr-stranger-2";
const CO_MANAGER = "mgr-comanager-3";
const STALE_STAMP = "00000000-0000-0000-0000-000000000000";
const OWNED_PROPERTY = "mgr-parity-brooklyn";
const APP_ID = "PROPLANE-INCOMPLETE1";

function incompleteDraft(): StoredRecord {
  return {
    id: APP_ID,
    row_data: {
      id: APP_ID,
      name: "Ambika Mago",
      email: "ambika.mago@example.com",
      property: "4709A 8th Ave NE · Room 1",
      propertyId: OWNED_PROPERTY,
      stage: "In progress",
      bucket: "pending",
      detail: "",
      managerUserId: STALE_STAMP,
    },
    manager_user_id: STALE_STAMP, // frozen/unattributed — never re-resolved for an abandoned draft
    resident_email: "ambika.mago@example.com",
    property_id: OWNED_PROPERTY,
    assigned_property_id: null,
  };
}

function signInAs(userId: string) {
  getUser.mockResolvedValue({ data: { user: { id: userId, email: "caller@test.proplane.local", user_metadata: {} } }, error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  PROFILE = { role: "manager", email: "caller@test.proplane.local" };
  PROPERTIES = [{ id: OWNED_PROPERTY, manager_user_id: OWNER }];
  APP_ROWS = [incompleteDraft()];
  DELETED_IDS = [];
  CO_MANAGER_GRANTS = {};
});

describe("POST /api/manager-applications action=delete — property-owned authorization", () => {
  it("lets the DIRECT owner delete an Incomplete draft even when the stored stamp is stale", async () => {
    signInAs(OWNER);

    const { status, body } = await deleteApplication(APP_ID);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(DELETED_IDS).toContain(APP_ID);
  });

  it("refuses a manager who does NOT control the application's property", async () => {
    signInAs(STRANGER); // owns nothing; no co-manager grant

    const { status, body } = await deleteApplication(APP_ID);

    expect(status).toBe(403);
    expect(body.error).toMatch(/permission to delete/i);
    expect(DELETED_IDS).toHaveLength(0);
  });

  it("refuses a READ-level co-manager (visibility never implies destruction)", async () => {
    signInAs(CO_MANAGER);
    CO_MANAGER_GRANTS = { [CO_MANAGER]: { [OWNED_PROPERTY]: ["read"] } };

    const { status, body } = await deleteApplication(APP_ID);

    expect(status).toBe(403);
    expect(body.error).toMatch(/permission to delete/i);
    expect(DELETED_IDS).toHaveLength(0);
  });

  it("allows a DELETE-level co-manager", async () => {
    signInAs(CO_MANAGER);
    CO_MANAGER_GRANTS = { [CO_MANAGER]: { [OWNED_PROPERTY]: ["read", "edit", "delete"] } };

    const { status, body } = await deleteApplication(APP_ID);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(DELETED_IDS).toContain(APP_ID);
  });
});
