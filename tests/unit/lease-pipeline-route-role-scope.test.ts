/**
 * `/api/portal-lease-pipeline` is the data route behind the resident Lease
 * panel — the section this branch exists to unlock. Reading the actor role off
 * the legacy `profiles.role`, a manager+resident fell past the resident-scoped
 * `.or(resident_user_id / resident_email)` query into the manager branch, so
 * the resident portal pulled the manager's whole pipeline AND, when that
 * account rents from a DIFFERENT manager, their own lease was not in the
 * response at all — the captain's "the lease arrives and the resident cannot
 * open it" symptom, one layer below the nav fix.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { oversightTranscript } from "./support/oversight-transcript";
import { parseOrFilterClauses } from "@/lib/supabase/or-filter";

const USER_ID = "user-both";
const RESIDENT_EMAIL = "both@example.com";

const getUser = vi.fn();
const isAdminUser = vi.fn(async () => false);
const fetchLeasesForManagerUser = vi.fn(async () => MANAGER_PIPELINE);

let PROFILE: { email: string; role: string | null } | null = null;
let PROFILE_ROLES: string[] = [];
let PORTAL_ROLES: string[] = [];
let EFFECTIVE_ROLE: string | null = null;

/** Their own lease, on a property managed by SOMEONE ELSE. */
const OWN_LEASE = {
  id: "lease-mine",
  resident_user_id: USER_ID,
  resident_email: RESIDENT_EMAIL,
  manager_user_id: "some-other-manager",
  row_data: { id: "lease-mine", residentEmail: RESIDENT_EMAIL },
  updated_at: "2026-03-01T00:00:00Z",
};
/** A lease in the portfolio this same account MANAGES — never theirs to read as a resident. */
const OWN_PORTFOLIO_LEASE = {
  id: "lease-portfolio",
  resident_user_id: "tenant-user",
  resident_email: "tenant@example.com",
  manager_user_id: USER_ID,
  row_data: { id: "lease-portfolio", residentEmail: "tenant@example.com" },
  updated_at: "2026-02-01T00:00:00Z",
};
const STRANGER_LEASE = {
  id: "lease-stranger",
  resident_user_id: "stranger-user",
  resident_email: "stranger@example.com",
  manager_user_id: "some-other-manager",
  row_data: { id: "lease-stranger", residentEmail: "stranger@example.com" },
  updated_at: "2026-01-01T00:00:00Z",
};

const ALL_LEASES = [OWN_LEASE, OWN_PORTFOLIO_LEASE, STRANGER_LEASE];
const MANAGER_PIPELINE = [OWN_PORTFOLIO_LEASE];

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
  fetchLeasesForManagerUser: (...a: unknown[]) => fetchLeasesForManagerUser(...(a as [])),
  managerCanAccessLeaseRecord: async () => true,
  managerMayFileLeaseUnderProperty: async () => ({ ok: true, allowed: true }),
}));
vi.mock("@/lib/documents/document-auto-file-hooks.server", () => ({
  autoFileLeaseDocument: async () => undefined,
}));
vi.mock("@/lib/domain-action-events.server", () => ({ buildDurableLeaseTransitionEnvelope: vi.fn(() => null), leaseEventForTransition: vi.fn(() => null) }));

