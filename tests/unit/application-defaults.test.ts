import { describe, expect, it } from "vitest";
import {
  applicationConfigForVariant,
  listingApplicationUsesPropLaneDefaultQuestions,
  resolveListingApplicationFields,
  restoreDefaultApplicationConfig,
  STANDARD_APPLICATION_FIELD_CATALOG,
} from "@/lib/rental-application/application-field-catalog";
import {
  createDefaultListingSubmission,
  createNewListingWizardSubmission,
  normalizeCustomApplicationFields,
} from "@/lib/manager-listing-submission";

describe("long-term application defaults", () => {
  it("enables the full standard catalog when unconfigured", () => {
    const slice = applicationConfigForVariant({}, "standard");
    const fields = resolveListingApplicationFields(slice, normalizeCustomApplicationFields);
    expect(fields).toHaveLength(STANDARD_APPLICATION_FIELD_CATALOG.length);
    expect(fields.every((f) => f.isStandard)).toBe(true);
  });

  it("new listing wizard submissions start on the PropLane default", () => {
    const sub = createNewListingWizardSubmission();
    expect(listingApplicationUsesPropLaneDefaultQuestions(sub)).toBe(true);
    const fields = resolveListingApplicationFields(
      applicationConfigForVariant(sub, "standard"),
      normalizeCustomApplicationFields,
    );
    expect(fields).toHaveLength(STANDARD_APPLICATION_FIELD_CATALOG.length);
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
    expect(fields).toHaveLength(STANDARD_APPLICATION_FIELD_CATALOG.length);
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

  it("heals listings that still store the retired four-question default", () => {
    const legacyDisabled = STANDARD_APPLICATION_FIELD_CATALOG.filter(
      (def) =>
        ![
          "household-group-application",
          "property-property",
          "property-lease-term",
          "property-lease-start-end-dates",
        ].includes(def.standardKey),
    ).map((def) => def.standardKey);
    const sub = {
      applicationConfigMode: "standard" as const,
      disabledStandardApplicationKeys: legacyDisabled,
      customApplicationFields: [],
    };
    const slice = applicationConfigForVariant(sub, "standard");
    expect(slice.disabledStandardApplicationKeys).toEqual([]);
    expect(
      resolveListingApplicationFields(slice, normalizeCustomApplicationFields),
    ).toHaveLength(STANDARD_APPLICATION_FIELD_CATALOG.length);
    expect(listingApplicationUsesPropLaneDefaultQuestions(sub)).toBe(true);
  });
});
