/**
 * The AUTHORITATIVE half of the signed-document guarantee.
 *
 * `preserveSignedLeaseDocuments` runs in the browser against a store the
 * browser owns, so it is advisory: anyone with devtools can POST straight at
 * the route. This suite drives the real route handler and fails if that server
 * check is removed.
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

/** Minimal PostgREST stand-in: enough for select/eq/limit/maybeSingle/upsert. */
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
  managerCanAccessLeaseRecord: async () => true,
  managerMayFileLeaseUnderProperty: async () => ({ ok: true, allowed: true }),
}));
vi.mock("@/lib/documents/document-auto-file-hooks.server", () => ({
  autoFileLeaseDocument: async () => undefined,
}));
vi.mock("@/lib/domain-action-events.server", () => ({ emitLeaseTransition: vi.fn(async () => undefined) }));
// Creating a lease record (no stored row) re-checks the manager role through the portal
// context, not just the profile role this file's user mock carries.
vi.mock("@/lib/auth/portal-access", () => ({
  ACTIVE_PORTAL_COOKIE: "axis_active_portal",
  hasRole: (ctx: { roles: string[] }, role: string) => ctx.roles.includes(role),
  getPortalAccessContext: async () => ({ user: null, profile: null, roles: ["manager"] }),
}));

import { POST } from "@/app/api/portal-lease-pipeline/route";

const EXECUTED_HTML = "<html><body>EXECUTED LEASE TEXT</body></html>";

