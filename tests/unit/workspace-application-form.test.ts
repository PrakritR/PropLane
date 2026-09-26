import { describe, expect, it } from "vitest";
import {
  createDefaultListingSubmission,
  normalizeCustomApplicationFields,
  type ManagerCustomApplicationField,
} from "@/lib/manager-listing-submission";
import { applicationConfigForVariant } from "@/lib/rental-application/application-field-catalog";
import { isCustomFieldHiddenByCondition, validateCustomFieldAnswers } from "@/lib/rental-application/custom-fields";
import type { RentalCustomFieldAnswer } from "@/lib/rental-application/types";
import {
  applyEffectiveApplicationForm,
  applyShareAcrossVariants,
  emptyWorkspaceApplicationFormTemplate,
  normalizeWorkspaceApplicationFormTemplate,
  resolveEffectiveApplicationForm,
  workspaceApplicationFormIsConfigured,
  type WorkspaceApplicationFormTemplate,
} from "@/lib/rental-application/workspace-application-form";

function question(overrides: Partial<ManagerCustomApplicationField> = {}): ManagerCustomApplicationField {
  return {
    id: overrides.id ?? "q1",
    key: overrides.key ?? "pets",
    label: overrides.label ?? "Do you have pets?",
    type: overrides.type ?? "yes_no",
    required: overrides.required ?? false,
    options: overrides.options ?? [],
    section: overrides.section,
    standardKey: overrides.standardKey,
    description: overrides.description,
    showIf: overrides.showIf,
  };
}

function configuredWorkspaceForm(overrides: Partial<WorkspaceApplicationFormTemplate> = {}): WorkspaceApplicationFormTemplate {
  return {
    ...emptyWorkspaceApplicationFormTemplate(),
    customApplicationFields: [question({ id: "ws1", key: "workspace-question", label: "Workspace question" })],
    applicationConfigMode: "custom",
    ...overrides,
  };
}

describe("resolveEffectiveApplicationForm", () => {
  it("workspace default: a listing with no explicit source follows a configured workspace form", () => {
    const listing = createDefaultListingSubmission();
    const workspaceForm = configuredWorkspaceForm();
    const resolved = resolveEffectiveApplicationForm(listing, workspaceForm);
    expect(resolved.customApplicationFields).toEqual(workspaceForm.customApplicationFields);
    expect(resolved.applicationConfigMode).toBe("custom");
  });

  it("listing custom: applicationFormSource: 'custom' always keeps the listing's own fields, even with a workspace form present", () => {
    const ownField = question({ id: "own1", key: "own-question", label: "Listing-only question" });
    const listing = {
      ...createDefaultListingSubmission(),
      applicationFormSource: "custom" as const,
      customApplicationFields: [ownField],
      applicationConfigMode: "custom" as const,
    };
    const workspaceForm = configuredWorkspaceForm();
    const resolved = resolveEffectiveApplicationForm(listing, workspaceForm);
    expect(resolved.customApplicationFields).toEqual([ownField]);
  });

  it("missing workspace form: no template ever saved resolves to today's behaviour (the listing's own fields), regardless of source", () => {
    const ownField = question({ id: "own2", key: "legacy-question", label: "Pre-existing question" });
    const listing = {
      ...createDefaultListingSubmission(),
      customApplicationFields: [ownField],
      applicationConfigMode: "custom" as const,
    };
    const resolved = resolveEffectiveApplicationForm(listing, null);
    expect(resolved.customApplicationFields).toEqual([ownField]);
  });

  it("applyEffectiveApplicationForm bakes the resolved triplet onto a full submission, unchanged shape otherwise", () => {
    const listing = createDefaultListingSubmission();
    const workspaceForm = configuredWorkspaceForm();
    const applied = applyEffectiveApplicationForm(listing, workspaceForm);
    expect(applied.customApplicationFields).toEqual(workspaceForm.customApplicationFields);
    expect(applied.v).toBe(listing.v);
    expect(applied.buildingName).toBe(listing.buildingName);
  });

  it("feeds directly into applicationConfigForVariant with no signature change needed", () => {
    const listing = createDefaultListingSubmission();
    const workspaceForm = configuredWorkspaceForm();
    const resolved = resolveEffectiveApplicationForm(listing, workspaceForm);
    const slice = applicationConfigForVariant(resolved, "standard");
    expect(slice.customApplicationFields).toEqual(workspaceForm.customApplicationFields);
  });
});

