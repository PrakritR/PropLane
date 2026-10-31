import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";
import { createLinkedFormFakeDb, type LinkedFormFakeDb } from "../../helpers/linked-form-fake-db";

/**
 * A co-signer form is bound to a resident account and to ONE linked-form request: the application and the
 * template come from the stored request, never from the body, and a submit that names no request is refused.
 * Every case here therefore goes through that request, as the co-signer's own portal does.
 */
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  db: null as unknown,
}));

vi.mock("@/lib/cosigner-notification.server", () => ({
  notifyManagerCosignerSubmitted: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }), clientIpFrom: () => "127.0.0.1" }));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => state.db }));

import { hashLinkedFormToken } from "@/lib/application-linked-form-requests.server";
import { POST as cosignerSubmit } from "@/app/api/public/cosigner-submissions/route";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  applicationTemplateQuestionConfigFromSlice,
  createPropertyApplicationTemplate,
  publishApplicationTemplateQuestionDraft,
} from "@/lib/property-application-templates";

const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const APP_ID = "PROPLANE-APP00001";

const baseSubmission = {
  signerFullName: "Primary Applicant",
  fullName: "Co Signer",
  email: "cosigner@example.com",
  phone: "2065550100",
  dob: "1990-01-01",
  dlNumber: "DL123",
  ssn: "123-45-6789",
  address: "1 Main St",
  city: "Seattle",
  state: "WA",
  zip: "98101",
  notEmployed: false,
  employerName: "Acme",
  employerAddress: "2 Work St",
  supervisorName: "Boss",
  supervisorPhone: "2065550101",
  jobTitle: "Engineer",
  monthlyIncome: "5000",
  annualIncome: "60000",
  employmentStart: "2020-01-01",
  otherIncome: "",
  bankruptcy: "no",
  criminal: "no",
  consentCredit: true,
  signature: "Co Signer",
  dateSigned: "2026-06-24",
};

/** The default co-signer template: every standard question asked, no custom ones. */
function cosignerTemplate(customApplicationFields: ReturnType<typeof applicationTemplateQuestionConfigFromSlice>["customApplicationFields"] = []) {
  return publishApplicationTemplateQuestionDraft({
    ...createPropertyApplicationTemplate({ kind: "long-term", label: "Co-signer form", listingSeedKey: "cosigner", formVariant: "cosigner" }),
    feeCentsOverride: 0,
    draftQuestionConfig: applicationTemplateQuestionConfigFromSlice({
      applicationConfigMode: customApplicationFields.length ? "custom" : "standard",
      disabledStandardApplicationKeys: [],
      customApplicationFields,
    }),
  });
}

