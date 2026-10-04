import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { newMoveInFormTemplate } from "@/lib/move-in-forms/templates";
import {
  applicationTemplateQuestionConfigFromSlice,
  createPropertyApplicationTemplate,
  publishApplicationTemplateQuestionDraft,
} from "@/lib/property-application-templates";

/**
 * A listing with a standard application whose co-signer link and "Do you have pets?" rule each owe a form: the
 * co-signer application (own fee) and a pet-agreement move-in form.
 */
export function buildLinkedFormListing() {
  const cosigner = { ...createPropertyApplicationTemplate({ kind: "long-term", label: "Co-signer form" }), formVariant: "cosigner" as const };
  const cosignerPublished = publishApplicationTemplateQuestionDraft({
    ...cosigner,
    feeCentsOverride: 4500,
    draftQuestionConfig: applicationTemplateQuestionConfigFromSlice({
      applicationConfigMode: "custom",
      disabledStandardApplicationKeys: [],
      customApplicationFields: [
        { id: "c1", key: "co_income", label: "Income", type: "text", required: true, options: [], section: "additional" },
        { id: "c2", key: "co_employer", label: "Employer", type: "text", required: false, options: [], section: "additional" },
      ],
    }),
  });
  const petForm = newMoveInFormTemplate("built", "pet-agreement");
  const main = createPropertyApplicationTemplate({ kind: "long-term", label: "Standard application" });
  const mainPublished = publishApplicationTemplateQuestionDraft({
    ...main,
    linkedCosignerApplicationTemplateId: cosignerPublished.id,
    draftQuestionConfig: applicationTemplateQuestionConfigFromSlice({
      applicationConfigMode: "custom",
      disabledStandardApplicationKeys: [],
      customApplicationFields: [
        {
          id: "q-pets",
          key: "has_pets",
          label: "Do you have pets?",
          type: "select",
          required: false,
          options: ["Yes", "No"],
          section: "additional",
          linkedForms: [{ id: "rule-pets", whenEquals: "yes", formRef: { kind: "move_in", id: petForm.id }, neededBeforeReview: false }],
        },
      ],
    }),
  });
  return {
    listing: { ...createDefaultListingSubmission(), propertyApplicationTemplates: [mainPublished, cosignerPublished], moveInFormTemplates: [petForm] },
    mainId: mainPublished.id,
    cosignerId: cosignerPublished.id,
    petFormId: petForm.id,
  };
}
