import { describe, expect, it } from "vitest";
import {
  activeApplicationWizardSteps,
  applicationConfigForVariant,
  isWizardFormFieldEnabled,
  mergeApplicationConfigForVariant,
  reenableListingApplicationField,
  resolveListingApplicationFields,
  editorVisibleDisabledApplicationFields,
  COSIGNER_DEFAULT_DISABLED_STANDARD_KEYS,
  SHORT_TERM_DEFAULT_DISABLED_STANDARD_KEYS,
  STANDARD_APPLICATION_FIELD_CATALOG,
} from "@/lib/rental-application/application-field-catalog";
import { createDefaultListingSubmission, normalizeCustomApplicationFields } from "@/lib/manager-listing-submission";

const employmentKey = STANDARD_APPLICATION_FIELD_CATALOG.find((d) => d.section === "employment")!.standardKey;

function catalogField(section: (typeof STANDARD_APPLICATION_FIELD_CATALOG)[number]["section"], label: string) {
  const def = STANDARD_APPLICATION_FIELD_CATALOG.find((d) => d.section === section && d.label === label);
  if (!def) throw new Error(`Missing catalog field ${section}:${label}`);
  return def;
}
describe("household and co-signer application questions", () => {
  it("includes group and co-signer prompts in the standard catalog by default", () => {
    const cosigner = catalogField("household", "Co-signer planned");
    const household = catalogField("household", "Group application");
    expect(cosigner.wizardFormKeys).toEqual(["hasCosigner"]);
    expect(household.wizardFormKeys).toEqual(["applyingAsGroup"]);
    const fields = resolveListingApplicationFields(createDefaultListingSubmission(), normalizeCustomApplicationFields);
    expect(fields.some((f) => f.standardKey === household.standardKey)).toBe(true);
    expect(fields.some((f) => f.standardKey === cosigner.standardKey)).toBe(true);
  });

  it("omits household questions when every household question is disabled", () => {
    const householdKeys = STANDARD_APPLICATION_FIELD_CATALOG.filter((d) => d.section === "household").map(
      (d) => d.standardKey,
    );
    const sub = {
      disabledStandardApplicationKeys: householdKeys,
      customApplicationFields: [],
      applicationConfigMode: "custom" as const,
    };
    const fields = resolveListingApplicationFields(sub, normalizeCustomApplicationFields);
    expect(fields.some((f) => f.section === "household")).toBe(false);
    const steps = activeApplicationWizardSteps(sub, normalizeCustomApplicationFields);
    expect(steps).toContain(1);
    expect(steps).toContain(2);
  });
});

