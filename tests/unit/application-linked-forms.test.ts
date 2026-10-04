import { describe, expect, it } from "vitest";
import {
  COSIGNER_QUESTION_STANDARD_KEY,
  deriveCosignerLinkedFormRule,
  normalizeLinkedFormRules,
  ruleMatches,
  whenOptionLabel,
  whenOptionsForQuestionType,
  withDerivedCosignerRule,
} from "@/lib/application-linked-forms";
import { linkedFormOptionsFromListing } from "@/lib/application-linked-form-options";
import { editorFieldsWithLinkedForms, orderedEditorApplicationFields } from "@/lib/application-editor-fields";
import { createDefaultListingSubmission, normalizeCustomApplicationFields } from "@/lib/manager-listing-submission";
import { createPropertyApplicationTemplate } from "@/lib/property-application-templates";
import {
  applicationConfigForVariant,
  patchListingApplicationField,
  resolveListingApplicationFields,
} from "@/lib/rental-application/application-field-catalog";

describe("normalizeLinkedFormRules", () => {
  it("keeps well-formed rules and drops malformed ones", () => {
    const rules = normalizeLinkedFormRules([
      { id: "a", whenEquals: "yes", formRef: { kind: "application", id: "app-1" }, neededBeforeReview: true },
      { id: "b", whenEquals: ">0", formRef: { kind: "move_in", id: "mif-1" } },
      { id: "c", whenEquals: "yes", formRef: { kind: "lease", id: "x" } },
      { id: "d", whenEquals: "yes", formRef: { kind: "application", id: "  " } },
      { id: "e", whenEquals: "yes" },
      null,
      "nope",
    ]);
    expect(rules).toEqual([
      { id: "a", whenEquals: "yes", formRef: { kind: "application", id: "app-1" }, neededBeforeReview: true },
      { id: "b", whenEquals: ">0", formRef: { kind: "move_in", id: "mif-1" }, neededBeforeReview: false },
    ]);
  });

  it("defaults a blank answer to any, mints a missing id and drops a repeated id", () => {
    const rules = normalizeLinkedFormRules([
      { whenEquals: "  ", formRef: { kind: "application", id: "app-1" } },
      { id: "same", whenEquals: "no", formRef: { kind: "application", id: "app-2" } },
      { id: "same", whenEquals: "yes", formRef: { kind: "application", id: "app-3" } },
    ]);
    expect(rules).toHaveLength(2);
    expect(rules[0]!.id).toMatch(/^lfr-/);
    expect(rules[0]!.whenEquals).toBe("any");
    expect(rules[1]!.formRef.id).toBe("app-2");
  });

  it("is empty for anything that is not an array", () => {
    expect(normalizeLinkedFormRules(undefined)).toEqual([]);
    expect(normalizeLinkedFormRules({})).toEqual([]);
  });
});

describe("whenOptionsForQuestionType", () => {
  it("offers yes / no / any for a checkbox and for a Yes-No pick", () => {
    expect(whenOptionsForQuestionType("checkbox")).toEqual(["yes", "no", "any"]);
    expect(whenOptionsForQuestionType("select", ["Yes", "No"])).toEqual(["yes", "no", "any"]);
  });

  it("offers more-than-zero / any for a number", () => {
    expect(whenOptionsForQuestionType("number")).toEqual([">0", "any"]);
  });

  it("offers each choice then any for other picks", () => {
    expect(whenOptionsForQuestionType("select", ["Cat", "Dog", " "])).toEqual(["Cat", "Dog", "any"]);
    expect(whenOptionsForQuestionType("multi_select", ["A", "B"])).toEqual(["A", "B", "any"]);
  });

  it("offers only any for everything else", () => {
    for (const type of ["text", "long_text", "date", "file", "photos"]) expect(whenOptionsForQuestionType(type)).toEqual(["any"]);
  });

  it("reads each value plainly", () => {
    expect([whenOptionLabel("yes"), whenOptionLabel("no"), whenOptionLabel("any"), whenOptionLabel(">0"), whenOptionLabel("Cat")]).toEqual([
      "Yes",
      "No",
      "Any answer",
      "More than 0",
      "Cat",
    ]);
  });
});

