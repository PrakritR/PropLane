import { describe, expect, it } from "vitest";
import { createPropertyApplicationTemplate, applicationDraftReviewFingerprint, applicationTemplateQuestionConfigFromSlice, publishApplicationTemplateQuestionDraft } from "@/lib/property-application-templates";
import { applicationConfigForApplicant } from "@/lib/rental-application/application-template-config";
import { listingCustomApplicationFields } from "@/lib/rental-application/custom-fields";
import { REQUIRED_IDENTITY_STANDARD_KEYS, applicationConfigForVariant, isWizardFormFieldRequired, removeListingApplicationField, resolveListingApplicationFields } from "@/lib/rental-application/application-field-catalog";
import { CUSTOM_APPLICATION_FIELD_TYPE_OPTIONS, normalizeCustomApplicationFields } from "@/lib/manager-listing-submission";
import { applicationImportMappingToDraft, mapApplicationPdfImport } from "@/lib/rental-application/application-pdf-import";

describe("application PDF import mapping", () => {
  it("maps identity prompts once and keeps their source wording", () => {
    const mapping = mapApplicationPdfImport({
      fileName: "application.pdf",
      sourceSha256: "a".repeat(64),
      coverage: { extractedCharacters: 132, representedCharacters: 132, complete: true },
      pages: [{
        pageNumber: 1,
        issues: [],
        formFields: [],
        blocks: [
          { text: "Applicant full name: ______", start: 0, end: 28 },
          { text: "Email address: ______", start: 30, end: 52 },
          { text: "Phone number: ______", start: 54, end: 76 },
          { text: "Full legal name: ______", start: 78, end: 102 },
          { text: "Do you have pets? Yes / No", start: 104, end: 132 },
          { text: "Move-in month: January / February / March", start: 134, end: 178 },
        ],
      }],
      issues: [],
    });

    expect(mapping.questions.filter((question) => question.standardKey).length).toBe(3);
    expect(mapping.questions.find((question) => question.standardKey)?.label).toBe("Applicant full name");
    expect(mapping.questions.find((question) => question.label === "Do you have pets")?.type).toBe("yes_no");
    expect(mapping.questions.find((question) => question.label === "Move-in month")?.options).toEqual(["January", "February", "March"]);
  });

  it("keeps a nonidentity canonical prompt as one source-ordered custom question", () => {
    const mapping = mapApplicationPdfImport({
      fileName: "application.pdf", sourceSha256: "b".repeat(64), coverage: { extractedCharacters: 20, representedCharacters: 20, complete: true }, issues: [],
      pages: [{ pageNumber: 1, issues: [], formFields: [], blocks: [{ text: "Date of birth: ____", start: 0, end: 20 }] }],
    });
    const draft = applicationImportMappingToDraft(mapping);
    expect(mapping.questions[0]?.standardKey).toBeUndefined();
    expect(draft.customApplicationFields[0]?.label).toBe("Date of birth");
    expect(draft.customApplicationFields[0]?.section).toBe("additional");
    expect(draft.disabledStandardApplicationKeys).toHaveLength(1);
    expect(draft.questionDisplayOrder).toEqual([mapping.questions[0]?.id]);
  });

  it("keeps placement and consent answers on typed applicant fields", () => {
    const labels = ["Property: ____", "Room choices: ____", "Lease term: ____", "Lease start date: ____", "Lease end date: ____", "Number of occupants: ____", "Credit & background check consent: ____"];
    const mapping = mapApplicationPdfImport({
      fileName: "application.pdf", sourceSha256: "d".repeat(64), coverage: { extractedCharacters: 120, representedCharacters: 120, complete: true }, issues: [],
      pages: [{ pageNumber: 1, issues: [], formFields: [], blocks: labels.map((label, start) => ({ text: label, start, end: start + label.length })) }],
    });
    const draft = applicationImportMappingToDraft(mapping);
    expect(draft.disabledStandardApplicationKeys).toEqual([]);
    expect(mapping.questions.every((question) => Boolean(question.standardKey))).toBe(true);
    expect(mapping.questions.map((question) => question.standardKey)).toHaveLength(6);
    expect(mapping.issues.filter((issue) => issue.code === "structural_field_order_fixed")).toHaveLength(labels.length);
  });

  it("imports fillable PDF choices once when page text repeats the label", () => {
    const mapping = mapApplicationPdfImport({
      fileName: "fillable.pdf", sourceSha256: "c".repeat(64), coverage: { extractedCharacters: 10, representedCharacters: 10, complete: true }, issues: [],
      pages: [{
        pageNumber: 1, issues: [], blocks: [{ text: "Parking preference: ____", start: 0, end: 22 }],
        formFields: [{ name: "Parking preference", value: "", options: ["Street", "Garage"], required: true }],
      }],
    });
    expect(mapping.questions).toHaveLength(1);
    expect(mapping.questions[0]?.options).toEqual(["Street", "Garage"]);
  });

  it("creates an unpublished editable draft", () => {
    const draft = applicationImportMappingToDraft({ questions: [], issues: [] });
    const template = {
      ...createPropertyApplicationTemplate({ kind: "long-term", label: "Imported application" }),
      draftQuestionConfig: applicationTemplateQuestionConfigFromSlice(draft),
    };
    expect(template.publishedQuestionConfig).toBeUndefined();
    const published = publishApplicationTemplateQuestionDraft(template);
    expect(published.publishedQuestionConfig?.version).toBe(1);
    expect(published.draftQuestionConfig).toEqual(published.publishedQuestionConfig);
  });

  it("blocks co-signer publication for each unsupported upload type with an accurate message", () => {
    for (const type of ["file", "photos"] as const) {
      const template = {
        ...createPropertyApplicationTemplate({ kind: "long-term", listingSeedKey: "cosigner", formVariant: "cosigner" }),
        draftQuestionConfig: applicationTemplateQuestionConfigFromSlice({
          disabledStandardApplicationKeys: [],
          customApplicationFields: [
            { id: type, key: type, label: "Upload document", type, required: true, options: [] },
          ],
          applicationConfigMode: "custom",
        }),
      };
      expect(() => publishApplicationTemplateQuestionDraft(template)).toThrow(/file and photo uploads are unavailable/);
      expect(() => publishApplicationTemplateQuestionDraft(template)).toThrow(/upload questions/);
    }
  });

  it("retains a source upload prompt as a typed question for explicit co-signer review", () => {
    const mapping = mapApplicationPdfImport({
      fileName: "cosigner.pdf", sourceSha256: "e".repeat(64), coverage: { extractedCharacters: 30, representedCharacters: 30, complete: true }, issues: [],
      pages: [{ pageNumber: 2, issues: [], formFields: [], blocks: [{ text: "Upload proof of income: ____", start: 10, end: 39 }] }],
    });
    expect(mapping.questions).toMatchObject([{ label: "Upload proof of income", type: "file", sourcePage: 2 }]);
    const template = {
      ...createPropertyApplicationTemplate({ kind: "long-term", listingSeedKey: "cosigner", formVariant: "cosigner" }),
      draftQuestionConfig: applicationTemplateQuestionConfigFromSlice(applicationImportMappingToDraft(mapping)),
    };
    expect(template.draftQuestionConfig.customApplicationFields[0]?.label).toBe("Upload proof of income");
    expect(() => publishApplicationTemplateQuestionDraft(template)).toThrow(/file and photo uploads are unavailable/);
  });

  it("allows every manager-editable non-upload question type to publish for co-signers", () => {
    const supported = CUSTOM_APPLICATION_FIELD_TYPE_OPTIONS.map(({ id }) => id).filter((id) => id !== "file" && id !== "photos");
    const template = {
      ...createPropertyApplicationTemplate({ kind: "long-term", listingSeedKey: "cosigner", formVariant: "cosigner" }),
      draftQuestionConfig: applicationTemplateQuestionConfigFromSlice({
        disabledStandardApplicationKeys: [],
        customApplicationFields: supported.map((type, index) => ({ id: `${type}-${index}`, key: `${type}-${index}`, label: type, type, required: false, options: [] })),
        applicationConfigMode: "custom",
      }),
    };
    expect(publishApplicationTemplateQuestionDraft(template).publishedQuestionConfig?.version).toBe(1);
  });

  it("keeps an in-progress application on its pinned published version", () => {
    const base = createPropertyApplicationTemplate({ kind: "long-term", label: "Imported application" });
    const v1 = publishApplicationTemplateQuestionDraft({
      ...base,
      draftQuestionConfig: {
        ...applicationTemplateQuestionConfigFromSlice({
          disabledStandardApplicationKeys: [], customApplicationFields: [{ id: "v1", key: "v1", label: "Version one", type: "text", required: true, options: [] }], applicationConfigMode: "custom",
        }),
        importProvenance: { unresolvedCount: 0 },
      },
    });
    const v2 = publishApplicationTemplateQuestionDraft({
      ...v1,
      draftQuestionConfig: {
        ...v1.draftQuestionConfig!,
        customApplicationFields: [{ id: "v2", key: "v2", label: "Version two", type: "text", required: true, options: [] }],
      },
    });
    const pinned = applicationConfigForApplicant({ propertyApplicationTemplates: [v2] }, "standard", v2.id, 1);
    expect(pinned.templateVersion).toBe(1);
    expect(pinned.config.customApplicationFields[0]?.key).toBe("v1");
    expect(applicationConfigForApplicant({ propertyApplicationTemplates: [v2] }, "standard", v2.id, 99).pinMissing).toBe(true);
  });

  it("blocks publishing until imported issues are explicitly resolved", () => {
    const template = {
      ...createPropertyApplicationTemplate({ kind: "long-term", label: "Needs review" }),
      draftQuestionConfig: {
        ...applicationTemplateQuestionConfigFromSlice({ disabledStandardApplicationKeys: [], customApplicationFields: [], applicationConfigMode: "custom" }),
        importProvenance: { unresolvedCount: 1 },
      },
    };
    expect(() => publishApplicationTemplateQuestionDraft(template)).toThrow(/Resolve every imported PDF issue/);
  });

  it("requires review of the exact imported draft that will be published", () => {
    const base = applicationTemplateQuestionConfigFromSlice({ disabledStandardApplicationKeys: [], customApplicationFields: [{ id: "q", key: "q", label: "Original question", type: "text", required: true, options: [] }], applicationConfigMode: "custom" });
    const reviewed = { ...base, importProvenance: { sourcePath: "owner/application-import/source.pdf", sourceSha256: "a".repeat(64), unresolvedCount: 0, reviewedByUserId: "manager", reviewedDraftFingerprint: applicationDraftReviewFingerprint(base) } };
    const template = { ...createPropertyApplicationTemplate({ kind: "long-term" }), draftQuestionConfig: reviewed };
    expect(publishApplicationTemplateQuestionDraft(template).publishedQuestionConfig?.version).toBe(1);
    expect(() => publishApplicationTemplateQuestionDraft({ ...template, draftQuestionConfig: { ...reviewed, customApplicationFields: [{ ...reviewed.customApplicationFields[0], label: "Changed after review" }] } })).toThrow(/Compare and confirm/);
  });

  it("uses the template display order when rendering custom applicant questions", () => {
    const fields = listingCustomApplicationFields({
      applicationConfigMode: "custom",
      questionDisplayOrder: ["second", "first"],
      customApplicationFields: [
        { id: "first", key: "first", label: "First", type: "text", required: false, options: [] },
        { id: "second", key: "second", label: "Second", type: "text", required: false, options: [] },
      ],
    });
    expect(fields.map((field) => field.id)).toEqual(["second", "first"]);
  });

  it("retains third-party contacts, punctuation-free questions, and required markers", () => {
    const labels = ["Emergency contact phone: ____", "Landlord email: ____", "Applicant phone: ____", "Applicant email: ____", "Explain how you will pay rent", "Parking required *", "Terms of household occupancy and other important notes that exceed a normal form label and need review ".repeat(4)];
    const mapping = mapApplicationPdfImport({ fileName: "contacts.pdf", sourceSha256: "d".repeat(64), coverage: { extractedCharacters: 0, representedCharacters: 0, complete: true }, issues: [], pages: [{ pageNumber: 1, issues: [], formFields: [], blocks: labels.map((text, start) => ({ text, start, end: start + text.length })) }] });
    expect(mapping.questions.find((question) => question.label.startsWith("Emergency"))?.standardKey).toBeUndefined();
    expect(mapping.questions.find((question) => question.label.startsWith("Landlord"))?.standardKey).toBeUndefined();
    expect(mapping.questions.find((question) => question.label.startsWith("Applicant phone"))?.standardKey).toBeDefined();
    expect(mapping.questions.find((question) => question.label.startsWith("Applicant email"))?.standardKey).toBeDefined();
    expect(mapping.questions.find((question) => question.label === "Explain how you will pay rent")?.type).toBe("text");
    expect(mapping.questions.find((question) => question.label === "Parking required *")?.required).toBe(true);
    expect(mapping.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "source_block_unmapped" })]));
  });

  it("keeps qualified third-party identity prompts separate from applicant identity", () => {
    const labels = [
      "Full legal name of emergency contact: ____",
      "Phone (emergency contact): ____",
      "Email (current landlord): ____",
      "Applicant's full legal name: ____",
      "Phone number of applicant: ____",
      "Email address for applicant: ____",
    ];
    const mapping = mapApplicationPdfImport({
      fileName: "qualified-contacts.pdf",
      sourceSha256: "e".repeat(64),
      coverage: { extractedCharacters: 0, representedCharacters: 0, complete: true },
      issues: [],
      pages: [{
        pageNumber: 1,
        issues: [],
        formFields: [],
        blocks: labels.map((text, index) => ({ text, start: index * 50, end: index * 50 + text.length })),
      }],
    });
    const thirdParty = mapping.questions.slice(0, 3);
    expect(thirdParty.map((question) => question.label)).toEqual(labels.slice(0, 3).map((label) => label.replace(/:.*$/, "")));
    expect(thirdParty.every((question) => !question.standardKey && !question.replacesStandardKey)).toBe(true);
    expect(thirdParty.map((question) => [question.sourcePage, question.sourceStart, question.sourceEnd])).toEqual([
      [1, 0, labels[0]!.length],
      [1, 50, 50 + labels[1]!.length],
      [1, 100, 100 + labels[2]!.length],
    ]);
    expect(mapping.questions.slice(3).map((question) => question.standardKey)).toEqual(REQUIRED_IDENTITY_STANDARD_KEYS);
    expect(mapping.issues.filter((issue) => issue.code === "third_party_identity_requires_review")).toHaveLength(3);
    expect(applicationImportMappingToDraft(mapping).disabledStandardApplicationKeys).toEqual([]);
  });
});

