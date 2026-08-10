import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission, normalizeCustomApplicationFields, normalizeCustomApplicationFieldsForEditor } from "@/lib/manager-listing-submission";
import {
  applicationConfigForVariant,
  isWizardFormFieldEnabled,
  listingDisabledWizardFormKeys,
  patchListingApplicationField,
  removeListingApplicationField,
  resolveListingApplicationFields,
  restoreDefaultApplicationConfig,
  STANDARD_APPLICATION_FIELD_CATALOG,
  type StandardApplicationFieldDef,
} from "@/lib/rental-application/application-field-catalog";

function catalogField(section: StandardApplicationFieldDef["section"], label: string): StandardApplicationFieldDef {
  const def = STANDARD_APPLICATION_FIELD_CATALOG.find((d) => d.section === section && d.label === label);
  if (!def) throw new Error(`Missing catalog field ${section}:${label}`);
  return def;
}

describe("application-field-catalog", () => {
  it("materializes the full standard catalog by default", () => {
    const sub = createDefaultListingSubmission();
    const fields = resolveListingApplicationFields(sub, normalizeCustomApplicationFields);
    expect(fields).toHaveLength(STANDARD_APPLICATION_FIELD_CATALOG.length);
    expect(fields.every((f) => f.isStandard)).toBe(true);
  });

  it("hides removed built-in questions", () => {
    const def = STANDARD_APPLICATION_FIELD_CATALOG[0]!;
    const sub = {
      ...createDefaultListingSubmission(),
      disabledStandardApplicationKeys: [def.standardKey],
    };
    const fields = resolveListingApplicationFields(sub, normalizeCustomApplicationFields);
    expect(fields.some((f) => f.standardKey === def.standardKey)).toBe(false);
  });

  it("persists label edits as overrides", () => {
    const def = STANDARD_APPLICATION_FIELD_CATALOG[0]!;
    const sub = createDefaultListingSubmission();
    const [field] = resolveListingApplicationFields(sub, normalizeCustomApplicationFields);
    const next = patchListingApplicationField(sub, field!, { label: "Edited label" });
    const resolved = resolveListingApplicationFields(next, normalizeCustomApplicationFields);
    expect(resolved.find((f) => f.standardKey === def.standardKey)?.label).toBe("Edited label");
  });

  it("restore defaults clears overrides and disabled keys", () => {
    const sub = {
      ...createDefaultListingSubmission(),
      disabledStandardApplicationKeys: [STANDARD_APPLICATION_FIELD_CATALOG[0]!.standardKey],
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
    expect(restored.customApplicationFields).toEqual([]);
  });

  it("editor normalizer keeps in-progress custom questions in their section", () => {
    const sub = {
      ...createDefaultListingSubmission(),
      customApplicationFields: [
        { id: "new-q", key: "", label: "", type: "text" as const, required: false, options: [], section: "property" },
      ],
    };
    const fields = resolveListingApplicationFields(sub, normalizeCustomApplicationFieldsForEditor);
    const propertyCustom = fields.filter((f) => !f.isStandard && (f.section ?? "additional") === "property");
    expect(propertyCustom).toHaveLength(1);
    expect(propertyCustom[0]?.id).toBe("new-q");
    expect(resolveListingApplicationFields(sub, normalizeCustomApplicationFields)).toHaveLength(
      STANDARD_APPLICATION_FIELD_CATALOG.length,
    );
  });

  it("remove built-in adds disabled key", () => {
    const sub = createDefaultListingSubmission();
    const field = resolveListingApplicationFields(sub, normalizeCustomApplicationFields)[0]!;
    const next = removeListingApplicationField(sub, field);
    expect(next.disabledStandardApplicationKeys).toContain(field.standardKey);
  });

  it("maps disabled built-in questions to wizard form keys", () => {
    const leaseTermDef = STANDARD_APPLICATION_FIELD_CATALOG.find((d) => d.label === "Lease term")!;
    const sub = {
      ...createDefaultListingSubmission(),
      disabledStandardApplicationKeys: [leaseTermDef.standardKey],
    };
    const disabled = listingDisabledWizardFormKeys(sub);
    expect(disabled.has("leaseTerm")).toBe(true);
    expect(isWizardFormFieldEnabled(sub, "leaseTerm")).toBe(false);
    expect(isWizardFormFieldEnabled(sub, "roomChoice1")).toBe(true);
  });

  it("every built-in catalog row maps to at least one wizard field", () => {
    const missing = STANDARD_APPLICATION_FIELD_CATALOG.filter((d) => d.wizardFormKeys.length === 0);
    expect(missing.map((d) => `${d.section}:${d.label}`)).toEqual([]);
  });

  it("assigns wizard-aligned types and options to key built-in questions", () => {
    expect(catalogField("additional", "Number of occupants")).toMatchObject({
      type: "select",
      options: ["1", "2", "3", "4", "5"],
    });
    expect(catalogField("additional", "Pets")).toMatchObject({ type: "text", options: [] });
    expect(catalogField("additional", "Eviction history")).toMatchObject({
      type: "select",
      options: ["Yes", "No"],
    });
    expect(catalogField("additional", "Bankruptcy history")).toMatchObject({
      type: "select",
      options: ["Yes", "No"],
    });
    expect(catalogField("additional", "Criminal history")).toMatchObject({
      type: "select",
      options: ["Yes", "No"],
    });
    expect(catalogField("consent", "Credit & background check consent")).toMatchObject({
      type: "checkbox",
      options: [],
    });
    expect(catalogField("consent", "Truthfulness certification")).toMatchObject({
      type: "checkbox",
      options: [],
    });
    expect(catalogField("consent", "Digital signature & date")).toMatchObject({
      type: "text",
      options: [],
    });
    expect(catalogField("employment", "Monthly / annual income")).toMatchObject({
      type: "number",
      options: [],
    });
    expect(catalogField("employment", "Proof of income (pay stub, etc.)")).toMatchObject({
      type: "file",
      required: false,
      wizardFormKeys: ["incomeProofPhotos"],
    });
    expect(catalogField("personal", "Driver's license / ID — front photo")).toMatchObject({
      type: "photos",
      required: false,
      wizardFormKeys: ["idPhotoFront"],
    });
    expect(catalogField("personal", "Driver's license / ID — back photo")).toMatchObject({
      type: "photos",
      required: false,
      wizardFormKeys: ["idPhotoBack"],
    });
    expect(catalogField("personal", "Driver's license / ID")).toMatchObject({
      type: "text",
      wizardFormKeys: ["driversLicense"],
    });
    expect(catalogField("employment", "Other income")).toMatchObject({
      type: "number",
      options: [],
    });
    expect(catalogField("property", "Lease start & end dates")).toMatchObject({
      type: "date",
      options: [],
    });
    expect(catalogField("property", "Room choices (1st – 3rd)")).toMatchObject({
      type: "select",
      options: [],
    });
    expect(catalogField("property", "Lease term")).toMatchObject({
      type: "select",
      options: [],
    });
  });
});