/** Chainable Supabase stub that applies the route's `.or()` resident scope. */
function makeDb() {
  return {
    from(table: string) {
      let orFilter = "";
      const rowsFor = () => {
        if (table !== "portal_lease_pipeline_records") return [];
        if (!orFilter) return ALL_LEASES;
        // Parse with the same helper the filter builder is paired with:
        // splitting on "," here modelled a PostgREST where a comma inside a
        // value ends a clause, which is the bug the quoted builder prevents.
        const clauses = parseOrFilterClauses(orFilter);
        return ALL_LEASES.filter((lease) =>
          clauses.some(({ column, value }) => {
            if (column === "resident_user_id") return lease.resident_user_id === value;
            if (column === "resident_email") return lease.resident_email === value;
            return false;
          }),
        );
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => Promise.resolve({ data: rowsFor(), error: null }),
        or: (filter: string) => {
          orFilter = filter;
          return builder;
        },
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

async function loadLeases(query = ""): Promise<{ status: number; ids: string[] }> {
  const { GET } = await import("@/app/api/portal-lease-pipeline/route");
  const res = await GET(new Request(`http://localhost/api/portal-lease-pipeline${query}`));
  if (res.status !== 200) return { status: res.status, ids: [] };
  const body = (await res.json()) as { rows: Array<{ id: string }> };
  return { status: res.status, ids: body.rows.map((row) => row.id) };
}

beforeEach(() => {
  vi.clearAllMocks();
  isAdminUser.mockResolvedValue(false);
  fetchLeasesForManagerUser.mockResolvedValue(MANAGER_PIPELINE);
  getUser.mockResolvedValue({ data: { user: { id: USER_ID, email: RESIDENT_EMAIL } }, error: null });
});

describe("portal-lease-pipeline — manager-only account", () => {
  beforeEach(() => {
    PROFILE = { email: "manager@example.com", role: "manager" };
    PROFILE_ROLES = ["manager"];
    PORTAL_ROLES = ["manager"];
    EFFECTIVE_ROLE = "manager";
  });

  it("still receives its full manager pipeline", async () => {
    const { status, ids } = await loadLeases();
    expect(status).toBe(200);
    expect(fetchLeasesForManagerUser).toHaveBeenCalled();
    expect(ids).toEqual([OWN_PORTFOLIO_LEASE.id]);
  });
});

describe("portal-lease-pipeline — manager+resident acting in the resident portal", () => {
  beforeEach(() => {
    PROFILE = { email: RESIDENT_EMAIL, role: "manager" };
    PROFILE_ROLES = ["manager", "resident"];
    PORTAL_ROLES = ["manager", "resident"];
    EFFECTIVE_ROLE = "resident";
  });

  it("takes the resident branch instead of the manager pipeline", async () => {
    const { status } = await loadLeases();
    expect(status).toBe(200);
    expect(fetchLeasesForManagerUser).not.toHaveBeenCalled();
  });

  it("returns their OWN lease even though a different manager owns that property", async () => {
    const { ids } = await loadLeases();
    expect(ids).toContain(OWN_LEASE.id);
  });

  it("omits leases from the portfolio they manage, and every stranger's lease", async () => {
    const { ids } = await loadLeases();
    expect(ids).not.toContain(OWN_PORTFOLIO_LEASE.id);
    expect(ids).not.toContain(STRANGER_LEASE.id);
    expect(ids).toEqual([OWN_LEASE.id]);
  });
});

describe("portal-lease-pipeline — manager+resident acting in the manager portal", () => {
  beforeEach(() => {
    PROFILE = { email: RESIDENT_EMAIL, role: "manager" };
    PROFILE_ROLES = ["manager", "resident"];
    PORTAL_ROLES = ["manager", "resident"];
    EFFECTIVE_ROLE = "manager";
  });

  it("keeps the manager pipeline", async () => {
    const { ids } = await loadLeases();
    expect(fetchLeasesForManagerUser).toHaveBeenCalled();
    expect(ids).toEqual([OWN_PORTFOLIO_LEASE.id]);
  });
});

describe("portal-lease-pipeline — admin", () => {
  const transcript = oversightTranscript("oversight-lease-pipeline.txt", [
    "GET /api/portal-lease-pipeline — the manager portal's lease read.",
    "Fixture: MANAGER_PIPELINE is the viewer's own (a platform admin who also manages);",
    "ALL_LEASES additionally holds leases belonging to other owners.",
  ]);
  afterAll(() => transcript.write());
  const read = async (query = "", viewer = "platform admin + manager") => {
    const { status, ids } = await loadLeases(query);
    transcript.record("/api/portal-lease-pipeline", query, viewer, status, ids);
    return { status, ids };
  };

  beforeEach(() => {
    PROFILE = { email: "admin@example.com", role: "admin" };
    PROFILE_ROLES = [];
    PORTAL_ROLES = ["admin"];
    EFFECTIVE_ROLE = "admin";
    isAdminUser.mockResolvedValue(true);
  });

  it("an admin in their own manager portal reads only the manager pipeline", async () => {
    const { status, ids } = await read();
    expect(status).toBe(200);
    expect(fetchLeasesForManagerUser).toHaveBeenCalledTimes(1);
    expect(ids).toEqual(MANAGER_PIPELINE.map((lease) => lease.id));
  });

  it("a non-admin sending the oversight parameter is still scoped", async () => {
    isAdminUser.mockResolvedValue(false);
    PROFILE = { email: "mgr@example.com", role: "manager" };
    PORTAL_ROLES = ["manager"];
    EFFECTIVE_ROLE = "manager";
    const { ids } = await read("?oversight=admin", "manager");
    expect(fetchLeasesForManagerUser).toHaveBeenCalledTimes(1);
    expect(ids).toEqual(MANAGER_PIPELINE.map((lease) => lease.id));
  });

  it("still reads every lease, unscoped, when the request asks for oversight", async () => {
    const { status, ids } = await read("?oversight=admin");
    expect(status).toBe(200);
    expect(fetchLeasesForManagerUser).not.toHaveBeenCalled();
    expect(ids).toEqual(ALL_LEASES.map((lease) => lease.id));
  });

  it("a different oversight value is not oversight", async () => {
    const { ids } = await read("?oversight=all");
    expect(fetchLeasesForManagerUser).toHaveBeenCalledTimes(1);
    expect(ids).toEqual(MANAGER_PIPELINE.map((lease) => lease.id));
  });
});

describe("portal-lease-pipeline — admin+resident acting in the resident portal", () => {
  beforeEach(() => {
    PROFILE = { email: RESIDENT_EMAIL, role: "manager" };
    PROFILE_ROLES = ["resident", "vendor", "admin", "manager"];
    PORTAL_ROLES = ["resident", "vendor", "admin", "manager"];
    EFFECTIVE_ROLE = "resident";
    isAdminUser.mockResolvedValue(true);
  });

  it("is the resident, not admin — reads only their own lease", async () => {
    const { status, ids } = await loadLeases();
    expect(status).toBe(200);
    expect(fetchLeasesForManagerUser).not.toHaveBeenCalled();
    expect(ids).toEqual([OWN_LEASE.id]);
  });
});

describe("portal-lease-pipeline — unauthenticated", () => {
  beforeEach(() => {
    PROFILE = null;
    PROFILE_ROLES = [];
    PORTAL_ROLES = [];
    EFFECTIVE_ROLE = null;
    getUser.mockResolvedValue({ data: { user: null }, error: null });
  });

  it("still answers 401", async () => {
    expect((await loadLeases()).status).toBe(401);
  });
});