function executedRow(overrides: Row = {}): Row {
  return {
    id: "lease_route_1",
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

function seedExecuted(row: Row = executedRow()) {
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

const storedRowData = () => state.leases[0]!.row_data as Row;

describe("POST /api/portal-lease-pipeline: signed documents are immutable server-side", () => {
  beforeEach(() => {
    state.user = { id: "11111111-2222-4333-8444-555555555555", email: "manager@axis.test" };
    state.profile = { email: "manager@axis.test", role: "manager" };
    seedExecuted();
  });

  it("refuses to replace the document body of a signed lease", async () => {
    const res = await post({
      action: "upsert",
      row: executedRow({ generatedHtml: "<html><body>FORGED LEASE TEXT</body></html>" }),
    });

    expect(res.status).toBe(409);
    expect(storedRowData().generatedHtml).toBe(EXECUTED_HTML);
  });

  it("refuses the same forgery from the resident, who also passes the visibility check", async () => {
    state.profile = { email: "jordan.lee@example.com", role: "resident" };
    state.user = { id: "99999999-2222-4333-8444-555555555555", email: "jordan.lee@example.com" };

    const res = await post({
      action: "upsert",
      row: executedRow({ generatedHtml: "<html><body>FORGED LEASE TEXT</body></html>" }),
    });

    expect(res.status).toBe(409);
    expect(storedRowData().generatedHtml).toBe(EXECUTED_HTML);
  });

  it("refuses to swap a signed lease's uploaded PDF for a different one", async () => {
    const pdf = (bytes: string) => ({
      dataUrl: `data:application/pdf;base64,${bytes}`,
      originalDataUrl: `data:application/pdf;base64,${bytes}`,
      fileName: "lease.pdf",
      uploadedAt: "2026-07-01T00:00:00.000Z",
    });
    seedExecuted(executedRow({ generatedHtml: null, managerUploadedPdf: pdf("AAA") }));

    const res = await post({
      action: "upsert",
      row: executedRow({ generatedHtml: null, managerUploadedPdf: pdf("ZZZ") }),
    });

    expect(res.status).toBe(409);
    expect((storedRowData().managerUploadedPdf as Row).originalDataUrl).toContain("AAA");
  });

  it("refuses to replace a sent lease before the first signature", async () => {
    const sent = executedRow({
      bucket: "resident",
      status: "Resident Signature Pending",
      residentSignature: null,
      managerSignature: null,
      fullySignedAt: null,
    });
    seedExecuted(sent);

    const res = await post({
      action: "upsert",
      row: { ...sent, generatedHtml: "<html><body>Changed after send</body></html>" },
    });

    expect(res.status).toBe(409);
    expect(storedRowData().generatedHtml).toBe(EXECUTED_HTML);
  });

  it("refuses a resident attempt to replace a manager-review document before signing", async () => {
    const managerReview = executedRow({
      bucket: "manager",
      status: "Manager Review",
      residentSignature: null,
      managerSignature: null,
      fullySignedAt: null,
      versionNumber: 2,
      pdfVersion: 2,
    });
    seedExecuted(managerReview);
    state.profile = { email: "jordan.lee@example.com", role: "resident" };
    state.user = { id: "99999999-2222-4333-8444-555555555555", email: "jordan.lee@example.com" };

    const res = await post({
      action: "upsert",
      row: { ...managerReview, generatedHtml: "<html><body>Resident forgery</body></html>", versionNumber: 3, pdfVersion: 3 },
    });

    expect(res.status).toBe(403);
    expect(storedRowData().generatedHtml).toBe(EXECUTED_HTML);
  });

  it("requires the next document version for a manager-review body replacement", async () => {
    const managerReview = executedRow({
      bucket: "manager",
      status: "Manager Review",
      residentSignature: null,
      managerSignature: null,
      fullySignedAt: null,
      versionNumber: 2,
      pdfVersion: 2,
    });
    seedExecuted(managerReview);

    const res = await post({
      action: "upsert",
      row: { ...managerReview, generatedHtml: "<html><body>Missing version increment</body></html>" },
    });

    expect(res.status).toBe(400);
    expect(storedRowData().generatedHtml).toBe(EXECUTED_HTML);
  });

  it("stamps manager-edit provenance after a versioned manager-review body replacement", async () => {
    const managerReview = executedRow({
      bucket: "manager",
      status: "Manager Review",
      residentSignature: null,
      managerSignature: null,
      fullySignedAt: null,
      versionNumber: 2,
      pdfVersion: 2,
    });
    seedExecuted(managerReview);

    const res = await post({
      action: "upsert",
      row: {
        ...managerReview,
        generatedHtml: "<html><head><style>p { font-weight: 700; }</style></head><body>Versioned manager edit</body></html>",
        versionNumber: 3,
        pdfVersion: 3,
      },
    });

    expect(res.status).toBe(200);
    expect(storedRowData().managerDocumentEditedAtIso).toEqual(expect.any(String));
    expect(storedRowData().generatedAtIso).toEqual(expect.any(String));
    expect(storedRowData().generatedHtml).toContain("<style>p { font-weight: 700; }</style>");
  });

  it("refuses a generated-body deletion that would remove protected disclosures", async () => {
    const protectedBody = "<html><body><!-- proplane-verbatim-disclosure:start:lead --><p>Required disclosure</p><!-- proplane-verbatim-disclosure:end:lead --></body></html>";
    const managerReview = executedRow({
      generatedHtml: protectedBody,
      bucket: "manager",
      status: "Manager Review",
      residentSignature: null,
      managerSignature: null,
      fullySignedAt: null,
    });
    seedExecuted(managerReview);

    const res = await post({ action: "upsert", row: { ...managerReview, generatedHtml: null } });

    expect(res.status).toBe(400);
    expect(storedRowData().generatedHtml).toBe(protectedBody);
  });

  it("still accepts the certificate page being merged into the signed PDF", async () => {
    const base = "data:application/pdf;base64,AAA";
    seedExecuted(
      executedRow({
        generatedHtml: null,
        managerUploadedPdf: { dataUrl: base, originalDataUrl: base, fileName: "lease.pdf", uploadedAt: "x" },
      }),
    );

    const res = await post({
      action: "upsert",
      row: executedRow({
        generatedHtml: null,
        managerUploadedPdf: {
          dataUrl: "data:application/pdf;base64,AAAWITHCERT",
          originalDataUrl: base,
          fileName: "lease.pdf",
          uploadedAt: "x",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect((storedRowData().managerUploadedPdf as Row).dataUrl).toContain("WITHCERT");
  });

  it("still accepts a superseding document once the signatures are cleared", async () => {
    const res = await post({
      action: "upsert",
      row: executedRow({
        generatedHtml: "<html><body>RENEWAL LEASE TEXT</body></html>",
        residentSignature: null,
        managerSignature: null,
        status: "Manager Review",
        bucket: "manager",
        fullySignedAt: null,
      }),
    });

    expect(res.status).toBe(200);
    expect(storedRowData().generatedHtml).toContain("RENEWAL");
  });

  it("still accepts ordinary edits that leave the document alone", async () => {
    const res = await post({ action: "upsert", row: executedRow({ notes: "Filed with the county." }) });

    expect(res.status).toBe(200);
    expect(storedRowData().notes).toBe("Filed with the county.");
    expect(storedRowData().generatedHtml).toBe(EXECUTED_HTML);
  });

  it("sanitizes manager-authored HTML before an unsigned lease row is persisted", async () => {
    const unsigned = executedRow({
      id: "lease_route_unsigned",
      bucket: "manager",
      status: "Manager Review",
      residentSignature: null,
      managerSignature: null,
      fullySignedAt: null,
    });
    state.leases = [];

    const res = await post({
      action: "upsert",
      row: {
        ...unsigned,
        generatedHtml:
          '<html><body><p onclick="alert(1)">Edited wording</p><script>alert(2)</script><img src="https://evil.test/x" onerror="alert(3)"><a href="javascript:alert(4)">bad</a></body></html>',
      },
    });

    expect(res.status).toBe(200);
    const stored = String(storedRowData().generatedHtml);
    expect(stored).toContain("Edited wording");
    expect(stored).not.toMatch(/script|onclick|onerror|javascript:|evil\.test|<img|<a\b/i);
  });

  it("accepts send-to-resident materialization that replaces generated HTML with the first uploaded PDF", async () => {
    const managerReview = executedRow({
      bucket: "manager",
      status: "Manager Review",
      residentSignature: null,
      managerSignature: null,
      fullySignedAt: null,
      generatedHtml: "<html><body>MANAGER TEMPLATE PREVIEW</body></html>",
      managerUploadedPdf: null,
      versionNumber: 1,
      pdfVersion: 1,
    });
    seedExecuted(managerReview);
    const pdf = {
      dataUrl: "data:application/pdf;base64,QUJD",
      originalDataUrl: "data:application/pdf;base64,QUJD",
      fileName: "lease.pdf",
      uploadedAt: "2026-08-01T00:00:00.000Z",
    };

    const res = await post({
      action: "upsert",
      row: {
        ...managerReview,
        generatedHtml: null,
        managerUploadedPdf: pdf,
        bucket: "resident",
        status: "Resident Signature Pending",
        sentToResidentAt: "2026-08-02T00:00:00.000Z",
        currentActorRole: "resident",
      },
    });

    expect(res.status).toBe(200);
    expect(storedRowData().generatedHtml).toBeNull();
    expect((storedRowData().managerUploadedPdf as Row).dataUrl).toBe(pdf.dataUrl);
    expect(storedRowData().status).toBe("Resident Signature Pending");
  });

  it("accepts send-to-resident materialization when the template URL rides only on the incoming row", async () => {
    const managerReview = executedRow({
      bucket: "manager",
      status: "Manager Review",
      residentSignature: null,
      managerSignature: null,
      fullySignedAt: null,
      generatedHtml: "<html><body>MANAGER TEMPLATE PREVIEW</body></html>",
      managerUploadedPdf: null,
    });
    seedExecuted(managerReview);
    const pdf = {
      dataUrl: "data:application/pdf;base64,QUJD",
      originalDataUrl: "data:application/pdf;base64,QUJD",
      fileName: "lease.pdf",
      uploadedAt: "2026-08-01T00:00:00.000Z",
    };

    const res = await post({
      action: "upsert",
      row: {
        ...managerReview,
        generatedHtml: null,
        managerUploadedPdf: pdf,
        templateDocumentUrl: "/api/portal/lease-template?path=manager%2Flease.pdf",
        bucket: "resident",
        status: "Resident Signature Pending",
        sentToResidentAt: "2026-08-02T00:00:00.000Z",
        currentActorRole: "resident",
      },
    });

    expect(res.status).toBe(200);
    expect(storedRowData().generatedHtml).toBeNull();
    expect(storedRowData().templateDocumentUrl).toContain("lease-template");
  });
});