describe("ruleMatches", () => {
  const rule = (whenEquals: string) => ({ whenEquals });

  it("matches yes / no across the spellings an answer is stored in", () => {
    for (const answer of ["Yes", "yes", " YES ", true, "true"]) expect(ruleMatches(rule("yes"), answer), String(answer)).toBe(true);
    for (const answer of ["No", "no", false, "false"]) expect(ruleMatches(rule("no"), answer), String(answer)).toBe(true);
    expect(ruleMatches(rule("yes"), "No")).toBe(false);
    expect(ruleMatches(rule("no"), "Yes")).toBe(false);
    expect(ruleMatches(rule("yes"), null)).toBe(false);
    expect(ruleMatches(rule("no"), "")).toBe(false);
  });

  it("matches a number greater than zero", () => {
    expect(ruleMatches(rule(">0"), 2)).toBe(true);
    expect(ruleMatches(rule(">0"), "$1,200")).toBe(true);
    expect(ruleMatches(rule(">0"), 0)).toBe(false);
    expect(ruleMatches(rule(">0"), "")).toBe(false);
    expect(ruleMatches(rule(">0"), "abc")).toBe(false);
  });

  it("matches any answer only when something was answered", () => {
    expect(ruleMatches(rule("any"), "x")).toBe(true);
    expect(ruleMatches(rule("any"), 0)).toBe(true);
    expect(ruleMatches(rule("any"), ["a"])).toBe(true);
    for (const answer of ["", "  ", null, undefined, false, []]) expect(ruleMatches(rule("any"), answer), String(answer)).toBe(false);
  });

  it("matches a choice case-insensitively and inside a multi-select", () => {
    expect(ruleMatches(rule("Dog"), "dog")).toBe(true);
    expect(ruleMatches(rule("Dog"), ["Cat", "dog"])).toBe(true);
    expect(ruleMatches(rule("Dog"), "Cat")).toBe(false);
    expect(ruleMatches(rule("Dog"), undefined)).toBe(false);
  });
});

describe("the co-signer link read as a rule", () => {
  it("derives one yes -> that form, needed before review", () => {
    expect(deriveCosignerLinkedFormRule("cos-1")).toMatchObject({
      whenEquals: "yes",
      formRef: { kind: "application", id: "cos-1" },
      neededBeforeReview: true,
    });
  });

  it("adds the rule to the built-in Co-signer planned question only, and only when it was never configured", () => {
    const slice = applicationConfigForVariant(createDefaultListingSubmission(), "standard");
    const fields = orderedEditorApplicationFields(slice);
    const derived = editorFieldsWithLinkedForms(fields, "cos-1");
    const cosigner = derived.find((field) => field.standardKey === COSIGNER_QUESTION_STANDARD_KEY)!;
    expect(cosigner.linkedForms).toEqual([deriveCosignerLinkedFormRule("cos-1")]);
    expect(derived.filter((field) => field.linkedForms !== undefined)).toHaveLength(1);
    // Nothing is written: the stored slice is untouched.
    expect(slice.customApplicationFields).toEqual([]);
    // No link, no rule.
    expect(editorFieldsWithLinkedForms(fields, null).some((field) => field.linkedForms !== undefined)).toBe(false);
  });

  it("leaves a question whose rules the manager already saved (even an empty list) alone", () => {
    const base = { standardKey: COSIGNER_QUESTION_STANDARD_KEY };
    expect(withDerivedCosignerRule([{ ...base, linkedForms: [] }], "cos-1")[0]!.linkedForms).toEqual([]);
    const own = [{ id: "r", whenEquals: "no", formRef: { kind: "move_in" as const, id: "m" }, neededBeforeReview: false }];
    expect(withDerivedCosignerRule([{ ...base, linkedForms: own }], "cos-1")[0]!.linkedForms).toEqual(own);
  });

  it("persists once the manager edits the question, and an emptied list is not re-derived", () => {
    const slice = applicationConfigForVariant(createDefaultListingSubmission(), "standard");
    const cosigner = editorFieldsWithLinkedForms(orderedEditorApplicationFields(slice), "cos-1").find((f) => f.standardKey === COSIGNER_QUESTION_STANDARD_KEY)!;
    const edited = patchListingApplicationField(slice, cosigner, { required: true });
    const stored = normalizeCustomApplicationFields(JSON.parse(JSON.stringify(edited.customApplicationFields)));
    expect(stored.find((f) => f.standardKey === COSIGNER_QUESTION_STANDARD_KEY)!.linkedForms).toEqual([deriveCosignerLinkedFormRule("cos-1")]);

    const cleared = patchListingApplicationField({ ...slice, ...edited }, cosigner, { linkedForms: [] });
    const clearedStored = normalizeCustomApplicationFields(JSON.parse(JSON.stringify(cleared.customApplicationFields)));
    expect(clearedStored.find((f) => f.standardKey === COSIGNER_QUESTION_STANDARD_KEY)!.linkedForms).toEqual([]);
    const resolved = resolveListingApplicationFields({ ...slice, ...cleared }, normalizeCustomApplicationFields);
    expect(editorFieldsWithLinkedForms(resolved, "cos-1").find((f) => f.standardKey === COSIGNER_QUESTION_STANDARD_KEY)!.linkedForms).toEqual([]);
  });
});

