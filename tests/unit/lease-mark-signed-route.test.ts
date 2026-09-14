/**
 * "Mark as signed" — a manager files a lease that was signed OFF-platform.
 *
 * Drives the real route handler. The generic upsert refuses a request that
 * vouches for its own execution, so this dedicated action is the one place the
 * SERVER writes the signatures — and it must refuse whenever the stored row
 * already carries execution evidence of its own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const MANAGER_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_MANAGER_ID = "66666666-2222-4333-8444-555555555555";
const RESIDENT_ID = "99999999-2222-4333-8444-555555555555";

const state: {
  user: { id: string; email: string } | null;
  profile: { email: string; full_name?: string; role: string };
  leases: Row[];
  autoFiled: Row[];
} = {
  user: { id: MANAGER_ID, email: "manager@axis.test" },
  profile: { email: "manager@axis.test", full_name: "Pat Manager", role: "manager" },
  leases: [],
  autoFiled: [],
};
let RPC_RESULT: "persisted" | "stale" = "persisted";

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
    upsert: (payload: Row) => {
      const idx = state.leases.findIndex((r) => r.id === payload.id);
      if (idx === -1) state.leases.push({ ...payload });
      else state.leases[idx] = { ...payload };
      return Promise.resolve({ data: null, error: null });
    },
    delete: () => q,
  };
  return q;
}

const db = {
  rpc: async (_name: string, args: { p_record: Row }) => {
    if (RPC_RESULT === "stale") return { data: "stale", error: null };
    const payload = args.p_record;
    const idx = state.leases.findIndex((row) => row.id === payload.id);
    if (idx === -1) state.leases.push({ ...payload });
    else state.leases[idx] = { ...payload };
    return { data: "persisted", error: null };
  },
  from: (table: string) => {
    if (table === "profiles") {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.profile }) }) }),
      };
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
  // Ownership is the whole point of this file's 404 cases: only the record's
  // owner passes.
  managerCanAccessLeaseRecord: async (_db: unknown, userId: string, record: { manager_user_id?: string | null }) =>
    record.manager_user_id === userId,
  managerMayFileLeaseUnderProperty: async () => ({ ok: true, allowed: true }),
}));
vi.mock("@/lib/documents/document-auto-file-hooks.server", () => ({
  autoFileLeaseDocument: async (_db: unknown, row: Row) => {
    state.autoFiled.push(row);
    return null;
  },
}));
vi.mock("@/lib/manager-default-tasks.server", () => ({ syncLeaseLifecycleTasks: async () => undefined }));
vi.mock("@/lib/domain-action-events.server", () => ({
  buildDurableLeaseTransitionEnvelope: vi.fn(() => null),
  leaseEventForTransition: vi.fn(() => null),
}));
vi.mock("@/lib/auth/portal-access", () => ({
  ACTIVE_PORTAL_COOKIE: "axis_active_portal",
  hasRole: (ctx: { roles: string[] }, role: string) => ctx.roles.includes(role),
  getPortalAccessContext: async () => ({ user: null, profile: null, roles: ["manager"] }),
}));

import { POST as markSigned } from "@/app/api/portal-lease-pipeline/mark-signed/route";
import { POST as upsert } from "@/app/api/portal-lease-pipeline/route";

const STORED_PDF = `data:application/pdf;base64,${Buffer.from("%PDF-1.4 stored lease bytes").toString("base64")}`;
const SIGNED_PDF = `data:application/pdf;base64,${Buffer.from("%PDF-1.4 SIGNED paper lease bytes").toString("base64")}`;
const GENERATED_HTML = "<html><body>GENERATED DRAFT</body></html>";

function reviewRow(overrides: Row = {}): Row {
  return {
    id: "lease_mark_1",
    axisId: "APP-1",
    residentName: "Luna Testerson",
    residentEmail: "luna.tester@example.com",
    unit: "33 · Room 2",
    managerUserId: MANAGER_ID,
    bucket: "manager",
    status: "Manager Review",
    pdfVersion: 1,
    versionNumber: 1,
    notes: "",
    updated: "today",
    updatedAtIso: "2026-09-13T00:00:00.000Z",
    thread: [],
    generatedHtml: null,
    managerUploadedPdf: { dataUrl: STORED_PDF, originalDataUrl: STORED_PDF, fileName: "Luna-lease.pdf", uploadedAt: "2026-09-13T00:00:00.000Z" },
    managerSignature: null,
    residentSignature: null,
    signatureName: null,
    signedAtIso: null,
    fullySignedAt: null,
    ...overrides,
  };
}

function seed(row: Row = reviewRow(), managerUserId: string = MANAGER_ID) {
  state.leases = [
    {
      id: row.id,
      manager_user_id: managerUserId,
      resident_user_id: null,
      resident_email: row.residentEmail,
      property_id: null,
      status: row.bucket,
      row_data: row,
      updated_at: "2026-09-13T00:00:00.000Z",
    },
  ];
}

function post(body: unknown) {
  return markSigned(
    new Request("http://localhost/api/portal-lease-pipeline/mark-signed", { method: "POST", body: JSON.stringify(body) }),
  );
}

const stored = () => state.leases[0]!.row_data as Row;

describe("POST /api/portal-lease-pipeline/mark-signed", () => {
  beforeEach(() => {
    RPC_RESULT = "persisted";
    state.user = { id: MANAGER_ID, email: "manager@axis.test" };
    state.profile = { email: "manager@axis.test", full_name: "Pat Manager", role: "manager" };
    state.autoFiled = [];
    seed();
  });

  it("marks a Manager Review lease with a stored PDF as fully signed off-platform", async () => {
    const res = await post({ leaseId: "lease_mark_1", signedOn: "2026-09-12" });
    expect(res.status).toBe(200);

    const row = stored();
    expect(row.status).toBe("Fully Signed");
    expect(row.bucket).toBe("signed");
    expect(state.leases[0]!.status).toBe("signed");
    expect(row.externallySignedLease).toBe(true);
    expect(row.fullySignedAt).toBe("2026-09-12T12:00:00.000Z");
    expect(row.managerSignature).toMatchObject({ role: "manager", name: "Pat Manager", signedAtIso: "2026-09-12T12:00:00.000Z" });
    expect(row.residentSignature).toMatchObject({ role: "resident", name: "Luna Testerson", signedAtIso: "2026-09-12T12:00:00.000Z" });
    // The document is untouched: same bytes, same version.
    expect((row.managerUploadedPdf as Row).originalDataUrl).toBe(STORED_PDF);
    expect(row.versionNumber).toBe(1);
    // Never sent, still never sent — a "lease sent" event must not fire here.
    expect(row.sentToResidentAt ?? null).toBeNull();
    expect((row.thread as Row[]).at(-1)?.body).toContain("Marked as signed off-platform by Pat Manager");
    expect(state.autoFiled).toHaveLength(1);
  });

  it("defaults the signing date to now when none is given", async () => {
    const before = Date.now();
    const res = await post({ leaseId: "lease_mark_1" });
    expect(res.status).toBe(200);
    const signedAt = new Date(String(stored().fullySignedAt)).getTime();
    expect(signedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(signedAt).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("files a supplied PDF over a generated draft and marks it", async () => {
    seed(reviewRow({ managerUploadedPdf: null, generatedHtml: GENERATED_HTML }));
    const res = await post({ leaseId: "lease_mark_1", pdf: { dataUrl: SIGNED_PDF, fileName: "Luna-signed.pdf" } });
    expect(res.status).toBe(200);
    const row = stored();
    expect(row.generatedHtml).toBeNull();
    expect((row.managerUploadedPdf as Row).originalDataUrl).toBe(SIGNED_PDF);
    expect((row.managerUploadedPdf as Row).fileName).toBe("Luna-signed.pdf");
    expect(row.versionNumber).toBe(2);
    expect(row.status).toBe("Fully Signed");
  });

  it("treats a supplied PDF byte-equal to the stored one as the same document", async () => {
    const res = await post({ leaseId: "lease_mark_1", pdf: { dataUrl: STORED_PDF, fileName: "Luna-lease.pdf" } });
    expect(res.status).toBe(200);
    expect(stored().versionNumber).toBe(1);
  });

  it("refuses a generated-only lease with no PDF to file", async () => {
    seed(reviewRow({ managerUploadedPdf: null, generatedHtml: GENERATED_HTML }));
    const res = await post({ leaseId: "lease_mark_1" });
    expect(res.status).toBe(400);
    expect(stored().status).toBe("Manager Review");
  });

  it("withdraws an unsigned request out for resident signature", async () => {
    seed(reviewRow({ bucket: "resident", status: "Resident Signature Pending", sentToResidentAt: "2026-09-13T01:00:00.000Z" }));
    const res = await post({ leaseId: "lease_mark_1" });
    expect(res.status).toBe(200);
    expect(stored().status).toBe("Fully Signed");
    expect(stored().sentToResidentAt).toBe("2026-09-13T01:00:00.000Z");
  });

  it("refuses once the resident has e-signed: countersign instead", async () => {
    seed(
      reviewRow({
        bucket: "signed",
        status: "Manager Signature Pending",
        sentToResidentAt: "2026-09-13T01:00:00.000Z",
        residentSignature: { role: "resident", name: "Luna Testerson", signedAtIso: "2026-09-13T02:00:00.000Z" },
      }),
    );
    const res = await post({ leaseId: "lease_mark_1" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("Countersign") });
    expect(stored().managerSignature ?? null).toBeNull();
  });

  it("refuses once the resident returned an offline-signed PDF", async () => {
    seed(reviewRow({ bucket: "signed", status: "Manager Signature Pending", residentReturnedSignedPdfAt: "2026-09-13T02:00:00.000Z" }));
    const res = await post({ leaseId: "lease_mark_1" });
    expect(res.status).toBe(409);
  });

  it("refuses a fully signed lease and a voided lease", async () => {
    seed(
      reviewRow({
        bucket: "signed",
        status: "Fully Signed",
        residentSignature: { role: "resident", name: "Luna Testerson", signedAtIso: "2026-09-13T02:00:00.000Z" },
        managerSignature: { role: "manager", name: "Pat Manager", signedAtIso: "2026-09-13T03:00:00.000Z" },
        fullySignedAt: "2026-09-13T03:00:00.000Z",
      }),
    );
    expect((await post({ leaseId: "lease_mark_1" })).status).toBe(409);

    seed(reviewRow({ status: "Voided", voidedAt: "2026-09-13T04:00:00.000Z" }));
    expect((await post({ leaseId: "lease_mark_1" })).status).toBe(409);
    expect(stored().status).toBe("Voided");
  });

  it("answers 404 for another manager's lease and writes nothing", async () => {
    seed(reviewRow({ managerUserId: OTHER_MANAGER_ID }), OTHER_MANAGER_ID);
    const before = structuredClone(state.leases[0]);
    const res = await post({ leaseId: "lease_mark_1" });
    expect(res.status).toBe(404);
    expect(state.leases[0]).toEqual(before);
  });

  it("answers 404 for an unknown lease id", async () => {
    expect((await post({ leaseId: "lease_nope" })).status).toBe(404);
  });

  it("refuses a resident actor", async () => {
    state.user = { id: RESIDENT_ID, email: "luna.tester@example.com" };
    state.profile = { email: "luna.tester@example.com", role: "resident" };
    const res = await post({ leaseId: "lease_mark_1" });
    expect(res.status).toBe(403);
    expect(stored().status).toBe("Manager Review");
  });

  it("refuses a non-PDF payload and an oversized PDF", async () => {
    const png = `data:image/png;base64,${Buffer.from("not a pdf").toString("base64")}`;
    expect((await post({ leaseId: "lease_mark_1", pdf: { dataUrl: png, fileName: "scan.png" } })).status).toBe(400);

    const big = `data:application/pdf;base64,${Buffer.alloc(3.6 * 1024 * 1024, 1).toString("base64")}`;
    expect((await post({ leaseId: "lease_mark_1", pdf: { dataUrl: big, fileName: "big.pdf" } })).status).toBe(400);
    expect(stored().status).toBe("Manager Review");
  });

  it("refuses a signing date in the future or unparseable", async () => {
    expect((await post({ leaseId: "lease_mark_1", signedOn: "2999-01-01" })).status).toBe(400);
    expect((await post({ leaseId: "lease_mark_1", signedOn: "yesterday-ish" })).status).toBe(400);
    expect(stored().status).toBe("Manager Review");
  });

  it("answers 409 and leaves the newer row alone when the record changed underneath", async () => {
    RPC_RESULT = "stale";
    const before = structuredClone(state.leases[0]);
    expect((await post({ leaseId: "lease_mark_1" })).status).toBe(409);
    expect(state.leases[0]).toEqual(before);
  });

  it("keeps the marked lease immutable under the generic upsert afterwards", async () => {
    expect((await post({ leaseId: "lease_mark_1", signedOn: "2026-09-12" })).status).toBe(200);
    const marked = stored();

    const forged = await upsert(
      new Request("http://localhost/api/portal-lease-pipeline", {
        method: "POST",
        body: JSON.stringify({
          action: "upsert",
          row: {
            ...marked,
            managerUploadedPdf: { dataUrl: SIGNED_PDF, originalDataUrl: SIGNED_PDF, fileName: "swap.pdf", uploadedAt: "2026-09-14T00:00:00.000Z" },
          },
        }),
      }),
    );
    expect(forged.status).toBe(409);
    expect((stored().managerUploadedPdf as Row).originalDataUrl).toBe(STORED_PDF);
  });
});
