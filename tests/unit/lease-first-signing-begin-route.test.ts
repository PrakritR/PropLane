/**
 * `begin_lease_first_signing` (PLAN-0925, C274-C287) — the resident-triggered
 * transition of an Ida Cares-style lease-first draft
 * (`bucket: "manager", status: "Draft", leaseFirst: true`, no document yet)
 * into `bucket: "resident", status: "Resident Signature Pending"` with a real
 * generated document, so `residentSignLease` has something to hash and sign.
 * Only a resident may call it, only on their own row, and the document is
 * built server-side from the property's PUBLISHED lease template — nothing
 * in the request body becomes document content.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PropertyLeaseTemplate } from "@/lib/property-lease-templates";
import type { ManagerCustomApplicationField } from "@/lib/manager-listing-submission";

const RESIDENT_ID = "resident-jordan";
const RESIDENT_EMAIL = "jordan.reyes@example.com";
const MANAGER_ID = "manager-marc";
const PROPERTY_ID = "prop-maple";
const LEASE_ID = "lease-jordan-draft";

const getUser = vi.fn();
const isAdminUser = vi.fn(async () => false);

let PROFILE: { email: string; role: string | null } | null = null;
let PROFILE_ROLES: string[] = [];
let leaseRow: Record<string, unknown> | null = null;
let propertyRow: Record<string, unknown> | null = null;
let automationRow: Record<string, unknown> | null = null;
let lastUpdatePayload: { table: string; row_data?: Record<string, unknown> } | null = null;
let updateShouldFail = false;

const LICENSE_FIELDS: ManagerCustomApplicationField[] = [
  { id: "f1", key: "la_ack_1", label: "I understand X.", type: "initials", required: true, options: [], section: "Acknowledgements" },
  { id: "f2", key: "la_ack_2", label: "I understand Y.", type: "initials", required: true, options: [], section: "Acknowledgements" },
  { id: "f3", key: "la_fee_monthly", label: "Monthly license fee", type: "currency", required: true, options: [], section: "I. Fees", filledBy: "manager" },
];

function licenseTemplate(): PropertyLeaseTemplate {
  return {
    id: "lease-tpl-license-agreement",
    kind: "custom",
    label: "License agreement",
    leaseConfigMode: "custom",
    leaseCustomKind: "document",
    customLeaseTerms: "",
    leaseTemplateDocUrl: null,
    leaseTemplateDocName: "license.pdf",
    publishedQuestionConfig: {
      disabledStandardApplicationKeys: [],
      customApplicationFields: LICENSE_FIELDS,
      applicationConfigMode: "custom",
      version: 1,
      questionDisplayOrder: LICENSE_FIELDS.map((f) => f.id),
    },
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  } as PropertyLeaseTemplate;
}

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...(a as [])) }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  fetchLeasesForManagerUser: async () => [],
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

function makeDb() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        order: () => builder,
        limit: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: () => {
          if (table === "profiles") return Promise.resolve({ data: PROFILE, error: null });
          if (table === "profile_roles") {
            return Promise.resolve({
              data: PROFILE_ROLES.includes("resident") ? { role: "resident" } : null,
              error: null,
            });
          }
          if (table === "portal_lease_pipeline_records") return Promise.resolve({ data: leaseRow, error: null });
          if (table === "manager_property_records") return Promise.resolve({ data: propertyRow, error: null });
          if (table === "manager_automation_settings") return Promise.resolve({ data: automationRow, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        update: (patch: { row_data?: Record<string, unknown> }) => {
          lastUpdatePayload = { table, row_data: patch.row_data };
          const chain: Record<string, unknown> = {
            eq: () => chain,
            is: () => chain,
            select: () =>
              updateShouldFail
                ? Promise.resolve({ data: [], error: null })
                : Promise.resolve({ data: [{ id: LEASE_ID }], error: null }),
          };
          return chain;
        },
      };
      return builder;
    },
  };
}

async function callBegin(leaseId = LEASE_ID) {
  const { POST } = await import("@/app/api/portal-lease-pipeline/route");
  const res = await POST(
    new Request("http://localhost/api/portal-lease-pipeline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "begin_lease_first_signing", leaseId }),
    }),
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateShouldFail = false;
  lastUpdatePayload = null;
  isAdminUser.mockResolvedValue(false);
  getUser.mockResolvedValue({ data: { user: { id: RESIDENT_ID, email: RESIDENT_EMAIL } }, error: null });
  PROFILE = { email: RESIDENT_EMAIL, role: "resident" };
  PROFILE_ROLES = ["resident"];
  leaseRow = {
    id: LEASE_ID,
    manager_user_id: MANAGER_ID,
    resident_user_id: RESIDENT_ID,
    resident_email: RESIDENT_EMAIL,
    property_id: PROPERTY_ID,
    updated_at: "2026-09-20T00:00:00Z",
    row_data: {
      id: LEASE_ID,
      residentName: "Jordan Reyes",
      residentEmail: RESIDENT_EMAIL,
      unit: "—",
      bucket: "manager",
      status: "Draft",
      leaseFirst: true,
      propertyId: PROPERTY_ID,
      roomChoice: `${PROPERTY_ID}::room-1`,
      managerUserId: MANAGER_ID,
      thread: [],
      pdfVersion: 1,
      updatedAtIso: "2026-09-20T00:00:00Z",
      updated: "2026-09-20T00:00:00Z",
    },
  };
  propertyRow = {
    property_data: {
      buildingName: "Ida Cares — Maple House",
      listingSubmission: {
        v: 1,
        buildingName: "Ida Cares — Maple House",
        rooms: [{ id: "room-1", monthlyRent: 900, dailyRent: 40 }],
        propertyLeaseTemplates: [licenseTemplate()],
      },
    },
  };
  automationRow = {
    row_data: {
      leasingPipeline: { pipelineOrder: "lease_then_application", defaultLeaseTemplateId: "lease-tpl-license-agreement" },
    },
  };
});

describe("begin_lease_first_signing", () => {
  it("refuses a non-resident actor", async () => {
    PROFILE = { email: "marc@example.com", role: "manager" };
    PROFILE_ROLES = ["manager"];
    const { status } = await callBegin();
    expect(status).toBe(404);
    expect(lastUpdatePayload).toBeNull();
  });

  it("refuses a resident who does not own this lease", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "someone-else", email: "someone-else@example.com" } }, error: null });
    PROFILE = { email: "someone-else@example.com", role: "resident" };
    const { status } = await callBegin();
    expect(status).toBe(404);
  });

  it("refuses a row that is not a not-yet-begun lease-first draft", async () => {
    (leaseRow!.row_data as Record<string, unknown>).status = "Resident Signature Pending";
    (leaseRow!.row_data as Record<string, unknown>).bucket = "resident";
    const { status, body } = await callBegin();
    expect(status).toBe(409);
    expect(body.error).toMatch(/not ready/i);
  });

  it("refuses when the workspace has no published lease-first template configured", async () => {
    automationRow = { row_data: { leasingPipeline: { pipelineOrder: "lease_then_application", defaultLeaseTemplateId: null } } };
    const { status, body } = await callBegin();
    expect(status).toBe(409);
    expect(body.error).toMatch(/no published lease-first template/i);
  });

  it("transitions the row, generates the document, and bakes in the manager-filled fee", async () => {
    const { status, body } = await callBegin();
    expect(status).toBe(200);
    const row = body.row as Record<string, unknown>;
    expect(row.bucket).toBe("resident");
    expect(row.status).toBe("Resident Signature Pending");
    expect(row.leaseTemplateId).toBe("lease-tpl-license-agreement");
    expect(typeof row.generatedHtml).toBe("string");
    expect((row.generatedHtml as string).length).toBeGreaterThan(0);
    expect((row.generatedHtml as string)).toContain("PropLane Terms Rider");
    expect((row.generatedHtml as string)).toContain("$900");
    const answers = row.signingAnswers as Record<string, string>;
    expect(answers.la_fee_monthly).toBe("$900");
    expect(answers.la_ack_1).toBeUndefined(); // resident hasn't initialed anything yet
    expect(lastUpdatePayload?.table).toBe("portal_lease_pipeline_records");
  });

  it("does not smuggle client-supplied document content — only `leaseId` is read from the body", async () => {
    const { POST } = await import("@/app/api/portal-lease-pipeline/route");
    const res = await POST(
      new Request("http://localhost/api/portal-lease-pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "begin_lease_first_signing",
          leaseId: LEASE_ID,
          row: { generatedHtml: "<p>forged lease text</p>" },
        }),
      }),
    );
    const data = (await res.json()) as { row?: { generatedHtml?: string } };
    expect(data.row?.generatedHtml).not.toContain("forged lease text");
  });
});
