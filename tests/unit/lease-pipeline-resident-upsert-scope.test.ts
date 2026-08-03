/**
 * A resident may edit the BODY of a lease they can see, never which account or
 * manager it belongs to. `buildUpsert` copies `manager_user_id`,
 * `resident_user_id`, `resident_email` and `property_id` straight off the
 * client row, so before this pin a resident who passed the visibility check on
 * their OWN lease could write it back with `resident_email` rewritten — moving
 * the row into someone else's resident-scoped query with attacker-authored
 * `row_data` — or with `manager_user_id` rewritten, injecting it into an
 * arbitrary manager's pipeline. The manager branch already re-pinned
 * `manager_user_id` for the same reason; this makes the two branches agree.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const OWNER_MANAGER = "manager-who-owns-it";
const RESIDENT_ID = "11111111-2222-3333-4444-555555555555";
const RESIDENT_EMAIL = "resident@example.com";
const LEASE_ID = "lease-mine";

const getUser = vi.fn();
const isAdminUser = vi.fn(async () => false);
const upsert = vi.fn(async () => ({ error: null }));
const deleteEq = vi.fn(async () => ({ error: null }));
const managerCanAccessLeaseRecord = vi.fn(async () => true);

let PROFILE: { email: string; role: string | null } | null = null;
let PROFILE_ROLES: string[] = [];
let PORTAL_ROLES: string[] = [];
let EFFECTIVE_ROLE: string | null = null;
let VISIBLE_TO_RESIDENT = true;

const STORED = {
  id: LEASE_ID,
  manager_user_id: OWNER_MANAGER,
  resident_user_id: RESIDENT_ID,
  resident_email: RESIDENT_EMAIL,
  property_id: "prop-1",
  row_data: { id: LEASE_ID, residentEmail: RESIDENT_EMAIL, managerUserId: OWNER_MANAGER },
};

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...(a as [])) }));
vi.mock("@/lib/auth/portal-access", () => ({
  ACTIVE_PORTAL_COOKIE: "axis_active_portal",
  getPortalAccessContext: async () => ({
    user: null,
    profile: null,
    roles: PORTAL_ROLES,
    effectiveRole: EFFECTIVE_ROLE,
  }),
}));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  fetchLeasesForManagerUser: async () => [],
  managerCanAccessLeaseRecord: (...a: unknown[]) => managerCanAccessLeaseRecord(...(a as [])),
}));
vi.mock("@/lib/documents/document-auto-file-hooks.server", () => ({
  autoFileLeaseDocument: async () => undefined,
}));

function makeDb() {
  return {
    from(table: string) {
      let orFiltered = false;
      let selected = "";
      const builder: Record<string, unknown> = {
        select: (cols: string) => {
          selected = cols;
          return builder;
        },
        eq: () => builder,
        order: () => builder,
        or: () => {
          orFiltered = true;
          return builder;
        },
        limit: () => {
          if (table !== "portal_lease_pipeline_records") return Promise.resolve({ data: [], error: null });
          if (orFiltered) {
            return Promise.resolve({ data: VISIBLE_TO_RESIDENT ? [{ id: LEASE_ID }] : [], error: null });
          }
          SELECTS.push(selected);
          return Promise.resolve({ data: [STORED], error: null });
        },
        upsert: (record: unknown) => upsert(record as never),
        delete: () => ({ eq: (...a: unknown[]) => deleteEq(...(a as [])) }),
        maybeSingle() {
          if (table === "profiles") return Promise.resolve({ data: PROFILE, error: null });
          if (table === "profile_roles") {
            return Promise.resolve({
              data: PROFILE_ROLES.includes("resident") ? { role: "resident" } : null,
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  };
}

const SELECTS: string[] = [];

async function post(body: unknown) {
  const { POST } = await import("@/app/api/portal-lease-pipeline/route");
  return POST(
    new Request("http://localhost/api/portal-lease-pipeline", { method: "POST", body: JSON.stringify(body) }),
  );
}

function asResident() {
  PROFILE = { email: RESIDENT_EMAIL, role: "resident" };
  PROFILE_ROLES = ["resident"];
  PORTAL_ROLES = ["resident"];
  EFFECTIVE_ROLE = "resident";
}

beforeEach(() => {
  vi.clearAllMocks();
  SELECTS.length = 0;
  VISIBLE_TO_RESIDENT = true;
  isAdminUser.mockResolvedValue(false);
  managerCanAccessLeaseRecord.mockResolvedValue(true);
  upsert.mockResolvedValue({ error: null });
  getUser.mockResolvedValue({ data: { user: { id: RESIDENT_ID, email: RESIDENT_EMAIL } }, error: null });
});

describe("portal-lease-pipeline resident upsert — scope columns are server-pinned", () => {
  beforeEach(asResident);

  it("ignores a rewritten residentEmail / managerUserId and keeps the stored scope", async () => {
    const res = await post({
      action: "upsert",
      row: {
        id: LEASE_ID,
        residentEmail: "victim@example.com",
        residentUserId: "99999999-9999-9999-9999-999999999999",
        managerUserId: "attacker-manager",
        propertyId: "prop-somewhere-else",
        signatureName: "Resident",
      },
    });

    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledTimes(1);
    const written = upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.resident_email).toBe(RESIDENT_EMAIL);
    expect(written.resident_user_id).toBe(RESIDENT_ID);
    expect(written.manager_user_id).toBe(OWNER_MANAGER);
    expect(written.property_id).toBe("prop-1");
  });

  it("still lets the resident update their own row body", async () => {
    const res = await post({
      action: "upsert",
      row: { id: LEASE_ID, residentEmail: RESIDENT_EMAIL, signatureName: "Resident", signedAtIso: "2026-05-01T00:00:00Z" },
    });

    expect(res.status).toBe(200);
    const written = upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect((written.row_data as Record<string, unknown>).signatureName).toBe("Resident");
    expect(written.resident_email).toBe(RESIDENT_EMAIL);
  });

  it("still 404s a lease the resident cannot see", async () => {
    VISIBLE_TO_RESIDENT = false;
    const res = await post({ action: "upsert", row: { id: LEASE_ID, residentEmail: RESIDENT_EMAIL } });
    expect(res.status).toBe(404);
    expect(upsert).not.toHaveBeenCalled();
  });

  /**
   * The pin reads the stored row, so a column missing from that SELECT would
   * write null and cut the resident off from their own lease.
   */
  it("selects every scope column it pins", async () => {
    await post({ action: "upsert", row: { id: LEASE_ID, residentEmail: RESIDENT_EMAIL } });
    const select = SELECTS.find((cols) => cols.includes("row_data")) ?? "";
    for (const column of ["manager_user_id", "resident_user_id", "resident_email", "property_id"]) {
      expect(select).toContain(column);
    }
  });

  it("refuses a delete instead of reporting success for work it did not do", async () => {
    const res = await post({ action: "delete", id: LEASE_ID });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Residents cannot delete lease records." });
    expect(deleteEq).not.toHaveBeenCalled();
  });
});

