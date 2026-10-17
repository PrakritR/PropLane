/**
 * Applicant identity (SSN, birth date, licence) never lands on, or leaves from,
 * `portal_lease_pipeline_records`. Drives the real route handler:
 * POST strips at the write boundary (a client cannot put it back), GET strips
 * a legacy row that was stored before the fix.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const MANAGER_ID = "11111111-2222-4333-8444-555555555555";
const state: { leases: Row[] } = { leases: [] };

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
    is: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return q;
    },
    limit: () => Promise.resolve({ data: matches(), error: null }),
    maybeSingle: () => Promise.resolve({ data: matches()[0] ?? null, error: null }),
    upsert: (payload: Row) => {
      const idx = state.leases.findIndex((r) => r.id === payload.id);
      if (idx === -1) state.leases.push({ ...payload });
      else state.leases[idx] = { ...payload };
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
    const idx = state.leases.findIndex((row) => row.id === payload.id);
    if (idx === -1) state.leases.push({ ...payload });
    else state.leases[idx] = { ...payload };
    return { data: "persisted", error: null };
  },
  from: (table: string) => {
    if (table === "profiles") {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { email: "manager@axis.test", role: "manager" } }) }),
        }),
      };
    }
    return makeQuery(table);
  },
};

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => db }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: MANAGER_ID, email: "manager@axis.test" } } }) },
  }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  fetchLeasesForManagerUser: async () => state.leases,
  managerCanAccessLeaseRecord: async () => true,
  managerMayFileLeaseUnderProperty: async () => ({ ok: true, allowed: true }),
}));
vi.mock("@/lib/documents/document-auto-file-hooks.server", () => ({
  autoFileLeaseDocument: async () => undefined,
}));
vi.mock("@/lib/domain-action-events.server", () => ({
  buildDurableLeaseTransitionEnvelope: vi.fn(() => null),
  leaseEventForTransition: vi.fn(() => null),
}));
vi.mock("@/lib/auth/portal-access", () => ({
  ACTIVE_PORTAL_COOKIE: "axis_active_portal",
  hasRole: (ctx: { roles: string[] }, role: string) => ctx.roles.includes(role),
  getPortalAccessContext: async () => ({ user: null, profile: null, roles: ["manager"], effectiveRole: "manager" }),
}));

import { GET, POST } from "@/app/api/portal-lease-pipeline/route";

const SSN = "123-45-6789";
const DOB = "1990-02-03";
const LICENSE = "D1234567";
const IDENTITY = { ssn: SSN, dateOfBirth: DOB, driversLicense: LICENSE, _applicantIdentity: { v: 1, ct: "sealed" } };

function draftRow(application: Row): Row {
  return {
    id: "lease_identity_1",
    residentName: "Jordan Lee",
    residentEmail: "jordan.lee@example.com",
    managerUserId: MANAGER_ID,
    bucket: "manager",
    status: "Manager Review",
    generatedHtml: "<p>Lease</p>",
    application,
    signedLeaseSnapshots: [
      {
        id: "snap1",
        label: "Prior term",
        fullySignedAt: "2025-01-01T00:00:00.000Z",
        archivedAtIso: "2026-01-01T00:00:00.000Z",
        application: { ...IDENTITY, email: "jordan.lee@example.com" },
      },
    ],
  };
}

function seed(row: Row) {
  state.leases = [
    {
      id: row.id,
      manager_user_id: MANAGER_ID,
      resident_email: row.residentEmail,
      property_id: null,
      status: "manager",
      row_data: row,
      updated_at: "2026-10-01T00:00:00.000Z",
    },
  ];
}

const stored = () => JSON.stringify(state.leases[0]!.row_data);
const post = (body: unknown) =>
  POST(new Request("http://localhost/api/portal-lease-pipeline", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  state.leases = [];
});

describe("portal-lease-pipeline: applicant identity never lives on a lease", () => {
  it("POST of a row carrying SSN, birth date and licence stores none of them", async () => {
    seed(draftRow({ fullLegalName: "Jordan Lee" }));
    const res = await post({
      action: "upsert",
      row: draftRow({ fullLegalName: "Jordan Lee", leaseStart: "2026-06-01", ...IDENTITY }),
    });
    expect(res.status).toBe(200);
    const json = stored();
    expect(json).not.toContain(SSN);
    expect(json).not.toContain(DOB);
    expect(json).not.toContain(LICENSE);
    expect(json).not.toContain("_applicantIdentity");
    expect(json).not.toContain("dateOfBirth");
    const row = state.leases[0]!.row_data as { application: Row };
    expect(row.application.fullLegalName).toBe("Jordan Lee");
    expect(row.application.leaseStart).toBe("2026-06-01");
  });

  it("GET of a legacy row that still holds plaintext identity returns none of it", async () => {
    seed(draftRow({ fullLegalName: "Jordan Lee", ...IDENTITY }));

    const list = await GET(new Request("http://localhost/api/portal-lease-pipeline"));
    expect(list.status).toBe(200);
    const listBody = JSON.stringify(await list.json());
    expect(listBody).toContain("lease_identity_1");
    for (const secret of [SSN, DOB, LICENSE]) expect(listBody).not.toContain(secret);

    const one = await GET(new Request("http://localhost/api/portal-lease-pipeline?id=lease_identity_1"));
    expect(one.status).toBe(200);
    const oneBody = JSON.stringify(await one.json());
    expect(oneBody).toContain("Jordan Lee");
    for (const secret of [SSN, DOB, LICENSE]) expect(oneBody).not.toContain(secret);
    expect(oneBody).not.toContain("_applicantIdentity");
  });
});
