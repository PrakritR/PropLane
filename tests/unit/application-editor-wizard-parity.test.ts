import { describe, expect, it } from "vitest";
import {
  createDefaultListingSubmission,
  normalizeCustomApplicationFields,
} from "@/lib/manager-listing-submission";
import { resolveListingApplicationFields } from "@/lib/rental-application/application-field-catalog";
import {
  customFieldsForWizardStep,
  listingCustomApplicationFields,
} from "@/lib/rental-application/custom-fields";
import { RENTAL_APPLICATION_SECTIONS } from "@/lib/rental-application/application-sections";

describe("C2-R30-6 editor sections align with applicant wizard steps", () => {
  it("groups custom questions the same way for Seattle-style default listing", () => {
    const sub = createDefaultListingSubmission();
    sub.applicationConfigMode = "custom";
    sub.customApplicationFields = normalizeCustomApplicationFields([
      {
        id: "c1",
        key: "move_window",
        label: "Move-in window",
        type: "text",
        required: false,
        options: [],
        section: "property",
      },
      {
        id: "c2",
        key: "referral",
        label: "How did you hear about us?",
        type: "select",
        required: false,
        options: ["Friend", "Online"],
        section: "additional",
      },
    ]);
    const custom = listingCustomApplicationFields(sub);
    const resolved = resolveListingApplicationFields(sub, normalizeCustomApplicationFields);
    for (const section of RENTAL_APPLICATION_SECTIONS) {
      if (section.id === "review") continue;
      const step = section.wizardStep;
      const wizardKeys = customFieldsForWizardStep(custom, step)
        .map((f) => f.key)
        .sort();
      const editorKeys = resolved
        .filter((f) => !f.isStandard && (f.section ?? "additional") === section.id)
        .map((f) => f.key)
        .sort();
      expect(editorKeys).toEqual(wizardKeys);
    }
  });
});
