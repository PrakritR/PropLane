/**
 * The AUTHORITATIVE half of the signed-document guarantee.
 *
 * `preserveSignedLeaseDocuments` runs in the browser against a store the
 * browser owns, so it is advisory: anyone with devtools can POST straight at
 * the route. This suite drives the real route handler and fails if that server
 * check is removed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unreadUploadedLeaseParse } from "@/lib/uploaded-lease-extraction";
import { uploadedLeaseSourceIssueKey } from "@/lib/uploaded-lease-extraction";
import { parseUploadedLeasePdfBytes } from "@/lib/uploaded-lease-parse.server";
import { leaseRecordFingerprint } from "@/lib/lease-document-mismatch";

const pdfSafetyState = vi.hoisted(() => ({ reject: false, calls: 0 }));

type Row = Record<string, unknown>;

const state: {
  user: { id: string; email: string } | null;
  profile: { email: string; role: string };
  leases: Row[];
  applications: Row[];
  sourceBytes: Uint8Array;
  sourceIssues: Array<{ pageNumber: number | null; code: string; message: string }>;
  allowLeaseEdit: boolean;
  bumpUpdatedAtBeforeWrite: boolean;
} = {
  user: { id: "11111111-2222-4333-8444-555555555555", email: "manager@axis.test" },
  profile: { email: "manager@axis.test", role: "manager" },
  leases: [],
  applications: [],
  sourceBytes: new Uint8Array(),
  sourceIssues: [],
  allowLeaseEdit: true,
  bumpUpdatedAtBeforeWrite: false,
};
let RPC_RESULT: "persisted" | "stale" = "persisted";

/** Minimal PostgREST stand-in: enough for select/eq/limit/maybeSingle/upsert. */
function makeQuery(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let updatePayload: Row | null = null;
  const rows = () => table === "portal_lease_pipeline_records"
    ? state.leases
    : table === "manager_application_records"
      ? state.applications
      : [];
  const matches = () => rows().filter((r) => filters.every((f) => f(r)));
  const q = {
    select: () => {
      if (!updatePayload) return q;
      if (state.bumpUpdatedAtBeforeWrite) {
        state.leases[0]!.updated_at = "2026-09-24T01:00:00.000Z";
        state.bumpUpdatedAtBeforeWrite = false;
      }
      const matched = matches();
      for (const row of matched) Object.assign(row, updatePayload);
      updatePayload = null;
      return Promise.resolve({ data: matched.map((row) => ({ id: row.id })), error: null });
    },
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
    update: (payload: Row) => {
      updatePayload = payload;
      return q;
    },
    delete: () => q,
  };
  return q;
}

