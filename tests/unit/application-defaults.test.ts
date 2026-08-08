import { describe, expect, it } from "vitest";
import {
  applicationConfigForVariant,
  LONG_TERM_DEFAULT_ENABLED_STANDARD_KEYS,
  listingApplicationUsesPropLaneDefaultQuestions,
  resolveListingApplicationFields,
  restoreDefaultApplicationConfig,
} from "@/lib/rental-application/application-field-catalog";
import {
  createDefaultListingSubmission,
  createNewListingWizardSubmission,
  normalizeCustomApplicationFields,
} from "@/lib/manager-listing-submission";

describe("long-term application defaults", () => {
  it("enables only the four PropLane default questions when unconfigured", () => {
    const slice = applicationConfigForVariant({}, "standard");
    const fields = resolveListingApplicationFields(slice, normalizeCustomApplicationFields);
    expect(fields).toHaveLength(4);
    expect(fields.map((f) => f.standardKey).sort()).toEqual(
      [...LONG_TERM_DEFAULT_ENABLED_STANDARD_KEYS].sort(),
    );
    expect(fields.map((f) => `${f.section}:${f.label}`)).toEqual([
      "household:Group application",
      "property:Property",
      "property:Lease term",
      "property:Lease start & end dates",
    ]);
  });

  it("new listing wizard submissions start on the PropLane default", () => {
    const sub = createNewListingWizardSubmission();
    expect(listingApplicationUsesPropLaneDefaultQuestions(sub)).toBe(true);
    const fields = resolveListingApplicationFields(
      applicationConfigForVariant(sub, "standard"),
      normalizeCustomApplicationFields,
    );
    expect(fields).toHaveLength(4);
  });

  it("restore defaults clears manager edits back to the curated baseline", () => {
    const sub = {
      ...createDefaultListingSubmission(),
      disabledStandardApplicationKeys: ["personal-phone"],
      customApplicationFields: normalizeCustomApplicationFields([
        { id: "c1", key: "c1", label: "Extra?", type: "text", required: false, options: [] },
      ]),
      applicationConfigMode: "custom" as const,
    };
    const restored = restoreDefaultApplicationConfig();
    const fields = resolveListingApplicationFields(
      applicationConfigForVariant({ ...sub, ...restored }, "standard"),
      normalizeCustomApplicationFields,
    );
    expect(fields).toHaveLength(4);
    expect(restored.applicationConfigMode).toBe("standard");
    expect(restored.disabledStandardApplicationKeys).toEqual([]);
  });

  it("detects manager-customized application config", () => {
    expect(listingApplicationUsesPropLaneDefaultQuestions(createNewListingWizardSubmission())).toBe(true);
    expect(
      listingApplicationUsesPropLaneDefaultQuestions({
        applicationConfigMode: "custom",
        disabledStandardApplicationKeys: [],
        customApplicationFields: [],
      }),
    ).toBe(false);
    expect(
      listingApplicationUsesPropLaneDefaultQuestions({
        applicationConfigMode: "standard",
        disabledStandardApplicationKeys: ["personal-phone"],
        customApplicationFields: [],
      }),
    ).toBe(false);
  });

  it("does not apply the curated default when the listing submission is unknown", () => {
    const slice = applicationConfigForVariant(null, "standard");
    expect(slice.disabledStandardApplicationKeys).toEqual([]);
  });
});
