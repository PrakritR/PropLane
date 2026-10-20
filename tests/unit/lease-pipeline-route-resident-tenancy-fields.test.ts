/**
 * `loadResidentManagerAttestedTenancy` unlocks My home, Payments, Lease, Services and Documents off two row
 * fields alone: `signedLeaseSnapshots` (the renewal archive) and `managerAttestedTenancyAt` (existing-resident
 * onboarding). Both are written only by the server. A resident can create and update a lease row in their own
 * email scope, so without this guard an applicant who never signed could POST either field and let themselves
 * into the full tenant portal. The route handler is driven directly: the client store is advisory.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state: { user: { id: string; email: string }; profile: { email: string; role: string }; leases: Row[] } = {
  user: { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", email: "applicant@example.com" },
  profile: { email: "applicant@example.com", role: "resident" },
  leases: [],
};

function makeQuery(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let orMatch: ((r: Row) => boolean) | null = null;
  const rows = () => (table === "portal_lease_pipeline_records" ? state.leases : []);
  const matches = () => rows().filter((r) => filters.every((f) => f(r)) && (!orMatch || orMatch(r)));
  const q: Record<string, unknown> = {
    select: () => q,
    order: () => q,
    eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return q; },
    is: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return q; },
    or: () => { orMatch = (r) => r.resident_email === state.user.email || r.resident_user_id === state.user.id; return q; },
    limit: () => Promise.resolve({ data: matches(), error: null }),
    maybeSingle: () => Promise.resolve({ data: matches()[0] ?? null, error: null }),
    upsert: (payload: Row) => {
      const index = state.leases.findIndex((r) => r.id === payload.id);
      if (index === -1) state.leases.push({ ...payload });
      else state.leases[index] = { ...payload };
      return Promise.resolve({ data: null, error: null });
    },
    update: () => q,
    delete: () => q,
  };
  return q;
}

const db = {
  rpc: async (_name: string, args: { p_record: Row }) => {
    const payload = args.p_record;
    const index = state.leases.findIndex((row) => row.id === payload.id);
    if (index === -1) state.leases.push({ ...payload });
    else state.leases[index] = { ...payload };
    return { data: "persisted", error: null };
  },
  from: (table: string) => {
    if (table === "profiles") {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.profile }) }) }) };
    }
    return makeQuery(table);
  },
};

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => db }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/resident-role-access", () => ({
  authorizeResidentRole: async () => true,
  resolveResidentScopedActorRole: async () => "resident",
}));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  fetchLeasesForManagerUser: async () => [],
  managerCanAccessLeaseRecord: async () => false,
  managerMayFileLeaseUnderProperty: async () => ({ ok: true, allowed: true }),
}));
vi.mock("@/lib/documents/document-auto-file-hooks.server", () => ({ autoFileLeaseDocument: async () => undefined }));
vi.mock("@/lib/domain-action-events.server", () => ({
  buildDurableLeaseTransitionEnvelope: vi.fn(() => null),
  leaseEventForTransition: vi.fn(() => null),
}));
vi.mock("@/lib/auth/portal-access", () => ({
  ACTIVE_PORTAL_COOKIE: "axis_active_portal",
  hasRole: (ctx: { roles: string[] }, role: string) => ctx.roles.includes(role),
  getPortalAccessContext: async () => ({ user: null, profile: null, roles: ["resident"], effectiveRole: "resident" }),
}));

import { POST } from "@/app/api/portal-lease-pipeline/route";
import { leaseRowIsMidRenewal } from "@/lib/resident-portal-access";

const FORGED_SNAPSHOT = { id: "snap-x", label: "Prior lease", fullySignedAt: "2026-01-01T00:00:00.000Z", archivedAtIso: "2026-01-01T00:00:00.000Z" };

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/portal-lease-pipeline", { method: "POST", body: JSON.stringify(body) }));

const stored = () => state.leases[0]?.row_data as Row | undefined;

beforeEach(() => {
  state.user = { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", email: "applicant@example.com" };
  state.profile = { email: "applicant@example.com", role: "resident" };
  state.leases = [];
});

describe("a resident-authored lease write cannot plant an existing tenancy", () => {
  it("drops signedLeaseSnapshots and managerAttestedTenancyAt from a row the resident CREATES", async () => {
    const response = await post({
      action: "upsert",
      row: {
        id: "lease_forged_1",
        residentEmail: "applicant@example.com",
        status: "Manager Review",
        signedLeaseSnapshots: [FORGED_SNAPSHOT],
        managerAttestedTenancyAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(response.status).toBe(200);
    expect(stored()).toBeTruthy();
    expect(stored()!.signedLeaseSnapshots).toBeUndefined();
    expect(stored()!.managerAttestedTenancyAt).toBeUndefined();
    // The read that grants tenancy-level access therefore still says no.
    expect(leaseRowIsMidRenewal(stored()!)).toBe(false);
  });

  it("drops them from an UPDATE of a row already in the resident's own scope", async () => {
    state.leases = [{
      id: "lease_mine",
      manager_user_id: "mgr-1",
      resident_user_id: state.user.id,
      resident_email: "applicant@example.com",
      property_id: null,
      status: "manager",
      row_data: { id: "lease_mine", residentEmail: "applicant@example.com", status: "Manager Review" },
    }];
    const response = await post({
      action: "upsert",
      row: {
        id: "lease_mine",
        residentEmail: "applicant@example.com",
        status: "Manager Review",
        signedLeaseSnapshots: [FORGED_SNAPSHOT],
        managerAttestedTenancyAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(response.status).toBe(200);
    expect(stored()!.signedLeaseSnapshots).toBeUndefined();
    expect(stored()!.managerAttestedTenancyAt).toBeUndefined();
  });

  it("keeps the stored server-written values rather than letting a resident write erase them", async () => {
    const realSnapshot = { ...FORGED_SNAPSHOT, id: "snap-real" };
    state.leases = [{
      id: "lease_mine",
      manager_user_id: "mgr-1",
      resident_user_id: state.user.id,
      resident_email: "applicant@example.com",
      property_id: null,
      status: "manager",
      row_data: {
        id: "lease_mine", residentEmail: "applicant@example.com", status: "Resident Signature Pending",
        signedLeaseSnapshots: [realSnapshot], managerAttestedTenancyAt: "2026-09-04T00:00:00.000Z",
      },
    }];
    const response = await post({
      action: "upsert",
      row: { id: "lease_mine", residentEmail: "applicant@example.com", status: "Resident Signature Pending" },
    });
    expect(response.status).toBe(200);
    expect(stored()!.signedLeaseSnapshots).toEqual([realSnapshot]);
    expect(stored()!.managerAttestedTenancyAt).toBe("2026-09-04T00:00:00.000Z");
    expect(leaseRowIsMidRenewal(stored()!)).toBe(true);
  });
});
