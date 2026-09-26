/**
 * night/custom-lease item 4: `POST /api/portal-lease-pipeline` with
 * `action: "delete"` / `"deleteIds"` used to run an unconditional
 * `.delete().eq("id", id)` with no check for `leaseClaimsExecution` — a
 * manager could permanently remove a Fully Signed lease row (and every
 * signature it carries) with nothing server-side to stop them, unlike the
 * routine-save path PRP-385 already guards
 * (`wipesExecutedLeaseWithoutSupersedeIntent`). This suite fails if that
 * refusal is removed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state: {
  user: { id: string; email: string } | null;
  profile: { email: string; role: string };
  leases: Row[];
} = {
  user: { id: "11111111-2222-4333-8444-555555555555", email: "manager@axis.test" },
  profile: { email: "manager@axis.test", role: "manager" },
  leases: [],
};

function makeQuery(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  const rows = () => (table === "portal_lease_pipeline_records" ? state.leases : []);
  const matches = () => rows().filter((r) => filters.every((f) => f(r)));
  const q = {
    select: () => q,
    order: () => q,
    or: () => q,
    eq: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return q;
    },
    limit: () => Promise.resolve({ data: matches(), error: null }),
    maybeSingle: () => Promise.resolve({ data: matches()[0] ?? null, error: null }),
    delete: () => ({
      eq: (col: string, val: unknown) => {
        state.leases = state.leases.filter((r) => r[col] !== val);
        return Promise.resolve({ data: null, error: null });
      },
    }),
  };
  return q;
}

const db = {
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
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  fetchLeasesForManagerUser: async () => [],
  managerCanAccessLeaseRecord: async () => true,
  managerMayFileLeaseUnderProperty: async () => ({ ok: true, allowed: true }),
}));
vi.mock("@/lib/documents/document-auto-file-hooks.server", () => ({ autoFileLeaseDocument: async () => undefined }));
vi.mock("@/lib/domain-action-events.server", () => ({ buildDurableLeaseTransitionEnvelope: vi.fn(() => null), leaseEventForTransition: vi.fn(() => null) }));
vi.mock("@/lib/auth/portal-access", () => ({
  ACTIVE_PORTAL_COOKIE: "axis_active_portal",
  hasRole: (ctx: { roles: string[] }, role: string) => ctx.roles.includes(role),
  getPortalAccessContext: async () => ({ user: null, profile: null, roles: ["manager"] }),
}));

import { POST } from "@/app/api/portal-lease-pipeline/route";

const EXECUTED_HTML = "<html><body>EXECUTED LEASE TEXT</body></html>";

function executedRow(overrides: Row = {}): Row {
  return {
    id: "lease_delete_route_1",
    residentName: "Jordan Lee",
    residentEmail: "jordan.lee@example.com",
    managerUserId: state.user!.id,
    bucket: "signed",
    status: "Fully Signed",
    generatedHtml: EXECUTED_HTML,
    residentSignature: { role: "resident", name: "Jordan Lee", signedAtIso: "2026-07-01T00:00:00.000Z" },
    managerSignature: { role: "manager", name: "Pat Manager", signedAtIso: "2026-07-01T01:00:00.000Z" },
    fullySignedAt: "2026-07-01T01:00:00.000Z",
    ...overrides,
  };
}

function seed(row: Row) {
  state.leases = [
    {
      id: row.id,
      manager_user_id: state.user!.id,
      resident_email: row.residentEmail,
      property_id: null,
      status: "signed",
      row_data: row,
    },
  ];
}

function post(body: unknown) {
  return POST(new Request("http://localhost/api/portal-lease-pipeline", { method: "POST", body: JSON.stringify(body) }));
}

describe("POST /api/portal-lease-pipeline delete: executed leases are refused", () => {
  beforeEach(() => {
    state.user = { id: "11111111-2222-4333-8444-555555555555", email: "manager@axis.test" };
    state.profile = { email: "manager@axis.test", role: "manager" };
  });

  it("refuses action: deleteIds for a Fully Signed row and keeps it", async () => {
    seed(executedRow());
    const res = await post({ action: "deleteIds", ids: ["lease_delete_route_1"] });
    const body = (await res.json()) as { ok: boolean; refused?: string[] };
    expect(body.refused).toEqual(["lease_delete_route_1"]);
    expect(state.leases).toHaveLength(1);
    expect(state.leases[0]!.id).toBe("lease_delete_route_1");
  });

  it("refuses action: delete (singular) for a row claiming execution via legacy signatureName", async () => {
    seed(executedRow({ residentSignature: null, managerSignature: null, signatureName: "Jordan Lee", signedAtIso: "2026-07-01T00:00:00.000Z" }));
    const res = await post({ action: "delete", id: "lease_delete_route_1" });
    const body = (await res.json()) as { ok: boolean; refused?: string[] };
    expect(body.refused).toEqual(["lease_delete_route_1"]);
    expect(state.leases).toHaveLength(1);
  });

  it("still deletes an unsigned row", async () => {
    seed(executedRow({ residentSignature: null, managerSignature: null, status: "Manager Review", bucket: "manager", fullySignedAt: null }));
    const res = await post({ action: "deleteIds", ids: ["lease_delete_route_1"] });
    const body = (await res.json()) as { ok: boolean; refused?: string[] };
    expect(body.ok).toBe(true);
    expect(body.refused ?? []).toEqual([]);
    expect(state.leases).toHaveLength(0);
  });

  it("deletes the unsigned rows in a batch and refuses only the executed one", async () => {
    state.leases = [
      { id: "lease_a", manager_user_id: state.user!.id, resident_email: "a@example.com", property_id: null, status: "manager", row_data: executedRow({ id: "lease_a", residentSignature: null, managerSignature: null, status: "Manager Review", bucket: "manager", fullySignedAt: null }) },
      { id: "lease_b", manager_user_id: state.user!.id, resident_email: "b@example.com", property_id: null, status: "signed", row_data: executedRow({ id: "lease_b" }) },
    ];
    const res = await post({ action: "deleteIds", ids: ["lease_a", "lease_b"] });
    const body = (await res.json()) as { ok: boolean; refused?: string[] };
    expect(body.refused).toEqual(["lease_b"]);
    expect(state.leases.map((r) => r.id)).toEqual(["lease_b"]);
  });
});