describe("applyShareAcrossVariants", () => {
  it("mirrors the main list onto short-term and cosigner when true", () => {
    const main = [question({ id: "m1" })];
    const template = applyShareAcrossVariants({
      ...emptyWorkspaceApplicationFormTemplate(),
      customApplicationFields: main,
      disabledStandardApplicationKeys: ["some-key"],
      applicationConfigMode: "custom",
      shareAcrossVariants: true,
    });
    expect(template.shortTermCustomApplicationFields).toEqual(main);
    expect(template.shortTermDisabledStandardApplicationKeys).toEqual(["some-key"]);
    expect(template.shortTermApplicationConfigMode).toBe("custom");
    expect(template.cosignerCustomApplicationFields).toEqual(main);
    expect(template.cosignerApplicationConfigMode).toBe("custom");
  });

  it("leaves the three lists independent when false", () => {
    const main = [question({ id: "m1" })];
    const shortTerm = [question({ id: "st1", key: "short-term-only" })];
    const template = applyShareAcrossVariants({
      ...emptyWorkspaceApplicationFormTemplate(),
      customApplicationFields: main,
      applicationConfigMode: "custom",
      shortTermCustomApplicationFields: shortTerm,
      shortTermApplicationConfigMode: "custom",
      shareAcrossVariants: false,
    });
    expect(template.shortTermCustomApplicationFields).toEqual(shortTerm);
    expect(template.shortTermCustomApplicationFields).not.toEqual(main);
  });

  it("normalizeWorkspaceApplicationFormTemplate applies the mirror on read-back too, and defaults shareAcrossVariants to true", () => {
    const normalized = normalizeWorkspaceApplicationFormTemplate({
      customApplicationFields: [question({ id: "n1" })],
      applicationConfigMode: "custom",
    });
    expect(normalized).not.toBeNull();
    expect(normalized!.shareAcrossVariants).toBe(true);
    expect(normalized!.shortTermCustomApplicationFields).toEqual(normalized!.customApplicationFields);
    expect(normalized!.cosignerCustomApplicationFields).toEqual(normalized!.customApplicationFields);
  });

  it("normalizeWorkspaceApplicationFormTemplate returns null for a never-saved (absent) value", () => {
    expect(normalizeWorkspaceApplicationFormTemplate(undefined)).toBeNull();
    expect(normalizeWorkspaceApplicationFormTemplate(null)).toBeNull();
  });

  it("workspaceApplicationFormIsConfigured is false for an empty template and true once a question exists", () => {
    expect(workspaceApplicationFormIsConfigured(emptyWorkspaceApplicationFormTemplate())).toBe(false);
    expect(workspaceApplicationFormIsConfigured(configuredWorkspaceForm())).toBe(true);
  });
});

describe("normalizeCustomApplicationFields showIf round trip", () => {
  it("keeps a well-formed showIf", () => {
    const [normalized] = normalizeCustomApplicationFields([
      question({ showIf: { fieldKey: "has-pets", equals: "yes" } }),
    ]);
    expect(normalized!.showIf).toEqual({ fieldKey: "has-pets", equals: "yes" });
  });

  it("drops a malformed showIf rather than throwing", () => {
    const [normalized] = normalizeCustomApplicationFields([
      { ...question(), showIf: { fieldKey: 42, equals: "yes" } },
    ]);
    expect(normalized!.showIf).toBeUndefined();
  });

  it("a question with no showIf normalizes to undefined, not null or a stray key", () => {
    const [normalized] = normalizeCustomApplicationFields([question()]);
    expect(normalized!.showIf).toBeUndefined();
  });
});

describe("isCustomFieldHiddenByCondition / showIf", () => {
  const gate = question({ id: "gate", key: "has-pets", label: "Do you have pets?", type: "yes_no" });
  const conditional = question({
    id: "conditional",
    key: "pet-details",
    label: "Describe your pets",
    type: "text",
    required: true,
    showIf: { fieldKey: "has-pets", equals: "yes" },
  });

  function answers(value: string | undefined): RentalCustomFieldAnswer[] {
    return value === undefined ? [] : [{ key: "has-pets", label: gate.label, type: "yes_no", section: gate.section, value }];
  }

  it("a question with no showIf is never hidden", () => {
    expect(isCustomFieldHiddenByCondition(gate, [])).toBe(false);
  });

  it("hidden when the gating answer does not match", () => {
    expect(isCustomFieldHiddenByCondition(conditional, answers("no"))).toBe(true);
    expect(isCustomFieldHiddenByCondition(conditional, answers(undefined))).toBe(true);
  });

  it("shown when the gating answer matches", () => {
    expect(isCustomFieldHiddenByCondition(conditional, answers("yes"))).toBe(false);
  });

  it("validateCustomFieldAnswers never requires a hidden question, even though it is marked required", () => {
    const errors = validateCustomFieldAnswers([gate, conditional], answers("no"));
    expect(errors["custom:pet-details"]).toBeUndefined();
  });

  it("validateCustomFieldAnswers DOES require the same question once its condition is met", () => {
    const errors = validateCustomFieldAnswers([gate, conditional], answers("yes"));
    expect(errors["custom:pet-details"]).toBe("Describe your pets is required.");
  });
});