describe("application form variants — short-term vs long-term are configured independently", () => {
  it("long-term reads a configured custom triplet unchanged", () => {
    const sub = {
      disabledStandardApplicationKeys: ["personal-phone"],
      customApplicationFields: [],
      applicationConfigMode: "custom" as const,
    };
    const slice = applicationConfigForVariant(sub, "standard");
    expect(slice.disabledStandardApplicationKeys).toEqual(["personal-phone"]);
    expect(slice.applicationConfigMode).toBe("custom");
  });

  it("unconfigured long-term resolves to the full standard catalog", () => {
    const slice = applicationConfigForVariant({}, "standard");
    expect(slice.applicationConfigMode).toBe("standard");
    expect(slice.disabledStandardApplicationKeys).toEqual([]);
    const fields = resolveListingApplicationFields(slice, normalizeCustomApplicationFields);
    expect(fields).toHaveLength(STANDARD_APPLICATION_FIELD_CATALOG.length);
    expect(fields.some((f) => f.label === "Group application")).toBe(true);
    expect(fields.some((f) => f.label === "Co-signer planned")).toBe(true);
  });

  it("an unconfigured co-signer form resolves to the curated co-signer question set", () => {
    const slice = applicationConfigForVariant({}, "cosigner");
    expect(slice.applicationConfigMode).toBe("standard");
    expect([...slice.disabledStandardApplicationKeys].sort()).toEqual(
      [...COSIGNER_DEFAULT_DISABLED_STANDARD_KEYS].sort(),
    );
    expect(isWizardFormFieldEnabled(slice, "fullLegalName")).toBe(true);
    expect(isWizardFormFieldEnabled(slice, "employer")).toBe(true);
    expect(isWizardFormFieldEnabled(slice, "hasCosigner")).toBe(false);
    expect(isWizardFormFieldEnabled(slice, "applyingAsGroup")).toBe(false);
    expect(isWizardFormFieldEnabled(slice, "propertyId")).toBe(false);
    expect(isWizardFormFieldEnabled(slice, "ref1Name")).toBe(false);
    expect(isWizardFormFieldEnabled(slice, "pets")).toBe(false);
    expect(isWizardFormFieldEnabled(slice, "bankruptcyHistory")).toBe(true);
  });

  it("a configured (custom) co-signer form reads its own stored slice", () => {
    const sub = {
      cosignerApplicationConfigMode: "custom" as const,
      cosignerDisabledStandardApplicationKeys: ["personal-email"],
      cosignerCustomApplicationFields: [],
    };
    const slice = applicationConfigForVariant(sub, "cosigner");
    expect(slice.disabledStandardApplicationKeys).toEqual(["personal-email"]);
    expect(isWizardFormFieldEnabled(slice, "email")).toBe(false);
  });

  it("an unconfigured short-term form resolves to the curated default question set", () => {
    const slice = applicationConfigForVariant({}, "short_term");
    expect(slice.applicationConfigMode).toBe("standard");
    expect([...slice.disabledStandardApplicationKeys].sort()).toEqual(
      [...SHORT_TERM_DEFAULT_DISABLED_STANDARD_KEYS].sort(),
    );
    // Screening/employment/reference sections are off by default...
    expect(isWizardFormFieldEnabled(slice, "employer")).toBe(false);
    expect(isWizardFormFieldEnabled(slice, "ssn")).toBe(false);
    // ...but who/where/when + name stay on.
    expect(isWizardFormFieldEnabled(slice, "fullLegalName")).toBe(true);
    expect(isWizardFormFieldEnabled(slice, "leaseStart")).toBe(true);
    expect(isWizardFormFieldEnabled(slice, "applyingAsGroup")).toBe(true);
    expect(isWizardFormFieldEnabled(slice, "hasCosigner")).toBe(true);
  });

  it("a configured (custom) short-term form reads its own stored slice, not the default", () => {
    const sub = {
      shortTermApplicationConfigMode: "custom" as const,
      shortTermDisabledStandardApplicationKeys: ["personal-email"],
      shortTermCustomApplicationFields: [],
    };
    const slice = applicationConfigForVariant(sub, "short_term");
    expect(slice.disabledStandardApplicationKeys).toEqual(["personal-email"]);
    // Employment is NOT in the stored set, so it is enabled again for this manager.
    expect(isWizardFormFieldEnabled(slice, "employer")).toBe(true);
  });

  it("editing one form never mutates the other's stored fields", () => {
    // Turn a question off on the long-term form.
    const longMerge = mergeApplicationConfigForVariant("standard", {
      disabledStandardApplicationKeys: ["personal-phone"],
      customApplicationFields: [],
      applicationConfigMode: "custom",
    });
    expect(longMerge.disabledStandardApplicationKeys).toEqual(["personal-phone"]);
    expect(longMerge.shortTermDisabledStandardApplicationKeys).toBeUndefined();

    // Turn a (different) question off on the short-term form.
    const shortMerge = mergeApplicationConfigForVariant("short_term", {
      disabledStandardApplicationKeys: ["personal-email"],
      customApplicationFields: [],
      applicationConfigMode: "custom",
    });
    expect(shortMerge.shortTermDisabledStandardApplicationKeys).toEqual(["personal-email"]);
    expect(shortMerge.disabledStandardApplicationKeys).toBeUndefined();

    // Applied together on one submission, each form keeps its own answer.
    const sub = { ...longMerge, ...shortMerge };
    expect(isWizardFormFieldEnabled(applicationConfigForVariant(sub, "standard"), "phone")).toBe(false);
    expect(isWizardFormFieldEnabled(applicationConfigForVariant(sub, "standard"), "email")).toBe(true);
    expect(isWizardFormFieldEnabled(applicationConfigForVariant(sub, "short_term"), "email")).toBe(false);
    expect(isWizardFormFieldEnabled(applicationConfigForVariant(sub, "short_term"), "phone")).toBe(true);
  });
});

