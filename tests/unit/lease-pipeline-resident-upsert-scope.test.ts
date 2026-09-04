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
const autoFileLeaseDocument = vi.fn(async () => "doc-1");
const managerMayFileLeaseUnderProperty = vi.fn(async () => ({ ok: true, allowed: true, propertyExists: true }) as
  | { ok: true; allowed: boolean; propertyExists: boolean }
  | { ok: false; error: string });

let PROFILE: { email: string; role: string | null } | null = null;
let PROFILE_ROLES: string[] = [];
let PORTAL_ROLES: string[] = [];
let EFFECTIVE_ROLE: string | null = null;
let VISIBLE_TO_RESIDENT = true;
let RECORD_EXISTS = true;

const APPLICATION_ID = "app-1";
const MANAGER_FILED_PDF = "data:application/pdf;base64,MANAGERFILED";

const DEFAULT_STORED_ROW_DATA: Record<string, unknown> = {
  id: LEASE_ID,
  residentEmail: RESIDENT_EMAIL,
  managerUserId: OWNER_MANAGER,
  axisId: APPLICATION_ID,
};

let APPLICATION_RECORD: { id: string; row_data: Record<string, unknown> } | null = null;

const STORED: {
  id: string;
  manager_user_id: string;
  resident_user_id: string;
  resident_email: string;
  property_id: string;
  row_data: Record<string, unknown>;
} = {
  id: LEASE_ID,
  manager_user_id: OWNER_MANAGER,
  resident_user_id: RESIDENT_ID,
  resident_email: RESIDENT_EMAIL,
  property_id: "prop-1",
  row_data: { ...DEFAULT_STORED_ROW_DATA },
};

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...(a as [])) }));
vi.mock("@/lib/auth/portal-access", () => ({
  ACTIVE_PORTAL_COOKIE: "axis_active_portal",
  hasRole: (ctx: { roles: string[] }, role: string) => ctx.roles.includes(role),
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
  managerMayFileLeaseUnderProperty: (...a: unknown[]) => managerMayFileLeaseUnderProperty(...(a as [])),
}));
vi.mock("@/lib/documents/document-auto-file-hooks.server", () => ({
  autoFileLeaseDocument: (...a: unknown[]) => autoFileLeaseDocument(...(a as [])),
}));

/** The stored row is looked up by id, so a batch can mix existing and new rows. */
function storedFor(id: string) {
  if (RECORD_EXISTS && id === LEASE_ID) return [STORED];
  return [];
}

/** The application record the manager filed the off-platform lease onto. */
function applicationFor(id: string, owner: string) {
  if (!APPLICATION_RECORD || id !== APPLICATION_ID || owner !== OWNER_MANAGER) return [];
  return [APPLICATION_RECORD];
}