describe("where rules are stored", () => {
  const rule = { id: "r1", whenEquals: "yes", formRef: { kind: "application" as const, id: "app-9" }, neededBeforeReview: false };

  it("a built-in keeps them on its override row and resolves them back", () => {
    const slice = applicationConfigForVariant(createDefaultListingSubmission(), "standard");
    const pets = orderedEditorApplicationFields(slice).find((f) => f.standardKey === "additional-pets")!;
    const next = patchListingApplicationField(slice, pets, { linkedForms: [rule] });
    expect(next.customApplicationFields).toHaveLength(1);
    expect(next.customApplicationFields[0]).toMatchObject({ standardKey: "additional-pets", linkedForms: [rule] });
    const roundTrip = resolveListingApplicationFields(
      { ...slice, ...JSON.parse(JSON.stringify(next)) },
      normalizeCustomApplicationFields,
    );
    expect(roundTrip.find((f) => f.standardKey === "additional-pets")!.linkedForms).toEqual([rule]);
  });

  it("a custom question keeps them on its own row", () => {
    const stored = normalizeCustomApplicationFields([
      { id: "c1", key: "smoke", label: "Do you smoke?", type: "select", required: false, options: ["Yes", "No"], linkedForms: [rule, { bogus: true }] },
      { id: "c2", key: "plain", label: "Plain", type: "text", required: false, options: [] },
    ]);
    expect(stored[0]!.linkedForms).toEqual([rule]);
    expect(stored[1]!.linkedForms).toBeUndefined();
  });
});

describe("linkedFormOptionsFromListing", () => {
  it("lists this listing's applications with their own fee and its move-in forms without one", () => {
    const sub = {
      ...createDefaultListingSubmission(),
      applicationFee: "35",
      propertyApplicationTemplates: [
        { ...createPropertyApplicationTemplate({ kind: "long-term", label: "Standard application" }), id: "app-a", feeCentsOverride: 5000 },
        { ...createPropertyApplicationTemplate({ kind: "long-term", label: "Plain application" }), id: "app-b" },
        { ...createPropertyApplicationTemplate({ kind: "long-term", label: "Free application" }), id: "app-c", feeCentsOverride: 0 },
      ],
      moveInFormTemplates: [{ id: "mif-1", name: "Pet addendum" }],
    } as unknown as Parameters<typeof linkedFormOptionsFromListing>[0];
    const options = linkedFormOptionsFromListing(sub);
    expect(options.find((o) => o.ref.id === "app-a")).toMatchObject({ label: "Standard application", feeText: "Charges $50" });
    expect(options.find((o) => o.ref.id === "app-b")!.feeText).toBe("Charges $35");
    expect(options.find((o) => o.ref.id === "app-c")!.feeText).toBe("No fee");
    expect(options.find((o) => o.ref.kind === "move_in")).toEqual({ ref: { kind: "move_in", id: "mif-1" }, label: "Pet addendum", feeText: "No fee" });
    expect(linkedFormOptionsFromListing(sub, { excludeApplicationId: "app-a" }).some((o) => o.ref.id === "app-a")).toBe(false);
  });
});