describe("manager editor — disabled question visibility", () => {
  it("hides curated default-off questions from the ghost list", () => {
    const shortDefault = applicationConfigForVariant({}, "short_term");
    expect(editorVisibleDisabledApplicationFields("short_term", shortDefault)).toEqual([]);
    const cosignerDefault = applicationConfigForVariant({}, "cosigner");
    expect(editorVisibleDisabledApplicationFields("cosigner", cosignerDefault)).toEqual([]);
  });

  it("shows only manager-removed questions once a variant is customized", () => {
    const nameKey = STANDARD_APPLICATION_FIELD_CATALOG.find((d) =>
      d.wizardFormKeys.includes("fullLegalName"),
    )!.standardKey;
    const slice = {
      ...applicationConfigForVariant({}, "short_term"),
      applicationConfigMode: "custom" as const,
      disabledStandardApplicationKeys: [...SHORT_TERM_DEFAULT_DISABLED_STANDARD_KEYS, nameKey],
    };
    const ghosts = editorVisibleDisabledApplicationFields("short_term", slice);
    expect(ghosts.map((f) => f.standardKey)).toEqual([nameKey]);
  });
});

describe("active wizard steps derive from the variant's enabled questions", () => {
  it("the long-term default walks every wizard step", () => {
    const steps = activeApplicationWizardSteps(
      applicationConfigForVariant({}, "standard"),
      normalizeCustomApplicationFields,
    );
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("the short-term default skips the screening sections it turns off", () => {
    const steps = activeApplicationWizardSteps(
      applicationConfigForVariant({}, "short_term"),
      normalizeCustomApplicationFields,
    );
    // 4 Current address, 5 Previous address, 6 Employment, 7 References, 8 Additional are gone.
    expect(steps).toEqual([1, 2, 3, 9, 10, 11]);
  });

  it("a short-term form with every built-in re-enabled stays fully enabled (does not revert to the curated default)", () => {
    // Reproduces the manager clicking "Add back" on every off-by-default
    // short-term built-in. The editor pins mode "custom" on edits so the now-empty
    // disabled set does NOT collapse to "standard" — which applicationConfigForVariant
    // would otherwise read as the curated default and silently re-disable everything.
    let slice = applicationConfigForVariant({}, "short_term");
    for (const key of SHORT_TERM_DEFAULT_DISABLED_STANDARD_KEYS) {
      slice = reenableListingApplicationField(slice, key);
    }
    const pinned = { ...slice, applicationConfigMode: "custom" as const }; // what persistEditedSlice does
    const sub = mergeApplicationConfigForVariant("short_term", pinned);
    const resolved = applicationConfigForVariant(sub, "short_term");
    expect(resolved.applicationConfigMode).toBe("custom");
    expect(resolved.disabledStandardApplicationKeys).toEqual([]);
    expect(isWizardFormFieldEnabled(resolved, "employer")).toBe(true);
    expect(isWizardFormFieldEnabled(resolved, "ssn")).toBe(true);
    // The long-term form is untouched by short-term edits.
    expect(sub.disabledStandardApplicationKeys).toBeUndefined();
  });

  it("re-enabling a question brings its step back for that form only", () => {
    const shortDefault = applicationConfigForVariant({}, "short_term");
    const shortSteps = activeApplicationWizardSteps(shortDefault, normalizeCustomApplicationFields);
    expect(shortSteps).not.toContain(6);
    const reenabled = reenableListingApplicationField(shortDefault, employmentKey);
    const steps = activeApplicationWizardSteps(reenabled, normalizeCustomApplicationFields);
    expect(steps).toContain(6);
    // The re-add flips the form to a customized config.
    expect(reenabled.applicationConfigMode).toBe("custom");
    const longDefault = applicationConfigForVariant({}, "standard");
    const longSteps = activeApplicationWizardSteps(longDefault, normalizeCustomApplicationFields);
    expect(longSteps).toContain(6);
  });
});

describe("resolveListingApplicationFields respects the variant slice", () => {
  it("lists more questions for the long-term default than the short-term default", () => {
    const longFields = resolveListingApplicationFields(
      applicationConfigForVariant({}, "standard"),
      normalizeCustomApplicationFields,
    );
    const shortFields = resolveListingApplicationFields(
      applicationConfigForVariant({}, "short_term"),
      normalizeCustomApplicationFields,
    );
    expect(longFields.length).toBe(STANDARD_APPLICATION_FIELD_CATALOG.length);
    expect(shortFields.length).toBeLessThan(longFields.length);
    expect(shortFields.some((f) => f.section === "employment")).toBe(false);
    expect(longFields.some((f) => f.section === "employment")).toBe(true);
    expect(shortFields.some((f) => f.section === "property")).toBe(true);
  });
});
