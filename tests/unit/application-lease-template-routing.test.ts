import { describe, expect, it } from "vitest";
import {
  resolveLeaseTemplateIdFromApplicationAnswers,
  resolvePropertyLeaseTemplateFromApplicationAnswers,
} from "@/lib/application-lease-template-routing";
import {
  createDefaultListingSubmission,
  normalizeCustomApplicationFields,
} from "@/lib/manager-listing-submission";
import { createPropertyLeaseTemplate } from "@/lib/property-lease-templates";

describe("application answer → lease template routing (C1-PIPE1)", () => {
  it("returns the lease mapped to the selected dropdown option", () => {
    const longTerm = createPropertyLeaseTemplate({ kind: "long-term", label: "Standard lease" });
    const alt = createPropertyLeaseTemplate({ kind: "long-term", label: "Month-to-month doc" });
    const sub = {
      ...createDefaultListingSubmission(),
      propertyLeaseTemplates: [longTerm, alt],
      customApplicationFields: normalizeCustomApplicationFields([
        {
          id: "q1",
          key: "lease_pick",
          label: "Which lease?",
          type: "select",
          required: true,
          options: ["Standard", "Flexible"],
          optionLeaseTemplateIds: [longTerm.id, alt.id],
        },
      ]),
    };
    const templateId = resolveLeaseTemplateIdFromApplicationAnswers(sub, {
      customFieldAnswers: [
        {
          key: "lease_pick",
          label: "Which lease?",
          type: "select",
          value: "Flexible",
        },
      ],
    });
    expect(templateId).toBe(alt.id);
    const picked = resolvePropertyLeaseTemplateFromApplicationAnswers(sub, {
      customFieldAnswers: [
        {
          key: "lease_pick",
          label: "Which lease?",
          type: "select",
          value: "Flexible",
        },
      ],
    });
    expect(picked?.id).toBe(alt.id);
  });

  it("falls through when no mapping is configured", () => {
    const sub = createDefaultListingSubmission();
    expect(
      resolveLeaseTemplateIdFromApplicationAnswers(sub, {
        customFieldAnswers: [{ key: "x", label: "X", type: "text", value: "y" }],
      }),
    ).toBeNull();
  });
});
