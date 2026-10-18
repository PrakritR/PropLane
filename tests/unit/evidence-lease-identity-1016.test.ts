/**
 * EVIDENCE HARNESS — decision 1 of the Oct 16 sweep, at the API boundary.
 *
 * Drives the REAL `/api/portal-lease-pipeline` handler and writes a readable transcript to
 * EVIDENCE_DIR: what a client sends, what the table ends up holding, and what a reader gets
 * back for a legacy row that still has the plaintext identity stored. The transcript is the
 * artifact; the assertions below are the gate.
 *
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-lease-identity-1016.test.ts
 *
 * The in-memory table and the auth/scope mocks are the ones
 * `tests/unit/lease-application-identity-route.test.ts` uses.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const transcript: string[] = [];
const say = (line: string) => transcript.push(line);
const block = (label: string, value: unknown) =>
  say(`${label}\n${JSON.stringify(value, null, 2)}\n`);

afterAll(() => {
  if (!EVIDENCE_DIR) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(EVIDENCE_DIR, "lease-identity-api-transcript.txt"), transcript.join("\n"), "utf8");
});

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

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/portal-lease-pipeline", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  state.leases = [];
});

describe("applicant identity never lands on a lease, and never leaves one", () => {
  it("a POST carrying SSN, birth date, licence and the sealed envelope stores none of them", async () => {
    seed(draftRow({ fullLegalName: "Jordan Lee" }));
    const sent = draftRow({ fullLegalName: "Jordan Lee", leaseStart: "2026-06-01", ...IDENTITY });

    say("================================================================");
    say("A. WRITE BOUNDARY — POST /api/portal-lease-pipeline");
    say("================================================================");
    block("The client sends a lease row carrying the applicant's identity:", {
      action: "upsert",
      row: { id: sent.id, application: sent.application, signedLeaseSnapshots: sent.signedLeaseSnapshots },
    });

    const res = await post({ action: "upsert", row: sent });
    say(`HTTP ${res.status}\n`);
    expect(res.status).toBe(200);

    const storedRow = state.leases[0]!.row_data as Row;
    block("What portal_lease_pipeline_records.row_data now holds:", storedRow);

    const json = JSON.stringify(storedRow);
    for (const secret of [SSN, DOB, LICENSE, "_applicantIdentity", "dateOfBirth"]) expect(json).not.toContain(secret);
    expect((storedRow.application as Row).fullLegalName).toBe("Jordan Lee");
    expect((storedRow.application as Row).leaseStart).toBe("2026-06-01");
    say("Stored: fullLegalName and leaseStart kept; ssn / dateOfBirth / driversLicense /");
    say("_applicantIdentity are absent from row_data.application AND from every");
    say("signedLeaseSnapshots[*].application. A client cannot put them back.\n");
  });

  it("a GET of a legacy row that still holds the plaintext returns none of it", async () => {
    seed(draftRow({ fullLegalName: "Jordan Lee", ...IDENTITY }));

    say("================================================================");
    say("B. READ BOUNDARY — GET /api/portal-lease-pipeline (legacy stored row)");
    say("================================================================");
    block("The row as it sits in the table (pre-migration, with plaintext identity):", state.leases[0]!.row_data);

    const list = await GET(new Request("http://localhost/api/portal-lease-pipeline"));
    const listBody = await list.json();
    say(`GET (list) -> HTTP ${list.status}`);
    block("Response:", listBody);

    const one = await GET(new Request("http://localhost/api/portal-lease-pipeline?id=lease_identity_1"));
    const oneBody = await one.json();
    say(`GET (?id=lease_identity_1) -> HTTP ${one.status}`);
    block("Response:", oneBody);

    for (const body of [listBody, oneBody]) {
      const text = JSON.stringify(body);
      expect(text).toContain("Jordan Lee");
      for (const secret of [SSN, DOB, LICENSE, "_applicantIdentity"]) expect(text).not.toContain(secret);
    }
    say("Read: the resident's name and the lease's own facts come back; the identity does not.");
    say("The stored copy is removed separately by");
    say("supabase/migrations/20261016100000_strip_lease_application_identity.sql");
    say("(see lease-identity-migration-proof.txt, run against a real PostgreSQL).");
  });
});