describe("portal-lease-pipeline manager upsert — unchanged", () => {
  beforeEach(() => {
    PROFILE = { email: "manager@example.com", role: "manager" };
    PROFILE_ROLES = ["manager"];
    PORTAL_ROLES = ["manager"];
    EFFECTIVE_ROLE = "manager";
    getUser.mockResolvedValue({ data: { user: { id: OWNER_MANAGER, email: "manager@example.com" } }, error: null });
  });

  it("may still edit the resident fields on a row it owns", async () => {
    const res = await post({
      action: "upsert",
      row: { id: LEASE_ID, residentEmail: "new-tenant@example.com", managerUserId: "someone-else" },
    });

    expect(res.status).toBe(200);
    const written = upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.resident_email).toBe("new-tenant@example.com");
    expect(written.manager_user_id).toBe(OWNER_MANAGER);
  });

  it("still deletes and reports success", async () => {
    const res = await post({ action: "delete", id: LEASE_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deleteEq).toHaveBeenCalled();
  });
});

describe("portal-lease-pipeline admin — unchanged", () => {
  beforeEach(() => {
    PROFILE = { email: "admin@example.com", role: "admin" };
    PROFILE_ROLES = [];
    PORTAL_ROLES = ["admin"];
    EFFECTIVE_ROLE = "admin";
    isAdminUser.mockResolvedValue(true);
    getUser.mockResolvedValue({ data: { user: { id: "admin-user", email: "admin@example.com" } }, error: null });
  });

  it("writes the row as sent and deletes with a bare ok", async () => {
    const written = await post({
      action: "upsert",
      row: { id: LEASE_ID, residentEmail: "anything@example.com", managerUserId: "any-manager" },
    });
    expect(written.status).toBe(200);
    const record = upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(record.resident_email).toBe("anything@example.com");
    expect(record.manager_user_id).toBe("any-manager");

    const deleted = await post({ action: "delete", id: LEASE_ID });
    expect(deleted.status).toBe(200);
    expect(deleteEq).toHaveBeenCalled();
  });
});

describe("portal-lease-pipeline signed-document immutability", () => {
  it("is still enforced ahead of the resident scope pin", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "app", "api", "portal-lease-pipeline", "route.ts"),
      "utf8",
    );
    const guard = source.indexOf("replacesSignedLeaseDocument");
    const pin = source.indexOf("storedScopeColumns(existingRecord)");
    expect(guard).toBeGreaterThan(-1);
    expect(pin).toBeGreaterThan(guard);
  });
});