describe("applicant identity policy", () => {
  it("cannot disable legal name, phone, or email through a saved config", () => {
    const config = applicationConfigForVariant({ disabledStandardApplicationKeys: [...REQUIRED_IDENTITY_STANDARD_KEYS] }, "standard");
    expect(config.disabledStandardApplicationKeys).toEqual([]);

    const name = resolveListingApplicationFields(config, normalizeCustomApplicationFields).find((field) => field.label === "Full legal name")!;
    const removed = removeListingApplicationField(config, name);
    expect(removed.disabledStandardApplicationKeys).toEqual([]);
  });

  it("rejects optional identity overrides and still requires identities in a forged published snapshot", () => {
    const forged = {
      disabledStandardApplicationKeys: [...REQUIRED_IDENTITY_STANDARD_KEYS],
      customApplicationFields: REQUIRED_IDENTITY_STANDARD_KEYS.map((standardKey) => ({ id: standardKey, key: standardKey, standardKey, label: standardKey, type: "text" as const, required: false, options: [], section: "personal" as const })),
      applicationConfigMode: "custom" as const,
    };
    const template = { ...createPropertyApplicationTemplate({ kind: "long-term" }), draftQuestionConfig: applicationTemplateQuestionConfigFromSlice(forged) };
    expect(() => publishApplicationTemplateQuestionDraft(template)).toThrow(/required/);
    const resolved = resolveListingApplicationFields(forged, normalizeCustomApplicationFields);
    expect(REQUIRED_IDENTITY_STANDARD_KEYS.every((key) => resolved.find((field) => field.standardKey === key)?.required)).toBe(true);
    expect(["fullLegalName", "phone", "email"].every((key) => isWizardFormFieldRequired(forged, key))).toBe(true);
  });
});
