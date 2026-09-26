import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";

vi.mock("@/lib/cosigner-notification.server", () => ({
  notifyManagerCosignerSubmitted: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { POST as cosignerSubmit } from "@/app/api/public/cosigner-submissions/route";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { createPropertyApplicationTemplate, applicationTemplateQuestionConfigFromSlice, publishApplicationTemplateQuestionDraft } from "@/lib/property-application-templates";

const baseSubmission = {
  signerAppId: "AXIS-TEST1234",
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

describe("POST /api/public/cosigner-submissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects missing application id", async () => {
    const req = jsonRequest("http://localhost/api/public/cosigner-submissions", {
      method: "POST",
      body: { ...baseSubmission, signerAppId: "" },
    });
    const res = await cosignerSubmit(req);
    expect(res.status).toBe(400);
  });

  it("rejects unknown application id", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    } as never);

    const req = jsonRequest("http://localhost/api/public/cosigner-submissions", {
      method: "POST",
      body: baseSubmission,
    });
    const res = await cosignerSubmit(req);
    expect(res.status).toBe(404);
  });

  it("rejects co-signer when primary application is not submitted", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "AXIS-TEST1234",
                manager_user_id: "mgr-1",
                row_data: {
                  bucket: "pending",
                  stage: "In progress",
                  name: "Primary",
                  application: { propertyId: "prop-1", email: "primary@example.com" },
                },
              },
              error: null,
            }),
          }),
        }),
      }),
    } as never);

    const req = jsonRequest("http://localhost/api/public/cosigner-submissions", {
      method: "POST",
      body: baseSubmission,
    });
    const res = await cosignerSubmit(req);
    expect(res.status).toBe(403);
    const { data } = await parseJsonResponse<{ error?: string }>(res);
    expect(data.error).toMatch(/not been submitted/i);
  });

  it("accepts valid co-signer submission", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "manager_application_records") {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { id: "AXIS-TEST1234", manager_user_id: "mgr-1", property_id: "prop-1", row_data: { name: "Primary" } },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "manager_property_records") {
          return {
            select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { property_data: { listingSubmission: { v: 1 } } }, error: null }) }) }) }),
          };
        }
        if (table === "cosigner_submission_records") {
          return { insert };
        }
        return {};
      }),
    } as never);

    const req = jsonRequest("http://localhost/api/public/cosigner-submissions", {
      method: "POST",
      body: baseSubmission,
    });
    const res = await cosignerSubmit(req);
    const { status, data } = await parseJsonResponse<{ ok?: boolean }>(res);
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(insert).toHaveBeenCalled();
  });

  it("validates and stores required long text and multi-select answers from a published co-signer template", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const template = publishApplicationTemplateQuestionDraft({
      ...createPropertyApplicationTemplate({ kind: "long-term", label: "Co-signer form", listingSeedKey: "cosigner", formVariant: "cosigner" }),
      draftQuestionConfig: applicationTemplateQuestionConfigFromSlice({
        disabledStandardApplicationKeys: [],
        applicationConfigMode: "custom",
        customApplicationFields: [
          { id: "income-reason", key: "income-reason", label: "Explain your income", type: "long_text", required: true, options: [], section: "additional" },
          { id: "amenities", key: "amenities", label: "Choose amenities", type: "multi_select", required: true, options: ["Laundry", "Parking"], section: "additional" },
        ],
      }),
    });
    const listingSubmission = { ...createDefaultListingSubmission(), propertyApplicationTemplates: [template] };
    const insertClient = () => ({ from: vi.fn().mockImplementation((table: string) => {
      if (table === "manager_application_records") {
        return { select: () => ({ in: () => ({ maybeSingle: async () => ({ data: { id: "AXIS-TEST1234", manager_user_id: "mgr-1", property_id: "prop-1", row_data: { name: "Primary" } }, error: null }) }) }) };
      }
      if (table === "manager_property_records") {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { property_data: { listingSubmission } }, error: null }) }) }) }) };
      }
      if (table === "cosigner_submission_records") return { insert };
      return {};
    }) });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(insertClient() as never);

    const missing = await cosignerSubmit(jsonRequest("http://localhost/api/public/cosigner-submissions", {
      method: "POST",
      body: { ...baseSubmission, applicationTemplateId: template.id, applicationTemplateVersion: 1 },
    }));
    const missingBody = await parseJsonResponse<{ fields?: Record<string, string> }>(missing);
    expect(missingBody.status).toBe(422);
    expect(missingBody.data.fields).toMatchObject({
      "custom:income-reason": "Explain your income is required.",
      "custom:amenities": "Choose amenities is required.",
    });
    expect(insert).not.toHaveBeenCalled();

    const accepted = await cosignerSubmit(jsonRequest("http://localhost/api/public/cosigner-submissions", {
      method: "POST",
      body: {
        ...baseSubmission,
        applicationTemplateId: template.id,
        applicationTemplateVersion: 1,
        customFieldAnswers: [
          { key: "income-reason", value: "I have reliable monthly income." },
          { key: "amenities", value: '["Laundry","Parking"]' },
        ],
      },
    }));
    expect(accepted.status).toBe(200);
    expect(insert).toHaveBeenCalledOnce();
    expect(insert.mock.calls[0]?.[0].row_data).toMatchObject({
      applicationTemplateId: template.id,
      applicationTemplateVersion: 1,
      customFieldAnswers: [
        { key: "income-reason", type: "long_text", value: "I have reliable monthly income." },
        { key: "amenities", type: "multi_select", value: '["Laundry","Parking"]' },
      ],
    });
  });
});