const db = {
  storage: {
    from: () => ({ download: async () => ({ data: new Blob([state.sourceBytes]), error: null }) }),
  },
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
vi.mock("@/lib/pdf-import/pdf-source.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf-import/pdf-source.server")>();
  return {
    ...actual,
    assertSafePdfForImport: async () => {
      pdfSafetyState.calls += 1;
      if (pdfSafetyState.reject) throw new Error("active PDF content");
    },
    parsePdfForImport: async (args: { bytes: Uint8Array; fileName: string }) => {
      if (Buffer.from(args.bytes.subarray(0, 5)).toString("ascii") === "%PDF-") {
        return actual.parsePdfForImport(args);
      }
      return {
        sourceSha256: createHash("sha256").update(args.bytes).digest("hex"),
        fileName: args.fileName,
        pages: [],
        issues: state.sourceIssues,
        coverage: { extractedCharacters: 0, representedCharacters: 0, complete: true },
      };
    },
  };
});
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  fetchLeasesForManagerUser: async () => [],
  managerCanAccessLeaseRecord: async () => state.allowLeaseEdit,
  managerMayFileLeaseUnderProperty: async () => ({ ok: true, allowed: true }),
}));
vi.mock("@/lib/documents/document-auto-file-hooks.server", () => ({
  autoFileLeaseDocument: async () => undefined,
}));
vi.mock("@/lib/domain-action-events.server", () => ({ buildDurableLeaseTransitionEnvelope: vi.fn(() => null), leaseEventForTransition: vi.fn(() => null) }));
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
    pdfSafetyState.reject = false;
    pdfSafetyState.calls = 0;
    RPC_RESULT = "persisted";
    state.user = { id: "11111111-2222-4333-8444-555555555555", email: "manager@axis.test" };
    state.profile = { email: "manager@axis.test", role: "manager" };
    state.sourceBytes = new TextEncoder().encode("source lease PDF bytes");
    state.sourceIssues = [{ pageNumber: 1, code: "ocr_requires_review", message: "Review OCR text." }];
    state.allowLeaseEdit = true;
    state.bumpUpdatedAtBeforeWrite = false;
    state.applications = [];
    seedExecuted();
  });

  it("refuses a forged execution claim on a brand-new lease", async () => {
    state.leases = [];
    const response = await post({ action: "upsert", row: executedRow() });
    expect(response.status).toBe(409);
    expect(state.leases).toHaveLength(0);
  });

  it("refuses a new row that claims off-platform execution with only a flag", async () => {
    state.leases = [];
    const response = await post({ action: "upsert", row: {
      id: "lease_flag_only",
      residentEmail: "jordan.lee@example.com",
      status: "Manager Review",
      externallySignedLease: true,
    } });
    expect(response.status).toBe(409);
    expect(state.leases).toHaveLength(0);
  });

  it("refuses a generic unsigned-row transition that sets the external execution flag", async () => {
    const unsigned = executedRow({
      status: "Manager Review", bucket: "manager", residentSignature: null,
      managerSignature: null, signatureName: null, signedAtIso: null, fullySignedAt: null,
      externallySignedLease: false,
    });
    seedExecuted(unsigned);
    const response = await post({ action: "upsert", row: { ...unsigned, externallySignedLease: true } });
    expect(response.status).toBe(409);
    expect(storedRowData().externallySignedLease).toBe(false);
  });

  it("refuses Fully Signed status without execution evidence", async () => {
    state.leases = [];
    const response = await post({ action: "upsert", row: {
      id: "lease_unsigned_claim",
      residentEmail: "jordan.lee@example.com",
      status: "Fully Signed",
      bucket: "signed",
    } });
    expect(response.status).toBe(409);
    expect(state.leases).toHaveLength(0);
  });

  it.each([
    { residentEmail: "other@example.com" },
    { residentUserId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    { propertyId: "property_other" },
  ])("keeps an executed lease in its signed resident and property scope: %j", async (change) => {
    const response = await post({ action: "upsert", row: executedRow(change) });
    expect(response.status).toBe(409);
    expect(state.leases[0]?.resident_email).toBe("jordan.lee@example.com");
    expect(state.leases[0]?.property_id).toBeNull();
  });

  it("keeps scope fixed when a returned PDF receives its first manager countersignature", async () => {
    const awaiting = executedRow({
      bucket: "signed",
      status: "Manager Signature Pending",
      residentSignature: null,
      managerSignature: null,
      signatureName: null,
      signedAtIso: null,
      fullySignedAt: null,
      residentReturnedSignedPdfAt: "2026-07-01T00:00:00.000Z",
    });
    seedExecuted(awaiting);
    const response = await post({ action: "upsert", row: {
      ...awaiting,
      status: "Fully Signed",
      residentUserId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      managerSignature: { role: "manager", name: "Pat Manager", signedAtIso: "2026-07-01T01:00:00.000Z" },
      fullySignedAt: "2026-07-01T01:00:00.000Z",
    } });
    expect(response.status).toBe(409);
    expect(state.leases[0]?.resident_user_id).toBeUndefined();
  });

  it("allows a new off-platform execution only for the manager-filed PDF", async () => {
    state.leases = [];
    const dataUrl = `data:application/pdf;base64,${Buffer.from(readFileSync(join(process.cwd(), "tests/fixtures/portfolio-import/fillable-application.pdf"))).toString("base64")}`;
    const applicationId = "application_filed_1";
    state.applications = [{
      id: applicationId,
      manager_user_id: state.user!.id,
      resident_email: "jordan.lee@example.com",
      property_id: "property_filed_1",
      row_data: { bucket: "approved", manuallyAdded: true, manualResidentDetails: { signedLeaseDataUrl: dataUrl } },
    }];
    const row = executedRow({
      id: `lease_app_${applicationId}`,
      axisId: applicationId,
      generatedHtml: null,
      externallySignedLease: true,
      managerUploadedPdf: { dataUrl, originalDataUrl: dataUrl, fileName: "signed.pdf" },
    });
    const accepted = await post({ action: "upsert", row });
    expect(accepted.status).toBe(200);
    expect(state.leases).toHaveLength(1);
    expect(state.leases[0]?.resident_email).toBe("jordan.lee@example.com");
    expect(state.leases[0]?.property_id).toBe("property_filed_1");

    state.leases = [];
    const wrongResident = await post({ action: "upsert", row: { ...row, residentEmail: "other@example.com" } });
    expect(wrongResident.status).toBe(409);
    expect(state.leases).toHaveLength(0);

    const forgedResidentId = await post({ action: "upsert", row: { ...row, residentUserId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } });
    expect(forgedResidentId.status).toBe(200);
    expect(state.leases[0]?.resident_user_id).toBeNull();
    expect(storedRowData().residentUserId).toBeNull();

    state.leases = [];
    const withHtml = await post({ action: "upsert", row: { ...row, generatedHtml: "<p>Arbitrary extra terms</p>" } });
    expect(withHtml.status).toBe(409);
    expect(state.leases).toHaveLength(0);
  });

  it("rejects newly submitted original PDF bytes before they can be stored", async () => {
    const prior = "data:application/pdf;base64,QUJD";
    seedExecuted(executedRow({ generatedHtml: null, managerUploadedPdf: { dataUrl: prior, originalDataUrl: prior, fileName: "lease.pdf", uploadedAt: "x" } }));
    pdfSafetyState.reject = true;
    const response = await post({
      action: "upsert",
      row: executedRow({
        generatedHtml: null,
        managerUploadedPdf: { dataUrl: prior, originalDataUrl: "data:application/pdf;base64,REVG", fileName: "lease.pdf", uploadedAt: "x" },
      }),
    });
    expect(response.status).toBe(400);
    expect(pdfSafetyState.calls).toBe(1);
    expect((storedRowData().managerUploadedPdf as Row).originalDataUrl).toBe(prior);

    pdfSafetyState.calls = 0;
    const changedArtifact = await post({
      action: "upsert",
      row: executedRow({
        generatedHtml: null,
        managerUploadedPdf: { dataUrl: "data:application/pdf;base64,REVG", originalDataUrl: prior, fileName: "lease.pdf", uploadedAt: "x" },
      }),
    });
    expect(changedArtifact.status).toBe(400);
    expect(pdfSafetyState.calls).toBe(1);
  });

  it("returns 409 and preserves the newer stored lease when updated_at CAS is stale", async () => {
    const before = structuredClone(state.leases[0]);
    RPC_RESULT = "stale";
    const response = await post({ action: "upsert", row: storedRowData() });
    expect(response.status).toBe(409);
    expect(state.leases[0]).toEqual(before);
  });

  it("refuses to replace the document body of a signed lease", async () => {
    const res = await post({
      action: "upsert",
      row: executedRow({ generatedHtml: "<html><body>FORGED LEASE TEXT</body></html>" }),
    });

    expect(res.status).toBe(409);
    expect(storedRowData().generatedHtml).toBe(EXECUTED_HTML);
  });

  it("refuses replace that strips execution and document from a fully signed lease (PRP-385)", async () => {
    const res = await post({
      action: "replace",
      rows: [
        {
          id: "lease_route_1",
          axisId: "app-1",
          residentName: "Jordan Lee",
          residentEmail: "jordan.lee@example.com",
          unit: "Unit 1",
          stageLabel: "Draft",
          updated: "just now",
          bucket: "manager",
          pdfVersion: 1,
          notes: "Created from approved application.",
          updatedAtIso: "2026-09-07T00:00:00.000Z",
          thread: [],
          generatedHtml: null,
          managerUploadedPdf: null,
          managerSignature: null,
          residentSignature: null,
          signatureName: null,
          signedAtIso: null,
          fullySignedAt: null,
          status: "Draft",
        },
      ],
    });

    expect(res.status).toBe(409);
    expect(storedRowData().fullySignedAt).toBeTruthy();
    expect(storedRowData().generatedHtml).toBe(EXECUTED_HTML);
  });

  it("refuses upsert that clears execution without a superseding document", async () => {
    const res = await post({
      action: "upsert",
      row: {
        ...executedRow(),
        generatedHtml: null,
        managerUploadedPdf: null,
        residentSignature: null,
        managerSignature: null,
        fullySignedAt: null,
        status: "Draft",
        bucket: "manager",
        stageLabel: "Draft",
      },
    });

    expect(res.status).toBe(409);
    expect(storedRowData().fullySignedAt).toBeTruthy();
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
        pendingRenewal: {
          leaseTerm: "12 months",
          leaseStart: "2026-10-01",
          leaseEnd: "2027-09-30",
          monthlyRent: 1200,
          requestedAtIso: "2026-09-07T00:00:00.000Z",
        },
        signedLeaseSnapshots: [
          {
            id: "snap_prior",
            label: "prior term",
            fullySignedAt: "2026-09-01T00:00:00.000Z",
            archivedAtIso: "2026-09-01T00:00:00.000Z",
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(storedRowData().generatedHtml).toContain("RENEWAL");
  });

  it("refuses a Draft stub that clears an executed lease (PRP-385)", async () => {
    const res = await post({
      action: "upsert",
      row: executedRow({
        generatedHtml: null,
        managerUploadedPdf: null,
        residentSignature: null,
        managerSignature: null,
        signatureName: null,
        signedAtIso: null,
        fullySignedAt: null,
        status: "Draft",
        bucket: "manager",
        notes: "Created from approved application.",
      }),
    });

    expect(res.status).toBe(409);
    expect(storedRowData().generatedHtml).toBe(EXECUTED_HTML);
    expect(storedRowData().fullySignedAt).toBeTruthy();
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

  const importedTemplateRow = (receipt: Row | null = null): Row => {
    const sourceSha256 = createHash("sha256").update(state.sourceBytes).digest("hex");
    return {
      id: "lease_route_1",
      residentName: "Jordan Lee",
      residentEmail: "jordan.lee@example.com",
      managerUserId: state.user!.id,
      bucket: "manager",
      status: "Manager Review",
      generatedHtml: "<html><body><h1>Source lease</h1><p>PropLane Terms Rider</p></body></html>",
      documentMode: "imported-converted",
      templateDocumentUrl: `/api/portal/lease-template?path=${encodeURIComponent(`${state.user!.id}/lease.pdf`)}`,
      templateVersion: "lease-tpl-1@v1",
      templateImportReview: {
        sourceSha256,
        convertedHtmlSha256: "a".repeat(64),
        reviewedAtIso: "2026-09-24T00:00:00.000Z",
        issueCodes: ["ocr_requires_review"],
        resolvedIssueCodes: [],
        extractedCharacters: 0,
        representedCharacters: 0,
        templateVersion: "lease-tpl-1@v1",
      },
      templatePlacementReview: receipt,
      residentSignature: null,
      managerSignature: null,
      ...{},
    };
  };

  const expectedTemplateReview = () => {
    const row = storedRowData();
    return {
      revision: state.leases[0]!.updated_at,
      sourceSha256: createHash("sha256").update(state.sourceBytes).digest("hex"),
      finalHtmlSha256: createHash("sha256").update(row.generatedHtml as string).digest("hex"),
      recordFingerprint: leaseRecordFingerprint({ residentName: String(row.residentName), leaseStart: null, leaseEnd: null, rentLabel: null }),
    };
  };

  it("stores a server-issued placement receipt only after authorized source verification", async () => {
    seedExecuted(importedTemplateRow());
    state.leases[0]!.status = "manager_review";
    state.leases[0]!.updated_at = "2026-09-24T00:00:00.000Z";
    const response = await post({
      action: "confirm_template_placement_review",
      leaseId: "lease_route_1",
      acknowledgeTermsRiderConflicts: true,
      expectedReview: expectedTemplateReview(),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const receipt = storedRowData().templatePlacementReview as Row;
    expect(receipt.confirmedByUserId).toBe(state.user!.id);
    expect(receipt.sourceSha256).toBe(createHash("sha256").update(state.sourceBytes).digest("hex"));
    expect(receipt.finalHtmlSha256).toBe(createHash("sha256").update((storedRowData().generatedHtml as string)).digest("hex"));
    expect(receipt.riderConflictAcknowledged).toBe(true);
  });

  it("rejects forged template issue metadata when the stored PDF has an unreadable page", async () => {
    state.sourceIssues = [{ pageNumber: 1, code: "unreadable_page", message: "Page 1 could not be read." }];
    seedExecuted(importedTemplateRow());
    state.leases[0]!.status = "manager_review";
    state.leases[0]!.updated_at = "2026-09-24T00:00:00.000Z";
    const response = await post({ action: "confirm_template_placement_review", leaseId: "lease_route_1", acknowledgeTermsRiderConflicts: true, expectedReview: expectedTemplateReview() });
    expect(response.status).toBe(409);
    expect(storedRowData().templatePlacementReview).toBeNull();
  });

  it("rejects a placement confirmation when the viewed revision, body, or record facts are stale", async () => {
    seedExecuted(importedTemplateRow());
    state.leases[0]!.status = "manager_review";
    state.leases[0]!.updated_at = "2026-09-24T00:00:00.000Z";
    const viewed = expectedTemplateReview();
    state.leases[0]!.updated_at = "2026-09-24T00:01:00.000Z";
    expect((await post({ action: "confirm_template_placement_review", leaseId: "lease_route_1", acknowledgeTermsRiderConflicts: true, expectedReview: viewed })).status).toBe(409);
    expect(storedRowData().templatePlacementReview).toBeNull();
    const current = expectedTemplateReview();
    storedRowData().residentName = "Changed Resident";
    expect((await post({ action: "confirm_template_placement_review", leaseId: "lease_route_1", acknowledgeTermsRiderConflicts: true, expectedReview: current })).status).toBe(409);
    expect(storedRowData().templatePlacementReview).toBeNull();
  });

  it("refuses another manager and a mismatched source digest", async () => {
    seedExecuted(importedTemplateRow());
    state.leases[0]!.status = "manager_review";
    state.allowLeaseEdit = false;
    const unauthorized = await post({ action: "confirm_template_placement_review", leaseId: "lease_route_1", acknowledgeTermsRiderConflicts: true });
    expect(unauthorized.status).toBe(404);

    state.allowLeaseEdit = true;
    const row = storedRowData();
    row.templateImportReview = { ...(row.templateImportReview as Row), sourceSha256: "b".repeat(64) };
    const mismatch = await post({ action: "upsert", row });
    expect(mismatch.status).toBe(200);
    const confirmation = await post({ action: "confirm_template_placement_review", leaseId: "lease_route_1", acknowledgeTermsRiderConflicts: true });
    expect(confirmation.status).toBe(409);
    expect(storedRowData().templatePlacementReview).toBeNull();
  });

  it("uses compare-and-set so a concurrent edit cannot receive a stale placement receipt", async () => {
    seedExecuted(importedTemplateRow());
    state.leases[0]!.status = "manager_review";
    state.leases[0]!.updated_at = "2026-09-24T00:00:00.000Z";
    state.bumpUpdatedAtBeforeWrite = true;
    const response = await post({ action: "confirm_template_placement_review", leaseId: "lease_route_1", acknowledgeTermsRiderConflicts: true });
    expect(response.status).toBe(409);
    expect(storedRowData().templatePlacementReview).toBeNull();
  });

  it("blocks imported-template sends when the stored receipt is absent or the client omits trusted metadata", async () => {
    seedExecuted(importedTemplateRow());
    state.leases[0]!.status = "manager_review";
    const row = { ...storedRowData(), status: "Resident Signature Pending", bucket: "resident", sentToResidentAt: null };
    const noReceipt = await post({ action: "upsert", row });
    expect(noReceipt.status).toBe(409);

    const forgedOmission = { ...row, documentMode: "proplane-generated", templateImportReview: null, templatePlacementReview: null, templateDocumentUrl: null };
    const bypass = await post({ action: "upsert", row: forgedOmission });
    expect(bypass.status).toBe(409);
  });

  it("confirms and sends a reusable converted lease template without an uploaded-lease receipt", async () => {
    seedExecuted(importedTemplateRow());
    state.leases[0]!.status = "manager_review";
    state.leases[0]!.updated_at = "2026-09-24T00:00:00.000Z";

    const confirmation = await post({
      action: "confirm_template_placement_review",
      leaseId: "lease_route_1",
      acknowledgeTermsRiderConflicts: true,
      expectedReview: expectedTemplateReview(),
    });
    expect(confirmation.status).toBe(200);

    const reviewed = structuredClone(storedRowData());
    const send = await post({
      action: "upsert",
      row: { ...reviewed, status: "Resident Signature Pending", bucket: "resident", sentToResidentAt: "2026-09-24T01:00:00.000Z" },
    });
    expect(send.status).toBe(200);
    expect(storedRowData().templatePlacementReview).toEqual(reviewed.templatePlacementReview);
    expect(storedRowData().templateImportReview).toEqual(reviewed.templateImportReview);
    expect(storedRowData().managerUploadedPdf).toBeFalsy();
  });

  it("rejects a reusable-template send after its private source changes after confirmation", async () => {
    seedExecuted(importedTemplateRow());
    state.leases[0]!.status = "manager_review";
    state.leases[0]!.updated_at = "2026-09-24T00:00:00.000Z";
    const confirmation = await post({
      action: "confirm_template_placement_review",
      leaseId: "lease_route_1",
      acknowledgeTermsRiderConflicts: true,
      expectedReview: expectedTemplateReview(),
    });
    expect(confirmation.status).toBe(200);

    state.sourceBytes = new TextEncoder().encode("changed source template bytes");
    const send = await post({
      action: "upsert",
      row: { ...storedRowData(), status: "Resident Signature Pending", bucket: "resident" },
    });
    expect(send.status).toBe(409);
    expect(storedRowData().status).toBe("Manager Review");
  });

  it("does not let a reusable-template send smuggle in unreviewed uploaded lease bytes", async () => {
    seedExecuted(importedTemplateRow({
      sourceSha256: createHash("sha256").update(state.sourceBytes).digest("hex"),
      sourcePath: `${state.user!.id}/lease.pdf`,
      finalHtmlSha256: createHash("sha256").update("<html><body><h1>Source lease</h1><p>PropLane Terms Rider</p></body></html>").digest("hex"),
      templateVersion: "lease-tpl-1@v1",
      reviewedAtIso: "2026-09-24T00:00:00.000Z",
      confirmedByUserId: state.user!.id,
      riderConflictAcknowledged: true,
    }));
    state.leases[0]!.status = "manager_review";
    const dataUrl = "data:application/pdf;base64,QUJD";
    const send = await post({
      action: "upsert",
      row: {
        ...storedRowData(),
        managerUploadedPdf: { dataUrl, originalDataUrl: dataUrl, fileName: "replacement.pdf" },
        status: "Resident Signature Pending",
        bucket: "resident",
      },
    });
    expect(send.status).toBe(409);
    expect(storedRowData().managerUploadedPdf).toBeFalsy();
    expect(storedRowData().status).toBe("Manager Review");
  });

  it("rejects a send when final lease HTML is tampered after placement review", async () => {
    seedExecuted(importedTemplateRow());
    state.leases[0]!.status = "manager_review";
    state.leases[0]!.updated_at = "2026-09-24T00:00:00.000Z";
    const confirmation = await post({
      action: "confirm_template_placement_review",
      leaseId: "lease_route_1",
      acknowledgeTermsRiderConflicts: true,
      expectedReview: expectedTemplateReview(),
    });
    expect(confirmation.status).toBe(200);

    const send = await post({
      action: "upsert",
      row: {
        ...storedRowData(),
        generatedHtml: String(storedRowData().generatedHtml).replace("Source lease", "Changed lease"),
        status: "Resident Signature Pending",
        bucket: "resident",
      },
    });
    expect(send.status).toBe(409);
    expect(storedRowData().generatedHtml).toContain("Source lease");
    expect(storedRowData().templatePlacementReview).toBeTruthy();
    expect(storedRowData().status).toBe("Manager Review");
  });

  it("keeps a signed reusable-template placement body immutable", async () => {
    const signed = importedTemplateRow({
      sourceSha256: createHash("sha256").update(state.sourceBytes).digest("hex"),
      sourcePath: `${state.user!.id}/lease.pdf`,
      finalHtmlSha256: createHash("sha256").update("<html><body><h1>Source lease</h1><p>PropLane Terms Rider</p></body></html>").digest("hex"),
      templateVersion: "lease-tpl-1@v1",
      reviewedAtIso: "2026-09-24T00:00:00.000Z",
      confirmedByUserId: state.user!.id,
      riderConflictAcknowledged: true,
    });
    signed.status = "Fully Signed";
    signed.bucket = "signed";
    signed.residentSignature = { role: "resident", name: "Jordan Lee", signedAtIso: "2026-09-24T01:00:00.000Z" };
    signed.managerSignature = { role: "manager", name: "Pat Manager", signedAtIso: "2026-09-24T02:00:00.000Z" };
    signed.fullySignedAt = "2026-09-24T02:00:00.000Z";
    seedExecuted(signed);

    const response = await post({
      action: "upsert",
      row: { ...storedRowData(), generatedHtml: "<html><body>changed after signing</body></html>" },
    });
    expect(response.status).toBe(409);
    expect(storedRowData().generatedHtml).toBe(signed.generatedHtml);
  });

  it("strips client-created placement receipts on insert and refuses imported provenance downgrades", async () => {
    const forgedReceipt = {
      sourceSha256: createHash("sha256").update(state.sourceBytes).digest("hex"),
      sourcePath: `${state.user!.id}/lease.pdf`,
      finalHtmlSha256: createHash("sha256").update("<html><body>forged</body></html>").digest("hex"),
      templateVersion: "lease-tpl-1@v1",
      reviewedAtIso: "2026-09-24T00:00:00.000Z",
      confirmedByUserId: state.user!.id,
      riderConflictAcknowledged: true,
    };
    const created = await post({ action: "upsert", row: { ...importedTemplateRow(forgedReceipt), id: "new_imported_lease" } });
    expect(created.status).toBe(200);
    expect(state.leases.find((lease) => lease.id === "new_imported_lease")?.row_data.templatePlacementReview).toBeNull();

    seedExecuted(importedTemplateRow());
    state.leases[0]!.status = "manager_review";
    const before = structuredClone(storedRowData());
    const downgrade = await post({
      action: "upsert",
      row: {
        ...before,
        generatedHtml: `${before.generatedHtml}<p>edited</p>`,
        documentMode: "proplane-generated",
        templateImportReview: null,
        templateDocumentUrl: null,
      },
    });
    expect(downgrade.status).toBe(409);
    expect(storedRowData()).toEqual(before);
  });

  it("strips a forged uploaded-lease confirmation from a newly created row", async () => {
    const source = `data:application/pdf;base64,${Buffer.from(state.sourceBytes).toString("base64")}`;
    const sourceSha256 = createHash("sha256").update(state.sourceBytes).digest("hex");
    const forged = executedRow({
      id: "new_uploaded_lease",
      bucket: "manager",
      status: "Manager Review",
      residentSignature: null,
      managerSignature: null,
      fullySignedAt: null,
      documentMode: "original-pdf",
      managerUploadedPdf: { dataUrl: source, originalDataUrl: source, fileName: "lease.pdf" },
      uploadedLeaseParse: {
        ...unreadUploadedLeaseParse("lease.pdf"),
        sourceSha256,
        review: {
          status: "confirmed",
          confirmedByUserId: state.user!.id,
          confirmedAtIso: "2026-09-24T00:00:00.000Z",
          confirmedDocumentSha256: sourceSha256,
          confirmedConvertedHtmlSha256: null,
          resolvedSourceIssueCodes: [],
          confirmedRecordFingerprint: leaseRecordFingerprint({ residentName: "Jordan Lee", leaseStart: null, leaseEnd: null, rentLabel: null }),
        },
      },
      uploadedLeaseReviewReceipt: {
        sourceSha256,
        documentSha256: sourceSha256,
        convertedHtmlSha256: null,
        resolvedSourceIssueCodes: [],
        reviewedAtIso: "2026-09-24T00:00:00.000Z",
        confirmedByUserId: state.user!.id,
      },
    });
    expect((await post({ action: "upsert", row: forged })).status).toBe(200);
    const created = state.leases.find((lease) => lease.id === "new_uploaded_lease")?.row_data as Row;
    expect(created.uploadedLeaseReviewReceipt).toBeNull();
    expect((created.uploadedLeaseParse as Row).review).toMatchObject({ status: "needs_review", confirmedByUserId: null });
    expect((await post({ action: "upsert", row: { ...created, status: "Resident Signature Pending", bucket: "resident" } })).status).toBe(409);
  });

  it("rejects an imported-template send with a malformed reviewer identity", async () => {
    const row = importedTemplateRow({
      sourceSha256: createHash("sha256").update(state.sourceBytes).digest("hex"),
      sourcePath: `${state.user!.id}/lease.pdf`,
      finalHtmlSha256: createHash("sha256").update("<html><body><h1>Source lease</h1><p>PropLane Terms Rider</p></body></html>").digest("hex"),
      templateVersion: "lease-tpl-1@v1",
      reviewedAtIso: "2026-09-24T00:00:00.000Z",
      confirmedByUserId: "not-a-user-id",
      riderConflictAcknowledged: true,
    });
    seedExecuted(row);
    state.leases[0]!.status = "manager_review";
    const send = await post({
      action: "upsert",
      row: { ...storedRowData(), status: "Resident Signature Pending", bucket: "resident", sentToResidentAt: null },
    });
    expect(send.status).toBe(409);
  });

  it("restores an omitted uploaded parse and keeps imported-converted uploads behind its send gate", async () => {
    const source = "data:application/pdf;base64,QUJD";
    const parse = {
      version: 1,
      status: "failed",
      sourceFileName: "lease.pdf",
      sourceSha256: createHash("sha256").update(Buffer.from("QUJD", "base64")).digest("hex"),
      pageCount: 0,
      characterCount: 0,
      extractedAtIso: null,
      sections: [],
      fields: [],
      review: { status: "needs_review" },
    };
    const stored = executedRow({
      bucket: "manager",
      status: "Manager Review",
      residentSignature: null,
      managerSignature: null,
      fullySignedAt: null,
      generatedHtml: "<html><body>Converted lease</body></html>",
      documentMode: "imported-converted",
      managerUploadedPdf: { dataUrl: source, originalDataUrl: source, fileName: "lease.pdf", uploadedAt: "2026-09-24T00:00:00.000Z" },
      uploadedLeaseParse: parse,
    });
    seedExecuted(stored);
    state.leases[0]!.status = "manager_review";
    const omittedParse = { ...storedRowData(), status: "Resident Signature Pending", bucket: "resident", sentToResidentAt: null };
    delete omittedParse.uploadedLeaseParse;
    const response = await post({ action: "upsert", row: omittedParse });
    expect(response.status).toBe(409);
    expect(storedRowData().uploadedLeaseParse).toMatchObject(parse);
  });

  it("rejects one-write and two-write removal of an unreviewed imported source", async () => {
    const source = "data:application/pdf;base64,QUJD";
    const stored = executedRow({ bucket: "manager", status: "Manager Review", residentSignature: null,
      managerSignature: null, fullySignedAt: null, generatedHtml: "<html><body>Converted</body></html>",
      documentMode: "imported-converted", managerUploadedPdf: { dataUrl: source, originalDataUrl: source, fileName: "lease.pdf" },
      uploadedLeaseParse: { ...unreadUploadedLeaseParse("lease.pdf"), sourceSha256: createHash("sha256").update(Buffer.from("ABC")).digest("hex") },
    });
    seedExecuted(stored);
    state.leases[0]!.status = "manager_review";
    const clear = { ...storedRowData(), managerUploadedPdf: null, uploadedLeaseParse: null, documentMode: "proplane-generated" };
    const first = await post({ action: "upsert", row: clear });
    expect(first.status).toBe(409);
    expect(storedRowData().managerUploadedPdf).toEqual(stored.managerUploadedPdf);
    const omit = { ...storedRowData() };
    delete omit.managerUploadedPdf;
    delete omit.uploadedLeaseParse;
    const second = await post({ action: "upsert", row: omit });
    expect(second.status).toBe(409);
    const send = await post({ action: "upsert", row: { ...storedRowData(), status: "Resident Signature Pending", bucket: "resident" } });
    expect(send.status).toBe(409);
  });

  it("rejects mutation of a signed converted lease's original PDF even when the display PDF is stable", async () => {
    const source = "data:application/pdf;base64,QUJD";
    const changed = "data:application/pdf;base64,REVG";
    const stored = executedRow({ documentMode: "imported-converted", managerUploadedPdf: { dataUrl: source, originalDataUrl: source, fileName: "lease.pdf" },
      uploadedLeaseParse: { ...unreadUploadedLeaseParse("lease.pdf"), sourceSha256: createHash("sha256").update(Buffer.from("ABC")).digest("hex") },
    });
    seedExecuted(stored);
    const response = await post({ action: "upsert", row: { ...stored, managerUploadedPdf: { ...stored.managerUploadedPdf as Row, originalDataUrl: changed } } });
    expect(response.status).toBe(409);
    expect((storedRowData().managerUploadedPdf as Row).originalDataUrl).toBe(source);
  });

  it("issues the uploaded review receipt on the server and accepts only that source-bound decision", async () => {
    const dataUrl = `data:application/pdf;base64,${Buffer.from(state.sourceBytes).toString("base64")}`;
    const uploaded = executedRow({
      bucket: "manager",
      status: "Manager Review",
      residentSignature: null,
      managerSignature: null,
      fullySignedAt: null,
      generatedHtml: "<html><body>Original PDF remains selected</body></html>",
      documentMode: "original-pdf",
      managerUploadedPdf: { dataUrl, originalDataUrl: dataUrl, fileName: "lease.pdf", uploadedAt: "2026-09-24T00:00:00.000Z" },
      uploadedLeaseParse: { ...unreadUploadedLeaseParse("lease.pdf"), sourceSha256: createHash("sha256").update(state.sourceBytes).digest("hex") },
    });
    seedExecuted(uploaded);
    state.leases[0]!.status = "manager_review";
    state.leases[0]!.updated_at = "2026-09-24T00:00:00.000Z";

    const confirmation = await post({
      action: "confirm_uploaded_lease_review",
      leaseId: uploaded.id,
      uploadedReview: { useConverted: false, overrides: { rent: "$1,200" }, note: "Compared with original PDF.",
        expectedRevision: state.leases[0]!.updated_at,
        viewedSourceSha256: createHash("sha256").update(state.sourceBytes).digest("hex"),
        viewedConvertedHtmlSha256: null,
        viewedRecordFingerprint: leaseRecordFingerprint({ residentName: String(uploaded.residentName), leaseStart: null, leaseEnd: null, rentLabel: null }),
      },
    });
    expect(confirmation.status).toBe(200);
    const reviewed = storedRowData();
    expect(reviewed.uploadedLeaseReviewReceipt).toMatchObject({
      sourceSha256: createHash("sha256").update(state.sourceBytes).digest("hex"),
      documentSha256: createHash("sha256").update(state.sourceBytes).digest("hex"),
      confirmedByUserId: state.user!.id,
    });
    expect((reviewed.uploadedLeaseParse as Row).review).toMatchObject({ status: "confirmed", confirmedByUserId: state.user!.id });

    const send = await post({
      action: "upsert",
      row: { ...reviewed, status: "Resident Signature Pending", bucket: "resident", sentToResidentAt: "2026-09-24T01:00:00.000Z" },
    });
    expect(send.status).toBe(200);
  });

  it("never issues an uploaded review receipt for a stale viewed snapshot", async () => {
    const dataUrl = `data:application/pdf;base64,${Buffer.from(state.sourceBytes).toString("base64")}`;
    const sourceSha256 = createHash("sha256").update(state.sourceBytes).digest("hex");
    const row = executedRow({ bucket: "manager", status: "Manager Review", residentSignature: null, managerSignature: null,
      fullySignedAt: null, documentMode: "original-pdf", managerUploadedPdf: { dataUrl, originalDataUrl: dataUrl, fileName: "lease.pdf" },
      uploadedLeaseParse: { ...unreadUploadedLeaseParse("lease.pdf"), sourceSha256 },
    });
    seedExecuted(row);
    state.leases[0]!.status = "manager_review";
    state.leases[0]!.updated_at = "2026-09-24T00:00:00.000Z";
    const viewed = { useConverted: false, expectedRevision: state.leases[0]!.updated_at, viewedSourceSha256: sourceSha256,
      viewedConvertedHtmlSha256: null, viewedRecordFingerprint: leaseRecordFingerprint({ residentName: String(row.residentName), leaseStart: null, leaseEnd: null, rentLabel: null }) };
    state.leases[0]!.updated_at = "2026-09-24T00:01:00.000Z";
    expect((await post({ action: "confirm_uploaded_lease_review", leaseId: row.id, uploadedReview: viewed })).status).toBe(409);
    expect(storedRowData().uploadedLeaseReviewReceipt).toBeUndefined();
    const current = { ...viewed, expectedRevision: state.leases[0]!.updated_at };
    storedRowData().residentName = "Different Resident";
    expect((await post({ action: "confirm_uploaded_lease_review", leaseId: row.id, uploadedReview: current })).status).toBe(409);
    expect(storedRowData().uploadedLeaseReviewReceipt).toBeUndefined();
  });

  it("converts a reviewed fillable PDF while preserving its original bytes", async () => {
    const bytes = new Uint8Array(readFileSync(join(process.cwd(), "tests/fixtures/portfolio-import/fillable-application.pdf")));
    const parse = await parseUploadedLeasePdfBytes({ bytes, fileName: "fillable.pdf" });
    const dataUrl = `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}`;
    const html = "<html><body><h1>Reviewed lease</h1><p>Every source page checked.</p></body></html>";
    expect(parse.sourceIssues?.some((issue) => issue.code === "form_fields_present")).toBe(true);
    const row = executedRow({ bucket: "manager", status: "Manager Review", residentSignature: null, managerSignature: null,
      fullySignedAt: null, documentMode: "original-pdf", managerUploadedPdf: { dataUrl, originalDataUrl: dataUrl, fileName: "fillable.pdf" },
      uploadedLeaseParse: parse,
    });
    seedExecuted(row);
    state.leases[0]!.status = "manager_review";
    state.leases[0]!.updated_at = "2026-09-24T00:00:00.000Z";
    const base = { useConverted: true, convertedHtml: html, expectedRevision: state.leases[0]!.updated_at,
      viewedSourceSha256: parse.sourceSha256, viewedConvertedHtmlSha256: createHash("sha256").update(html).digest("hex"),
      viewedRecordFingerprint: leaseRecordFingerprint({ residentName: String(row.residentName), leaseStart: null, leaseEnd: null, rentLabel: null }) };
    const unresolved = await post({ action: "confirm_uploaded_lease_review", leaseId: row.id, uploadedReview: base });
    expect(unresolved.status).toBe(409);
    const confirmed = await post({ action: "confirm_uploaded_lease_review", leaseId: row.id,
      uploadedReview: { ...base, resolvedSourceIssueCodes: parse.sourceIssues?.map(uploadedLeaseSourceIssueKey) } });
    expect(confirmed.status).toBe(200);
    expect((storedRowData().managerUploadedPdf as Row).originalDataUrl).toBe(dataUrl);
    expect(storedRowData().documentMode).toBe("imported-converted");
    expect((storedRowData().uploadedLeaseReviewReceipt as Row).convertedHtmlSha256).toBe(base.viewedConvertedHtmlSha256);
    const send = await post({ action: "upsert", row: { ...storedRowData(), status: "Resident Signature Pending", bucket: "resident" } });
    expect(send.status).toBe(200);
  });

  it("does not let client supplied confirmed parse fields replace a missing server receipt", async () => {
    const sourceSha256 = createHash("sha256").update(state.sourceBytes).digest("hex");
    const dataUrl = `data:application/pdf;base64,${Buffer.from(state.sourceBytes).toString("base64")}`;
    const uploaded = executedRow({
      bucket: "manager",
      status: "Manager Review",
      residentSignature: null,
      managerSignature: null,
      fullySignedAt: null,
      documentMode: "original-pdf",
      managerUploadedPdf: { dataUrl, originalDataUrl: dataUrl, fileName: "lease.pdf", uploadedAt: "2026-09-24T00:00:00.000Z" },
      uploadedLeaseParse: {
        ...unreadUploadedLeaseParse("lease.pdf"),
        sourceSha256,
        review: {
          status: "confirmed",
          confirmedByUserId: state.user!.id,
          confirmedAtIso: "2026-09-24T00:00:00.000Z",
          confirmedDocumentSha256: sourceSha256,
          confirmedConvertedHtmlSha256: null,
          resolvedSourceIssueCodes: [],
          confirmedRecordFingerprint: "forged",
        },
      },
      uploadedLeaseReviewReceipt: null,
    });
    seedExecuted(uploaded);
    state.leases[0]!.status = "manager_review";
    const response = await post({
      action: "upsert",
      row: { ...storedRowData(), status: "Resident Signature Pending", bucket: "resident", sentToResidentAt: null },
    });
    expect(response.status).toBe(409);
  });
});
