import { randomBytes } from "node:crypto";
import { sealApplicantRow } from "@/lib/security/applicant-identity";
import { sealCosignerIdentity } from "@/lib/security/cosigner-identity";
import { buildApplicationPdf } from "@/lib/manager-application-pdf";
/**
 * Route-level regression: `GET /api/manager-applications/[id]/pdf` for a
 * MULTI-ROLE account.
 *
 * The bug: the applicant branch only ran when `profiles.role === "resident"`,
 * so a multi-role account (primary role manager/owner who applied as a
 * resident) fell into the manager branch, failed the owned-property predicate
 * for its OWN application on another manager's property, and got a 403 — the
 * resident applications list shows that row by EMAIL match, so the applicant
 * saw "Couldn't load this application document" on their own submission.
 * Applicant identity is the record's `resident_email`, regardless of primary
 * role — the same email-ownership key the list and the withdraw guard use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APPLICANT_EMAIL = "ogambik2@gmail.com";
const APP_ID = "PROPLANE-625089C2";

const getUser = vi.fn();
let PROFILE: { email: string } | null = null;
let RECORDS: Record<string, unknown>[] = [];
let COSIGNERS: Record<string, unknown>[] = [];
const managerCanAccessApplicationRecord = vi.fn(async () => false);

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => false) }));
vi.mock("@/lib/auth/manager-application-access", () => ({
  managerCanAccessApplicationRecord: (...args: unknown[]) => managerCanAccessApplicationRecord(...(args as [])),
}));
vi.mock("@/lib/manager-application-pdf", () => ({
  buildApplicationPdf: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
  applicationPdfFilename: () => "application.pdf",
}));
vi.mock("@/lib/manager-applications-storage", () => ({
  normalizeApplicationAxisId: (id: string) => id,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

/** Chainable Supabase stub — only the surface the PDF route touches. */
function makeDb() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        or: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => Promise.resolve({ data: table === "cosigner_submission_records" ? COSIGNERS : [], error: null }),
        limit() {
          if (table === "manager_application_records") return Promise.resolve({ data: RECORDS, error: null });
          return Promise.resolve({ data: [], error: null });
        },
        maybeSingle() {
          if (table === "profiles") return Promise.resolve({ data: PROFILE, error: null });
          return Promise.resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  };
}

async function fetchPdf(id: string) {
  const { GET } = await import("@/app/api/manager-applications/[id]/pdf/route");
  return GET(new Request(`http://localhost/api/manager-applications/${id}/pdf?disposition=inline`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  COSIGNERS = [];
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "test");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") }));
  vi.clearAllMocks();
  managerCanAccessApplicationRecord.mockResolvedValue(false);
  // The multi-role reality: this login manages property elsewhere (primary role
  // manager/owner), but its EMAIL owns the application it is viewing.
  PROFILE = { email: APPLICANT_EMAIL };
  getUser.mockResolvedValue({
    data: { user: { id: "multi-role-user-1", email: APPLICANT_EMAIL, user_metadata: { role: "owner" } } },
    error: null,
  });
  RECORDS = [
    {
      id: APP_ID,
      row_data: { id: APP_ID, name: "ambika Mago", email: APPLICANT_EMAIL, bucket: "pending" },
      manager_user_id: "some-other-manager",
      resident_email: APPLICANT_EMAIL,
      property_id: "mgr-not-theirs-1",
      assigned_property_id: null,
    },
  ];
});

describe("GET /api/manager-applications/[id]/pdf — multi-role applicant", () => {
  it("authorizes a manager/owner-primary account for its OWN application (email match), even without owning the property", async () => {
    const res = await fetchPdf(APP_ID);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    // The email match alone authorized it — no owned-property grant involved.
    expect(managerCanAccessApplicationRecord).not.toHaveBeenCalled();
  });

  it("still refuses an account whose email does not match and who has no property access", async () => {
    PROFILE = { email: "different-person@example.com" };
    getUser.mockResolvedValue({
      data: { user: { id: "other-user", email: "different-person@example.com", user_metadata: {} } },
      error: null,
    });
    const res = await fetchPdf(APP_ID);
    expect(res.status).toBe(403);
  });

  it("authorizes a non-matching email through the owned-property predicate (manager path)", async () => {
    PROFILE = { email: "the-owner@example.com" };
    getUser.mockResolvedValue({
      data: { user: { id: "owner-user", email: "the-owner@example.com", user_metadata: {} } },
      error: null,
    });
    managerCanAccessApplicationRecord.mockResolvedValue(true);
    const res = await fetchPdf(APP_ID);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });
});

afterEach(() => vi.unstubAllEnvs());

it("opens applicant and co-signer identity for the authorized PDF renderer", async () => {
  RECORDS[0].row_data = sealApplicantRow({ ...(RECORDS[0].row_data as object), application: { dateOfBirth: "1980-01-02", ssn: "123-45-6789", driversLicense: "TEST-ID" } }, APP_ID, "some-other-manager");
  COSIGNERS = [{ id: "cosigner-test", row_data: sealCosignerIdentity({ dob: "1970-03-04", ssn: "987-65-4321", dlNumber: "CO-ID" } as never, "cosigner-test", "some-other-manager") }];
  expect((await fetchPdf(APP_ID)).status).toBe(200);
  expect(buildApplicationPdf).toHaveBeenCalledWith(expect.objectContaining({ application: expect.objectContaining({ dateOfBirth: "1980-01-02", ssn: "123-45-6789" }) }), expect.objectContaining({ cosignerSubmissions: [expect.objectContaining({ dob: "1970-03-04", ssn: "***-**-4321" })] }));
});
