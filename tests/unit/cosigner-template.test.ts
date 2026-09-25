import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { createPropertyApplicationTemplate, applicationDraftReviewFingerprint, applicationTemplateQuestionConfigFromSlice, publishApplicationTemplateQuestionDraft } from "@/lib/property-application-templates";
import { resolveCosignerTemplateForApplication } from "@/lib/rental-application/cosigner-template.server";
import { listingCustomApplicationFields, validateCustomFieldAnswers } from "@/lib/rental-application/custom-fields";

describe("co-signer published question resolution", () => {
  it("keeps a linked co-signer on v1 after v2 is published and validates its answer", async () => {
    const base = { ...createPropertyApplicationTemplate({ kind: "long-term", label: "Co-signer form" }), formVariant: "cosigner" as const };
    const config = applicationTemplateQuestionConfigFromSlice({
      applicationConfigMode: "custom", disabledStandardApplicationKeys: [],
      customApplicationFields: [{ id: "q1", key: "co_income", label: "Income explanation", type: "text", required: true, options: [], section: "additional" }],
    });
    config.importProvenance = { sourcePath: "owner/private-import.pdf", sourceSha256: "a".repeat(64), reviewedByUserId: "manager", reviewedDraftFingerprint: applicationDraftReviewFingerprint(config), unresolvedCount: 0 };
    const v1 = publishApplicationTemplateQuestionDraft({ ...base, draftQuestionConfig: config });
    const v2 = publishApplicationTemplateQuestionDraft({ ...v1, draftQuestionConfig: { ...config, importProvenance: undefined, customApplicationFields: [{ ...config.customApplicationFields[0], label: "Updated income explanation" }] } });
    const db = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { property_data: { listingSubmission: { ...createDefaultListingSubmission(), propertyApplicationTemplates: [v2] } } }, error: null }) }) }) }) }) } as unknown as SupabaseClient;
    const app = { manager_user_id: "owner-1", property_id: "property-1", row_data: {} };
    const pinned = await resolveCosignerTemplateForApplication(db, app, base.id, 1);
    expect(pinned?.templateVersion).toBe(1);
    expect(pinned?.config).not.toHaveProperty("importProvenance");
    const questions = listingCustomApplicationFields(pinned!.config);
    expect(questions.map((question) => question.label)).toEqual(["Income explanation"]);
    expect(validateCustomFieldAnswers(questions, [])).toHaveProperty("custom:co_income");
    expect(validateCustomFieldAnswers(questions, [{ key: "co_income", label: "Income explanation", type: "text", section: "additional", value: "Employment details" }])).toEqual({});
    expect((await resolveCosignerTemplateForApplication(db, app, base.id, 99))?.pinMissing).toBe(true);
  });
});