function makeDb() {
  return {
    from(table: string) {
      let orFiltered = false;
      let selected = "";
      let requestedId = "";
      let requestedOwner = "";
      const builder: Record<string, unknown> = {
        select: (cols: string) => {
          selected = cols;
          return builder;
        },
        eq: (column: string, value: unknown) => {
          if (column === "id") requestedId = String(value ?? "");
          if (column === "manager_user_id") requestedOwner = String(value ?? "");
          return builder;
        },
        order: () => builder,
        or: () => {
          orFiltered = true;
          return builder;
        },
        limit: () => {
          if (table === "manager_application_records") {
            return Promise.resolve({ data: applicationFor(requestedId, requestedOwner), error: null });
          }
          if (table !== "portal_lease_pipeline_records") return Promise.resolve({ data: [], error: null });
          if (orFiltered) {
            return Promise.resolve({ data: VISIBLE_TO_RESIDENT ? [{ id: LEASE_ID }] : [], error: null });
          }
          SELECTS.push(selected);
          return Promise.resolve({ data: storedFor(requestedId), error: null });
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
  RECORD_EXISTS = true;
  STORED.row_data = { ...DEFAULT_STORED_ROW_DATA };
  APPLICATION_RECORD = {
    id: APPLICATION_ID,
    row_data: { id: APPLICATION_ID, manualResidentDetails: { signedLeaseDataUrl: MANAGER_FILED_PDF } },
  };
  isAdminUser.mockResolvedValue(false);
  managerCanAccessLeaseRecord.mockResolvedValue(true);
  autoFileLeaseDocument.mockResolvedValue("doc-1");
  managerMayFileLeaseUnderProperty.mockResolvedValue({ ok: true, allowed: true, propertyExists: true });
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

  /**
   * The refusal is a per-REQUEST fact. Answering 403 only when a requested id
   * happens to exist would make the route a lease-record existence oracle.
   */
  it("answers the same refusal for an id that does not exist", async () => {
    RECORD_EXISTS = false;
    const res = await post({ action: "deleteIds", ids: ["lease_app_does-not-exist"] });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Residents cannot delete lease records." });
    expect(deleteEq).not.toHaveBeenCalled();
  });
});

describe("portal-lease-pipeline resident CREATE — cannot plant a row in another scope", () => {
  beforeEach(() => {
    asResident();
    RECORD_EXISTS = false;
  });

  it("pins a fabricated signed lease to the creator, never the named victim", async () => {
    const res = await post({
      action: "upsert",
      row: {
        id: "lease_app_planted",
        residentEmail: "victim@example.com",
        residentUserId: "99999999-9999-9999-9999-999999999999",
        managerUserId: "attacker-manager",
        propertyId: "victim-managers-property",
        status: "Fully Signed",
      },
    });

    expect(res.status).toBe(200);
    const written = upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.resident_email).toBe(RESIDENT_EMAIL);
    expect(written.resident_user_id).toBe(RESIDENT_ID);
    expect(written.resident_email).not.toBe("victim@example.com");
    // property_id also selects rows into a co-manager's linked pipeline.
    expect(written.property_id).toBeNull();
    expect(written.manager_user_id).toBe(RESIDENT_ID);
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

  it("still no-ops on an absent record so retries stay idempotent", async () => {
    RECORD_EXISTS = false;
    const res = await post({ action: "delete", id: "lease_app_gone" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deleteEq).not.toHaveBeenCalled();
  });

  it("may still create a lease naming their tenant", async () => {
    RECORD_EXISTS = false;
    const res = await post({
      action: "upsert",
      row: {
        id: "lease_app_new",
        residentEmail: "tenant@example.com",
        residentUserId: RESIDENT_ID,
        propertyId: "prop-1",
      },
    });

    expect(res.status).toBe(200);
    const written = upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.resident_email).toBe("tenant@example.com");
    expect(written.resident_user_id).toBe(RESIDENT_ID);
    expect(written.property_id).toBe("prop-1");
    expect(written.manager_user_id).toBe(OWNER_MANAGER);
  });
});

/**
 * A manager may RE-POINT a lease's scope, never blank it by omission. The
 * browser store posts the ENTIRE row set as one `replace`, and its rows carry
 * `propertyId` only when it was ever set (`undefined` otherwise, so the key is
 * absent after JSON) while normalizing `managerUserId` / `residentUserId` to an
 * explicit `null`. Rebuilding the scope from that row wrote null over the
 * stored columns: `property_id` gone drops the lease out of every co-manager's
 * linked view, `resident_email` / `resident_user_id` gone orphans the resident
 * from their own lease.
 */
describe("portal-lease-pipeline manager edit — stored scope survives an unnaming row", () => {
  beforeEach(() => {
    PROFILE = { email: "manager@example.com", role: "manager" };
    PROFILE_ROLES = ["manager"];
    PORTAL_ROLES = ["manager"];
    EFFECTIVE_ROLE = "manager";
    getUser.mockResolvedValue({ data: { user: { id: OWNER_MANAGER, email: "manager@example.com" } }, error: null });
  });

  it("keeps the stored property_id / resident scope through an ordinary full-row sync", async () => {
    const res = await post({
      action: "replace",
      rows: [
        {
          id: LEASE_ID,
          residentEmail: RESIDENT_EMAIL,
          residentName: "Resident",
          managerUserId: null,
          residentUserId: null,
          notes: "edited",
        },
      ],
    });

    expect(res.status).toBe(200);
    const written = upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.property_id).toBe("prop-1");
    expect(written.resident_user_id).toBe(RESIDENT_ID);
    expect(written.resident_email).toBe(RESIDENT_EMAIL);
    expect(written.manager_user_id).toBe(OWNER_MANAGER);
    // An unchanged property is not a move, so no ownership round trip.
    expect(managerMayFileLeaseUnderProperty).not.toHaveBeenCalled();
  });

  /** The fallback is only as good as the SELECT it reads from. */
  it("selects every scope column the manager branch falls back to", async () => {
    await post({ action: "upsert", row: { id: LEASE_ID, residentEmail: RESIDENT_EMAIL } });
    const select = SELECTS.find((cols) => cols.includes("row_data")) ?? "";
    for (const column of ["manager_user_id", "resident_user_id", "resident_email", "property_id"]) {
      expect(select).toContain(column);
    }
  });

  it("still lets the manager re-point the resident when the row names one", async () => {
    const res = await post({
      action: "upsert",
      row: { id: LEASE_ID, residentEmail: "new-tenant@example.com" },
    });

    expect(res.status).toBe(200);
    const written = upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.resident_email).toBe("new-tenant@example.com");
  });
});

/**
 * The columns are only half the scope surface: `row_data` is what the manager's
 * browser store reads back from GET and re-sends on its next `replace`, where
 * the client-named scope would promote it into the columns. So a resident who
 * may edit the BODY of their own lease could launder a stranger's address in
 * through `row_data` one hop later.
 */
describe("portal-lease-pipeline — row_data can never decide scope", () => {
  it("survives the full resident-writes → manager-syncs loop", async () => {
    asResident();
    const residentRes = await post({
      action: "upsert",
      row: {
        id: LEASE_ID,
        residentEmail: "victim@example.com",
        residentUserId: "99999999-9999-9999-9999-999999999999",
        managerUserId: "attacker-manager",
        propertyId: "victim-managers-property",
        notes: "hello",
      },
    });
    expect(residentRes.status).toBe(200);

    const residentWrite = upsert.mock.calls[0]![0] as Record<string, unknown>;
    const persistedRowData = residentWrite.row_data as Record<string, unknown>;
    expect(persistedRowData.residentEmail).toBe(RESIDENT_EMAIL);
    expect(persistedRowData.residentUserId).toBe(RESIDENT_ID);
    expect(persistedRowData.managerUserId).toBe(OWNER_MANAGER);
    expect(persistedRowData.propertyId).toBe("prop-1");
    expect(persistedRowData.notes).toBe("hello");

    // Hop two: the manager's store reads that row_data back and re-syncs it.
    upsert.mockClear();
    PROFILE = { email: "manager@example.com", role: "manager" };
    PROFILE_ROLES = ["manager"];
    PORTAL_ROLES = ["manager"];
    EFFECTIVE_ROLE = "manager";
    getUser.mockResolvedValue({ data: { user: { id: OWNER_MANAGER, email: "manager@example.com" } }, error: null });

    const managerRes = await post({ action: "replace", rows: [persistedRowData] });
    expect(managerRes.status).toBe(200);
    const managerWrite = upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(managerWrite.resident_email).toBe(RESIDENT_EMAIL);
    expect(managerWrite.resident_user_id).toBe(RESIDENT_ID);
    expect(managerWrite.property_id).toBe("prop-1");
    expect(managerWrite.manager_user_id).toBe(OWNER_MANAGER);
  });

  it("drops snake_case scope aliases so they cannot smuggle a value past the mirror", async () => {
    asResident();
    const res = await post({
      action: "upsert",
      row: { id: LEASE_ID, residentEmail: RESIDENT_EMAIL, resident_email: "victim@example.com" },
    });

    expect(res.status).toBe(200);
    const rowData = (upsert.mock.calls[0]![0] as Record<string, unknown>).row_data as Record<string, unknown>;
    expect(rowData.resident_email).toBeUndefined();
    expect(rowData.residentEmail).toBe(RESIDENT_EMAIL);
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

  /**
   * Admin GET returns the whole table, and an admin previewing a manager portal
   * drives the same browser store that posts `action: "replace"`. Rebuilding
   * scope from those rows blanked `manager_user_id` AND `property_id` — the only
   * two columns `fetchLeasesForManagerUser` matches on — so the lease went
   * invisible to the manager who owns it.
   */
  it("keeps the stored scope for fields an ordinary client row does not name", async () => {
    const res = await post({
      action: "replace",
      rows: [{ id: LEASE_ID, residentEmail: RESIDENT_EMAIL, managerUserId: null, residentUserId: null }],
    });

    expect(res.status).toBe(200);
    const written = upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.property_id).toBe("prop-1");
    expect(written.manager_user_id).toBe(OWNER_MANAGER);
    expect(written.resident_user_id).toBe(RESIDENT_ID);
    expect(written.resident_email).toBe(RESIDENT_EMAIL);
  });

  it("selects every scope column the admin branch falls back to", async () => {
    await post({ action: "upsert", row: { id: LEASE_ID, residentEmail: RESIDENT_EMAIL } });
    const select = SELECTS.find((cols) => cols.includes("row_data")) ?? "";
    for (const column of ["manager_user_id", "resident_user_id", "resident_email", "property_id"]) {
      expect(select).toContain(column);
    }
  });

  it("may still re-point a scope column it names outright", async () => {
    const res = await post({
      action: "upsert",
      row: { id: LEASE_ID, residentEmail: "elsewhere@example.com", propertyId: "prop-2" },
    });

    expect(res.status).toBe(200);
    const written = upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.resident_email).toBe("elsewhere@example.com");
    expect(written.property_id).toBe("prop-2");
  });
});

/**
 * `previouslySigned` is read from the pre-batch SELECT, so a repeated id used to
 * capture `false` twice once validation and persistence became two passes —
 * filing the same lease into the manager's library as a duplicate.
 */
describe("portal-lease-pipeline — one plan per id in a batch", () => {
  beforeEach(() => {
    PROFILE = { email: "manager@example.com", role: "manager" };
    PROFILE_ROLES = ["manager"];
    PORTAL_ROLES = ["manager"];
    EFFECTIVE_ROLE = "manager";
    getUser.mockResolvedValue({ data: { user: { id: OWNER_MANAGER, email: "manager@example.com" } }, error: null });
  });

  it("auto-files once when one replace batch carries the same id twice", async () => {
    STORED.row_data = { ...DEFAULT_STORED_ROW_DATA, generatedHtml: "<p>Lease</p>" };
    const signed = {
      id: LEASE_ID,
      residentEmail: RESIDENT_EMAIL,
      fullySignedAt: "2026-05-01T00:00:00Z",
      generatedHtml: "<p>Lease</p>",
    };

    const res = await post({ action: "replace", rows: [signed, { ...signed, notes: "later" }] });

    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(autoFileLeaseDocument).toHaveBeenCalledTimes(1);
    const written = upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect((written.row_data as Record<string, unknown>).notes).toBe("later");
  });
});

/**
 * Auto-file renders the row's document into the PROPERTY OWNER's library, and
 * `reconcileRowScope` now pins `managerUserId` to the stored owner so it fires
 * reliably on a resident-initiated countersign. That is the intended outcome —
 * but it makes the document body on that transition tenant-supplied text
 * heading into someone else's library, so a resident may sign a lease and may
 * replace one, never both in the same write.
 */
describe("portal-lease-pipeline resident — cannot author and sign in one write", () => {
  beforeEach(() => {
    asResident();
    STORED.row_data = {
      ...DEFAULT_STORED_ROW_DATA,
      generatedHtml: "<p>Manager's lease</p>",
      bucket: "resident",
      status: "Resident Signature Pending",
      managerSignature: { role: "manager", name: "Property Manager", signedAtIso: "2026-05-01T00:00:00Z" },
    };
  });

  it("refuses a write that supplies the document body and the signature together", async () => {
    const res = await post({
      action: "upsert",
      row: {
        id: LEASE_ID,
        residentEmail: RESIDENT_EMAIL,
        generatedHtml: "<p>Resident's own text</p>",
        signatureName: "Resident",
        signedAtIso: "2026-05-01T00:00:00Z",
        fullySignedAt: "2026-05-01T00:00:00Z",
      },
    });

    expect(res.status).toBe(409);
    expect(upsert).not.toHaveBeenCalled();
    expect(autoFileLeaseDocument).not.toHaveBeenCalled();
  });

  /**
   * `fullySignedAt` alone is what auto-file keys on, so a payload carrying it
   * with NO signature object used to slip past a signature-keyed guard and
   * still render into the owner's library. One predicate now answers both.
   */
  it("refuses a body change carrying only fullySignedAt, with no signature object", async () => {
    const res = await post({
      action: "upsert",
      row: {
        id: LEASE_ID,
        residentEmail: RESIDENT_EMAIL,
        generatedHtml: "<p>arbitrary</p>",
        fullySignedAt: "2026-05-01T00:00:00Z",
      },
    });

    expect(res.status).toBe(409);
    expect(upsert).not.toHaveBeenCalled();
    expect(autoFileLeaseDocument).not.toHaveBeenCalled();
  });

  it("still lets the resident countersign the document the manager authored", async () => {
    const res = await post({
      action: "upsert",
      row: {
        id: LEASE_ID,
        residentEmail: RESIDENT_EMAIL,
        generatedHtml: "<p>Manager's lease</p>",
        signatureName: "Resident",
        signedAtIso: "2026-05-01T00:00:00Z",
        fullySignedAt: "2026-05-01T00:00:00Z",
      },
    });

    expect(res.status).toBe(200);
    expect(autoFileLeaseDocument).toHaveBeenCalledTimes(1);
    // Auto-file lands in the OWNER's library, not the signer's.
    const filed = autoFileLeaseDocument.mock.calls[0]![1] as Record<string, unknown>;
    expect(filed.managerUserId).toBe(OWNER_MANAGER);
    expect(filed.generatedHtml).toBe("<p>Manager's lease</p>");
  });

  /** `residentUploadLeasePdf` replaces the body but clears every signature. */
  it("still lets the resident upload a replacement document with the signatures cleared", async () => {
    const res = await post({
      action: "upsert",
      row: {
        id: LEASE_ID,
        residentEmail: RESIDENT_EMAIL,
        generatedHtml: null,
        managerUploadedPdf: { dataUrl: "data:application/pdf;base64,AAA", originalDataUrl: "data:application/pdf;base64,AAA", fileName: "lease.pdf", uploadedAt: "2026-05-01T00:00:00Z" },
        signatureName: null,
        signedAtIso: null,
      },
    });

    expect(res.status).toBe(200);
    expect(autoFileLeaseDocument).not.toHaveBeenCalled();
  });

  /**
   * `syncApprovedApplications` seeds the existing-resident onboarding row —
   * both signatures, the manager's off-platform PDF, `externallySignedLease` —
   * onto a row that carries NO document yet, and that materialization runs in
   * the RESIDENT's browser too. Filling an absent body with an already-executed
   * paper lease is not authoring one, so it must still sync. What admits it is
   * the BYTES matching the PDF the manager filed on the application record, not
   * the flag in the request.
   */
  const seedOnboardingLease = (pdfDataUrl: string) =>
    post({
      action: "upsert",
      row: {
        id: LEASE_ID,
        residentEmail: RESIDENT_EMAIL,
        axisId: APPLICATION_ID,
        generatedHtml: null,
        managerUploadedPdf: {
          dataUrl: pdfDataUrl,
          fileName: "signed-lease.pdf",
          uploadedAt: "2026-05-01T00:00:00Z",
        },
        managerSignature: { role: "manager", name: "Property Manager", signedAtIso: "2026-05-01T00:00:00Z" },
        residentSignature: { role: "resident", name: "Resident", signedAtIso: "2026-05-01T00:00:00Z" },
        signatureName: "Resident",
        signedAtIso: "2026-05-01T00:00:00Z",
        fullySignedAt: "2026-05-01T00:00:00Z",
        externallySignedLease: true,
      },
    });

  it("still lets the resident's browser seed an externally-signed onboarding lease", async () => {
    STORED.row_data = { ...DEFAULT_STORED_ROW_DATA };
    const res = await seedOnboardingLease(MANAGER_FILED_PDF);

    expect(res.status).toBe(200);
    expect(autoFileLeaseDocument).toHaveBeenCalledTimes(1);
  });

  /**
   * The same payload shape carrying bytes the manager never filed. Nothing in
   * the request may grant the trust — the flag is set, the signatures are set,
   * and it is still refused.
   */
  it("refuses the same shape when the PDF is not the one the manager filed", async () => {
    STORED.row_data = { ...DEFAULT_STORED_ROW_DATA };
    const res = await seedOnboardingLease("data:application/pdf;base64,ATTACKER");

    expect(res.status).toBe(409);
    expect(upsert).not.toHaveBeenCalled();
    expect(autoFileLeaseDocument).not.toHaveBeenCalled();
  });

  it("refuses the manager-filed bytes when they belong to another manager's application", async () => {
    STORED.row_data = { ...DEFAULT_STORED_ROW_DATA };
    APPLICATION_RECORD = null;
    const res = await seedOnboardingLease(MANAGER_FILED_PDF);

    expect(res.status).toBe(409);
    expect(autoFileLeaseDocument).not.toHaveBeenCalled();
  });

  /** The corroboration is for an off-platform PDF, never for HTML beside it. */
  it("does not let the externallySignedLease flag smuggle in a generated body", async () => {
    STORED.row_data = { ...DEFAULT_STORED_ROW_DATA };
    const res = await post({
      action: "upsert",
      row: {
        id: LEASE_ID,
        residentEmail: RESIDENT_EMAIL,
        generatedHtml: "<p>arbitrary</p>",
        fullySignedAt: "2026-05-01T00:00:00Z",
        externallySignedLease: true,
      },
    });

    expect(res.status).toBe(409);
    expect(autoFileLeaseDocument).not.toHaveBeenCalled();
  });

  /**
   * A matching PDF corroborates the PDF, not whatever else rides along. The
   * seeded onboarding row is PDF-only, so HTML beside the manager-filed bytes
   * has no legitimate shape.
   */
  it("refuses arbitrary HTML riding along with the manager-filed PDF", async () => {
    STORED.row_data = { ...DEFAULT_STORED_ROW_DATA };
    const res = await post({
      action: "upsert",
      row: {
        id: LEASE_ID,
        residentEmail: RESIDENT_EMAIL,
        axisId: APPLICATION_ID,
        generatedHtml: "<p>arbitrary</p>",
        managerUploadedPdf: {
          dataUrl: MANAGER_FILED_PDF,
          fileName: "signed-lease.pdf",
          uploadedAt: "2026-05-01T00:00:00Z",
        },
        signatureName: "Resident",
        signedAtIso: "2026-05-01T00:00:00Z",
        fullySignedAt: "2026-05-01T00:00:00Z",
      },
    });

    expect(res.status).toBe(409);
    expect(upsert).not.toHaveBeenCalled();
    expect(autoFileLeaseDocument).not.toHaveBeenCalled();
  });

  /**
   * `externallySignedLease` reaches the stored row through `row_data`, which is
   * persisted verbatim, so a stored flag is just an earlier client write. Setting
   * it costs nothing on its own — the write claims no execution and replaces no
   * body — and it must buy nothing on the next write either.
   */
  it("refuses an arbitrary PDF on a row the resident flagged externallySignedLease first", async () => {
    STORED.row_data = { ...DEFAULT_STORED_ROW_DATA };

    const first = await post({
      action: "upsert",
      row: { id: LEASE_ID, residentEmail: RESIDENT_EMAIL, externallySignedLease: true },
    });
    expect(first.status).toBe(200);
    STORED.row_data = (upsert.mock.calls[0]![0] as Record<string, unknown>).row_data as Record<string, unknown>;
    expect(STORED.row_data.externallySignedLease).toBe(true);

    const second = await seedOnboardingLease("data:application/pdf;base64,ATTACKER");

    expect(second.status).toBe(409);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(autoFileLeaseDocument).not.toHaveBeenCalled();
  });

  /**
   * Two writes, no manager cooperation: mark the row executed while the body
   * still matches (which the first guard allows, since nothing is replaced),
   * then replace the body on a row the product now shows as fully signed. Both
   * guards read the same execution predicate, so the second write is refused.
   */
  it("refuses a body replacement on a row the resident just marked executed", async () => {
    STORED.row_data = { ...DEFAULT_STORED_ROW_DATA, generatedHtml: "<p>Manager's lease</p>" };

    const first = await post({
      action: "upsert",
      row: {
        id: LEASE_ID,
        residentEmail: RESIDENT_EMAIL,
        generatedHtml: "<p>Manager's lease</p>",
        fullySignedAt: "2026-05-01T00:00:00Z",
      },
    });
    expect(first.status).toBe(200);
    STORED.row_data = (upsert.mock.calls[0]![0] as Record<string, unknown>).row_data as Record<string, unknown>;

    const second = await post({
      action: "upsert",
      row: {
        id: LEASE_ID,
        residentEmail: RESIDENT_EMAIL,
        generatedHtml: "<p>Resident's own text</p>",
        fullySignedAt: "2026-05-01T00:00:00Z",
      },
    });

    expect(second.status).toBe(409);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

describe("portal-lease-pipeline resident — signature write guards (PRP-251)", () => {
  const awaitingResident = {
    ...DEFAULT_STORED_ROW_DATA,
    generatedHtml: "<p>Manager's lease v1</p>",
    bucket: "resident",
    status: "Resident Signature Pending",
    managerSignature: { role: "manager", name: "Property Manager", signedAtIso: "2026-05-01T00:00:00Z" },
  };

  beforeEach(() => {
    asResident();
    STORED.row_data = { ...awaitingResident };
  });

  it("refuses a second resident signature over an existing one", async () => {
    STORED.row_data = {
      ...awaitingResident,
      residentSignature: { role: "resident", name: "Resident", signedAtIso: "2026-05-01T00:00:00Z" },
      signatureName: "Resident",
      signedAtIso: "2026-05-01T00:00:00Z",
    };

    const res = await post({
      action: "upsert",
      row: {
        id: LEASE_ID,
        residentEmail: RESIDENT_EMAIL,
        generatedHtml: "<p>Manager's lease v1</p>",
        residentSignature: { role: "resident", name: "Resident Again", signedAtIso: "2026-05-02T00:00:00Z" },
        signatureName: "Resident Again",
        signedAtIso: "2026-05-02T00:00:00Z",
      },
    });

    expect(res.status).toBe(409);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses signing while the lease is still in manager review", async () => {
    STORED.row_data = {
      ...awaitingResident,
      bucket: "manager",
      status: "Manager Review",
      managerSignature: null,
    };

    const res = await post({
      action: "upsert",
      row: {
        id: LEASE_ID,
        residentEmail: RESIDENT_EMAIL,
        generatedHtml: "<p>Manager's lease v1</p>",
        signatureName: "Resident",
        signedAtIso: "2026-05-01T00:00:00Z",
      },
    });

    expect(res.status).toBe(409);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses signing when the submitted document body is stale", async () => {
    const res = await post({
      action: "upsert",
      row: {
        id: LEASE_ID,
        residentEmail: RESIDENT_EMAIL,
        generatedHtml: "<p>Stale copy the resident still has open</p>",
        signatureName: "Resident",
        signedAtIso: "2026-05-01T00:00:00Z",
      },
    });

    expect(res.status).toBe(409);
    expect(upsert).not.toHaveBeenCalled();
  });
});

/**
 * Naming ANOTHER person as the resident is a manager capability. The create
 * branch was otherwise merely "not admin, not resident", which a vendor — or an
 * authenticated account with no profile row and no roles — also satisfies.
 */
describe("portal-lease-pipeline CREATE — only a manager may name someone else", () => {
  const plant = () =>
    post({
      action: "upsert",
      row: {
        id: "lease_app_planted",
        residentEmail: "victim@example.com",
        status: "Fully Signed",
        fullySignedAt: "2026-05-01T00:00:00Z",
      },
    });

  beforeEach(() => {
    RECORD_EXISTS = false;
  });

  it("refuses a vendor-role account", async () => {
    PROFILE = { email: "vendor@example.com", role: "vendor" };
    PROFILE_ROLES = [];
    PORTAL_ROLES = ["vendor"];
    EFFECTIVE_ROLE = "vendor";
    getUser.mockResolvedValue({ data: { user: { id: "vendor-user", email: "vendor@example.com" } }, error: null });

    const res = await plant();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Only a property manager can create a lease record." });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses an authenticated account with no profile row and no roles", async () => {
    PROFILE = null;
    PROFILE_ROLES = [];
    PORTAL_ROLES = [];
    EFFECTIVE_ROLE = null;
    getUser.mockResolvedValue({ data: { user: { id: "drifter", email: "drifter@example.com" } }, error: null });

    const res = await plant();
    expect(res.status).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("still lets a real manager create a lease naming their tenant", async () => {
    PROFILE = { email: "manager@example.com", role: "manager" };
    PROFILE_ROLES = ["manager"];
    PORTAL_ROLES = ["manager"];
    EFFECTIVE_ROLE = "manager";
    getUser.mockResolvedValue({ data: { user: { id: OWNER_MANAGER, email: "manager@example.com" } }, error: null });

    const res = await post({
      action: "upsert",
      row: { id: "lease_app_new", residentEmail: "tenant@example.com", propertyId: "prop-1" },
    });

    expect(res.status).toBe(200);
    const written = upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.resident_email).toBe("tenant@example.com");
    expect(written.manager_user_id).toBe(OWNER_MANAGER);
  });

  it("leaves admin unchanged", async () => {
    PROFILE = { email: "admin@example.com", role: "admin" };
    PROFILE_ROLES = [];
    PORTAL_ROLES = ["admin"];
    EFFECTIVE_ROLE = "admin";
    isAdminUser.mockResolvedValue(true);
    getUser.mockResolvedValue({ data: { user: { id: "admin-user", email: "admin@example.com" } }, error: null });

    const res = await plant();
    expect(res.status).toBe(200);
    const written = upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.resident_email).toBe("victim@example.com");
  });
});

/**
 * `property_id` is a scope SELECTOR, not a resident field:
 * `fetchLeasesForManagerUser` pulls every row whose property is in the caller's
 * linked set, so naming a stranger's property moves the row into their pipeline.
 */
describe("portal-lease-pipeline — client-named property_id is validated against ownership", () => {
  beforeEach(() => {
    PROFILE = { email: "manager@example.com", role: "manager" };
    PROFILE_ROLES = ["manager"];
    PORTAL_ROLES = ["manager"];
    EFFECTIVE_ROLE = "manager";
    getUser.mockResolvedValue({ data: { user: { id: OWNER_MANAGER, email: "manager@example.com" } }, error: null });
  });

  it("refuses an update that moves the lease onto a property the caller neither owns nor is linked to", async () => {
    managerMayFileLeaseUnderProperty.mockResolvedValue({ ok: true, allowed: false, propertyExists: true });

    const res = await post({
      action: "upsert",
      row: { id: LEASE_ID, residentEmail: RESIDENT_EMAIL, propertyId: "someone-elses-property" },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "That property is not yours to file a lease under." });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses a create naming a property the caller neither owns nor is linked to", async () => {
    RECORD_EXISTS = false;
    managerMayFileLeaseUnderProperty.mockResolvedValue({ ok: true, allowed: false, propertyExists: true });

    const res = await post({
      action: "upsert",
      row: { id: "lease_app_new", residentEmail: "tenant@example.com", propertyId: "someone-elses-property" },
    });

    expect(res.status).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("allows a property the ownership check accepts — owner or co-manager alike", async () => {
    RECORD_EXISTS = false;
    managerMayFileLeaseUnderProperty.mockResolvedValue({ ok: true, allowed: true, propertyExists: true });

    const res = await post({
      action: "upsert",
      row: { id: "lease_app_new", residentEmail: "tenant@example.com", propertyId: "linked-prop" },
    });

    expect(res.status).toBe(200);
    const written = upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.property_id).toBe("linked-prop");
  });

  it("does not re-validate an unchanged property, so a deleted property still saves", async () => {
    managerMayFileLeaseUnderProperty.mockResolvedValue({ ok: true, allowed: false, propertyExists: true });

    const res = await post({
      action: "upsert",
      row: { id: LEASE_ID, residentEmail: RESIDENT_EMAIL, propertyId: STORED.property_id },
    });

    expect(res.status).toBe(200);
    expect(managerMayFileLeaseUnderProperty).not.toHaveBeenCalled();
  });

  it("fails closed when the ownership lookup errors", async () => {
    managerMayFileLeaseUnderProperty.mockResolvedValue({ ok: false, error: "boom" });

    const res = await post({
      action: "upsert",
      row: { id: LEASE_ID, residentEmail: RESIDENT_EMAIL, propertyId: "another-property" },
    });

    expect(res.status).toBe(500);
    expect(upsert).not.toHaveBeenCalled();
  });

  /**
   * "Not allowed" is not the same answer as "someone else's". A deleted
   * listing — and any id that was never persisted as a property record — has no
   * `manager_property_records` row at all, and refusing those would 403 an
   * ordinary save.
   */
  it("saves a row whose property record is absent rather than refusing it", async () => {
    RECORD_EXISTS = false;
    managerMayFileLeaseUnderProperty.mockResolvedValue({ ok: true, allowed: false, propertyExists: false });

    const res = await post({
      action: "upsert",
      row: { id: "lease_app_new", residentEmail: "tenant@example.com", propertyId: "deleted-property" },
    });

    expect(res.status).toBe(200);
    const written = upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.property_id).toBe("deleted-property");
  });

  /**
   * The browser store posts the manager's ENTIRE row set as one `replace`, so a
   * refusal that fires mid-loop leaves the earlier rows already written — a
   * partial save behind a 403 that names no row.
   */
  it("writes nothing when a later row in the batch names an unowned property", async () => {
    managerMayFileLeaseUnderProperty.mockResolvedValue({ ok: true, allowed: false, propertyExists: true });

    const res = await post({
      action: "replace",
      rows: [
        { id: LEASE_ID, residentEmail: RESIDENT_EMAIL, notes: "fine" },
        { id: "lease_app_new", residentEmail: "tenant@example.com", propertyId: "someone-elses-property" },
      ],
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "That property is not yours to file a lease under." });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("still writes a whole batch containing a row whose property record is absent", async () => {
    managerMayFileLeaseUnderProperty.mockResolvedValue({ ok: true, allowed: false, propertyExists: false });

    const res = await post({
      action: "replace",
      rows: [
        { id: LEASE_ID, residentEmail: RESIDENT_EMAIL, notes: "fine" },
        { id: "lease_app_new", residentEmail: "tenant@example.com", propertyId: "deleted-property" },
      ],
    });

    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledTimes(2);
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