function seed(options: { applicationRow?: Record<string, unknown> | null; template?: ReturnType<typeof cosignerTemplate> } = {}): {
  db: LinkedFormFakeDb;
  templateId: string;
} {
  const template = options.template ?? cosignerTemplate();
  const listingSubmission = { ...createDefaultListingSubmission(), propertyApplicationTemplates: [template] };
  const applicationRow =
    options.applicationRow === undefined
      ? {
          id: APP_ID,
          name: "Primary Applicant",
          email: "primary@example.com",
          bucket: "approved",
          stage: "Approved",
          propertyId: "property-1",
          application: { propertyId: "property-1", hasCosigner: "yes" },
        }
      : options.applicationRow;
  const db = createLinkedFormFakeDb({
    manager_property_records: [
      { id: "property-1", manager_user_id: "manager-1", property_data: { listingSubmission } },
    ],
    manager_application_records: applicationRow
      ? [
          {
            id: APP_ID,
            manager_user_id: "manager-1",
            property_id: "property-1",
            assigned_property_id: null,
            resident_email: "primary@example.com",
            row_data: applicationRow,
          },
        ]
      : [],
    application_form_requests: [
      {
        id: REQUEST_ID,
        manager_user_id: "manager-1",
        application_id: APP_ID,
        applicant_user_id: "applicant-1",
        helper_user_id: "helper-1",
        rule_id: "lfr-derived-cosigner",
        form_kind: "application",
        form_id: template.id,
        source_question_label: "Co-signer planned",
        source_answer_label: "Yes",
        needed_before_review: true,
        token_hash: hashLinkedFormToken("K".repeat(43)),
        status: "shared",
        filled_by_user_id: null,
        fee_cents: 0,
        fee_paid_at: null,
        fee_paid_by_user_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    ],
    profiles: [
      { id: "helper-1", role: "resident", email: "cosigner@example.com", full_name: "Co Signer" },
      { id: "manager-1", role: "manager", email: "m@example.com" },
    ],
    profile_roles: [{ user_id: "helper-1", role: "resident" }, { user_id: "manager-1", role: "manager" }],
    cosigner_submission_records: [],
  });
  return { db, templateId: template.id };
}

const submit = (body: Record<string, unknown>) =>
  cosignerSubmit(jsonRequest("http://localhost/api/public/cosigner-submissions", { method: "POST", body }));

describe("POST /api/public/cosigner-submissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user = { id: "helper-1", email: "cosigner@example.com" };
  });

  it("rejects a submit that names no form request", async () => {
    state.db = seed().db;
    const res = await submit({ ...baseSubmission, signerAppId: APP_ID });
    expect(res.status).toBe(401);
  });

  it("rejects a form request whose application cannot be found", async () => {
    state.db = seed({ applicationRow: null }).db;
    const res = await submit({ ...baseSubmission, formRequestId: REQUEST_ID });
    expect(res.status).toBe(404);
  });

  it("rejects co-signer when primary application is not submitted", async () => {
    state.db = seed({
      applicationRow: {
        id: APP_ID,
        name: "Primary Applicant",
        email: "primary@example.com",
        bucket: "pending",
        stage: "In progress",
        propertyId: "property-1",
        application: { propertyId: "property-1", email: "primary@example.com" },
      },
    }).db;
    const res = await submit({ ...baseSubmission, formRequestId: REQUEST_ID });
    expect(res.status).toBe(403);
    const { data } = await parseJsonResponse<{ error?: string }>(res);
    expect(data.error).toMatch(/not been submitted/i);
  });

  it("accepts valid co-signer submission and closes the form request", async () => {
    const { db } = seed();
    state.db = db;
    const res = await submit({ ...baseSubmission, formRequestId: REQUEST_ID });
    const { status, data } = await parseJsonResponse<{ ok?: boolean }>(res);
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(db.tables.cosigner_submission_records).toHaveLength(1);
    expect(db.tables.cosigner_submission_records![0]).toMatchObject({ signer_app_id: APP_ID, manager_user_id: "manager-1" });
    expect(db.tables.application_form_requests![0]).toMatchObject({ status: "done", filled_by_user_id: "helper-1" });
  });

  it("validates and stores required long text and multi-select answers from a published co-signer template", async () => {
    const template = cosignerTemplate([
      { id: "income-reason", key: "income-reason", label: "Explain your income", type: "long_text", required: true, options: [], section: "additional" },
      { id: "amenities", key: "amenities", label: "Choose amenities", type: "multi_select", required: true, options: ["Laundry", "Parking"], section: "additional" },
    ]);
    const { db } = seed({ template });
    state.db = db;

    const missing = await submit({ ...baseSubmission, formRequestId: REQUEST_ID });
    const missingBody = await parseJsonResponse<{ fields?: Record<string, string> }>(missing);
    expect(missingBody.status).toBe(422);
    expect(missingBody.data.fields).toMatchObject({
      "custom:income-reason": "Explain your income is required.",
      "custom:amenities": "Choose amenities is required.",
    });
    expect(db.tables.cosigner_submission_records).toHaveLength(0);

    const accepted = await submit({
      ...baseSubmission,
      formRequestId: REQUEST_ID,
      customFieldAnswers: [
        { key: "income-reason", value: "I have reliable monthly income." },
        { key: "amenities", value: '["Laundry","Parking"]' },
      ],
    });
    expect(accepted.status).toBe(200);
    expect(db.tables.cosigner_submission_records).toHaveLength(1);
    expect(db.tables.cosigner_submission_records![0]!.row_data).toMatchObject({
      applicationTemplateId: template.id,
      applicationTemplateVersion: 1,
      customFieldAnswers: [
        { key: "income-reason", type: "long_text", value: "I have reliable monthly income." },
        { key: "amenities", type: "multi_select", value: '["Laundry","Parking"]' },
      ],
    });
  });
});
