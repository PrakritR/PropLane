// @vitest-environment jsdom
//
// C2-R30-6 — "Applicant sees" is the real apply wizard. The editor lists the questions of the same
// intake form the wizard draws from, step for step, and its preview uses the wizard's own control
// (CustomQuestionField): a star on required labels, a conditional question hidden until its parent
// is answered, and it follows the draft as it changes. Proven for a Seattle Homes style form
// (hand-authored questions in every section) and an Ida Cares style form (questions imported from
// the real Intake Form's text and fillable fields), through the same resolvers both sides call.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApplicationSectionPreviewPane } from "@/components/portal/application-form-builder";
import { createDefaultListingSubmission, normalizeCustomApplicationFields, type ManagerCustomApplicationField } from "@/lib/manager-listing-submission";
import { resolveListingApplicationFields, type ResolvedApplicationField } from "@/lib/rental-application/application-field-catalog";
import { applicationImportMappingToDraft, mapApplicationPdfImport } from "@/lib/rental-application/application-pdf-import";
import { RENTAL_APPLICATION_SECTIONS } from "@/lib/rental-application/application-sections";
import { customFieldsForWizardStep, isCustomFieldHiddenByCondition, listingCustomApplicationFields } from "@/lib/rental-application/custom-fields";
import type { PdfImportSource } from "@/lib/pdf-import/pdf-source.server";

afterEach(cleanup);

function custom(over: Partial<ManagerCustomApplicationField> & Pick<ManagerCustomApplicationField, "id" | "key" | "label">): ManagerCustomApplicationField {
  return { type: "text", required: false, options: [], section: "additional", ...over } as ManagerCustomApplicationField;
}

function seattleHomes() {
  const sub = createDefaultListingSubmission();
  sub.applicationConfigMode = "custom";
  sub.customApplicationFields = normalizeCustomApplicationFields([
    custom({ id: "s1", key: "move_window", label: "Move-in window", section: "property", required: true }),
    custom({ id: "s2", key: "has_pets", label: "Do you have a service animal?", type: "yes_no", section: "household", required: true }),
    custom({ id: "s3", key: "pet_details", label: "Describe the service animal", section: "household", showIf: { fieldKey: "has_pets", equals: "yes" } }),
    custom({ id: "s4", key: "employer_note", label: "Anything about your employment?", section: "employment" }),
    custom({ id: "s5", key: "referral", label: "How did you hear about us?", type: "select", options: ["Friend", "Online"], section: "additional" }),
  ]);
  return sub;
}

function page(pageNumber: number, lines: string[], formFields: PdfImportSource["pages"][number]["formFields"] = []): PdfImportSource["pages"][number] {
  let offset = 0;
  const blocks = lines.map((line) => {
    const text = `${line}\n`;
    const block = { text, start: offset, end: offset + text.length };
    offset += text.length;
    return block;
  });
  return { pageNumber, text: lines.join("\n"), blocks, formFields, issues: [] };
}

function idaCares() {
  const source: PdfImportSource = {
    sourceSha256: "f".repeat(64),
    fileName: "Ida Cares Homes_Intake Form.pdf",
    coverage: { extractedCharacters: 0, representedCharacters: 0, complete: true },
    issues: [],
    pages: [
      page(1, ["Emergency Contact Information", "Relationship To You:", "Medical Information", "Provider: Health Card #:"], [
        { name: "Preferred Pronoun", value: "", options: ["She/Her", "He/Him", "They/Them"], required: true },
        { name: "Move-In Date", value: "", options: [], required: false },
      ]),
      page(2, [
        "Have you been exposed to someone with COVID-19? (Circle) Yes No",
        "IF YES, please explain:",
        "__________________________________________________________________________",
        "Do you smoke? (Circle) Yes No",
        "IF YES, please explain:",
        "__________________________________________________________________________",
      ]),
    ],
  };
  const mapping = mapApplicationPdfImport(source);
  const sub = createDefaultListingSubmission();
  sub.applicationConfigMode = "custom";
  const draft = applicationImportMappingToDraft(mapping);
  sub.customApplicationFields = normalizeCustomApplicationFields(draft.customApplicationFields);
  sub.disabledStandardApplicationKeys = draft.disabledStandardApplicationKeys ?? [];
  return { sub, mapping };
}

const WORKSPACES = [
  ["Seattle Homes", () => ({ sub: seattleHomes() })],
  ["Ida Cares", () => idaCares()],
] as const;

describe.each(WORKSPACES)("%s: editor sections match the apply wizard step for step", (_name, build) => {
  const { sub } = build();
  const editorFields = resolveListingApplicationFields(sub, normalizeCustomApplicationFields);
  const wizardFields = listingCustomApplicationFields(sub);

  it("has questions to compare", () => {
    expect(editorFields.some((f) => !f.isStandard)).toBe(true);
    expect(wizardFields.length).toBeGreaterThan(0);
  });

  it("the editor's custom questions per section are exactly the wizard's, in the same order", () => {
    for (const section of RENTAL_APPLICATION_SECTIONS) {
      if (section.id === "review") continue;
      const wizardKeys = customFieldsForWizardStep(wizardFields, section.wizardStep)
        .filter((f) => (f.section ?? "additional") === section.id)
        .map((f) => f.key);
      const editorKeys = editorFields.filter((f) => !f.isStandard && (f.section ?? "additional") === section.id).map((f) => f.key);
      expect(editorKeys).toEqual(wizardKeys);
    }
  });

  it("every custom question the wizard asks is in the editor, and the editor adds none the wizard would not ask", () => {
    const editorCustom = editorFields.filter((f) => !f.isStandard).map((f) => f.key).sort();
    expect(editorCustom).toEqual(wizardFields.map((f) => f.key).sort());
  });

  it("the preview of each section shows what the wizard shows an applicant who has answered nothing: no required marker, no conditional child", () => {
    for (const section of RENTAL_APPLICATION_SECTIONS) {
      if (section.id === "review") continue;
      const fields = editorFields.filter((f) => (f.section ?? "additional") === section.id);
      const expectedVisible = fields.filter((f) => !isCustomFieldHiddenByCondition(f, []));
      const { container, unmount } = render(<ApplicationSectionPreviewPane sections={[section]} fields={fields} />);
      const pane = container.querySelector('[data-attr="application-preview-pane"]')!;
      const text = pane.textContent ?? "";
      for (const field of fields.filter((f) => !f.isStandard)) {
        const shown = expectedVisible.includes(field);
        expect(text.includes(field.label), `${field.label} in ${section.id}`).toBe(shown);
        // A required question carries no marker (product rule): no asterisk after its label.
        if (shown && field.required) expect(text).not.toMatch(new RegExp(`${field.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\*`));
      }
      unmount();
    }
  });
});

describe("the preview follows the draft and reveals a conditional question when its parent is answered", () => {
  const sub = seattleHomes();
  const household = RENTAL_APPLICATION_SECTIONS.find((s) => s.id === "household")!;
  const fieldsOf = (s: typeof sub): ResolvedApplicationField[] => resolveListingApplicationFields(s, normalizeCustomApplicationFields).filter((f) => (f.section ?? "additional") === "household");

  it("hides 'Describe the service animal' until the parent is answered Yes, then shows it", () => {
    render(<ApplicationSectionPreviewPane sections={[household]} fields={fieldsOf(sub)} />);
    expect(screen.queryByText("Describe the service animal")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Yes$/ }));
    expect(screen.getByText("Describe the service animal")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^No$/ }));
    expect(screen.queryByText("Describe the service animal")).toBeNull();
  });

  it("updates as the draft changes: a retyped label and a new required question show at once", () => {
    const { rerender } = render(<ApplicationSectionPreviewPane sections={[household]} fields={fieldsOf(sub)} />);
    const edited = createDefaultListingSubmission();
    edited.applicationConfigMode = "custom";
    edited.customApplicationFields = normalizeCustomApplicationFields([
      ...sub.customApplicationFields!.map((f) => (f.key === "has_pets" ? { ...f, label: "Do you have an assistance animal?" } : f)),
      custom({ id: "s9", key: "vet", label: "Vet name", section: "household", required: true }),
    ]);
    rerender(<ApplicationSectionPreviewPane sections={[household]} fields={fieldsOf(edited)} />);
    expect(screen.getByText(/Do you have an assistance animal\?/)).toBeTruthy();
    expect(screen.queryByText("Do you have a service animal?")).toBeNull();
    expect(screen.getByText("Vet name").parentElement!.textContent).not.toContain("*");
  });

  it("a half-typed blank label shows as Untitled question instead of an empty control", () => {
    const blank = fieldsOf(sub).map((f) => (f.key === "has_pets" ? { ...f, label: "  " } : f));
    render(<ApplicationSectionPreviewPane sections={[household]} fields={blank} />);
    expect(screen.getByText(/Untitled question/)).toBeTruthy();
  });
});

describe("Applicant sees pages through the whole form with the shared arrows", () => {
  const sub = seattleHomes();
  const all = resolveListingApplicationFields(sub, normalizeCustomApplicationFields);
  const sections = RENTAL_APPLICATION_SECTIONS.filter((s) => s.id !== "review");

  it("shows whole sections per step with the section title, names the form, and disables the arrows at the ends", () => {
    render(<ApplicationSectionPreviewPane sections={sections} fields={all} formName="Seattle application" />);
    const label = document.querySelector('[data-attr="application-preview-step-label"]')!.textContent ?? "";
    const match = label.match(/^Step 1 of (\d+) · Seattle application$/);
    expect(match, label).not.toBeNull();
    const total = Number(match![1]);
    expect(total).toBeGreaterThan(1);
    expect((screen.getByRole("button", { name: "Previous step" }) as HTMLButtonElement).disabled).toBe(true);
    // Every section shown on a step is whole: its title is a heading above its questions.
    expect(screen.getAllByRole("heading").length).toBeGreaterThan(0);
    for (let step = 1; step < total; step++) fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(document.querySelector('[data-attr="application-preview-step-label"]')!.textContent).toBe(`Step ${total} of ${total} · Seattle application`);
    expect((screen.getByRole("button", { name: "Next step" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps a section's questions together: no section is split across steps", () => {
    const { container } = render(<ApplicationSectionPreviewPane sections={sections} fields={all} formName="X" />);
    const seen = new Map<string, number>();
    const total = Number((container.querySelector('[data-attr="application-preview-step-label"]')!.textContent ?? "").match(/of (\d+)/)![1]);
    for (let step = 0; step < total; step++) {
      for (const h of container.querySelectorAll('[data-attr="application-preview-step"] h4')) seen.set(h.textContent ?? "", (seen.get(h.textContent ?? "") ?? 0) + 1);
      if (step < total - 1) fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    }
    for (const [title, count] of seen) expect(count, title).toBe(1);
  });
});

describe("Ida Cares: the uploaded form's detected fields are the imported intake questions", () => {
  const { mapping, sub } = idaCares();

  it("keeps a fillable field's label, choices and required flag", () => {
    const pronoun = mapping.questions.find((q) => q.label === "Preferred Pronoun");
    expect(pronoun).toBeTruthy();
    expect(pronoun!.options).toEqual(["She/Her", "He/Him", "They/Them"]);
    expect(pronoun!.required).toBe(true);
    expect(pronoun!.type).toBe("select");
  });

  it("turns each 'if yes, explain' follow-up into a conditional on its own parent", () => {
    const withCondition = mapping.questions.filter((q) => q.showIf);
    expect(withCondition.length).toBeGreaterThanOrEqual(2);
    for (const q of withCondition) {
      const parent = mapping.questions.find((p) => p.key === q.showIf!.fieldKey);
      expect(parent, `${q.label} parent`).toBeTruthy();
    }
  });

  it("the imported questions are what the editor lists and the wizard asks", () => {
    const resolved = resolveListingApplicationFields(sub, normalizeCustomApplicationFields);
    const editorKeys = resolved.filter((f) => !f.isStandard).map((f) => f.key).sort();
    // A detected field the PropLane form already asks (Move-In Date) overrides that built-in question
    // instead of being asked twice.
    expect(editorKeys).toEqual(mapping.questions.filter((q) => !q.standardKey).map((q) => q.key).sort());
    for (const overridden of mapping.questions.filter((q) => q.standardKey)) {
      expect(resolved.filter((f) => f.standardKey === overridden.standardKey)).toHaveLength(1);
    }
    expect(listingCustomApplicationFields(sub).map((f) => f.key).sort()).toEqual(editorKeys);
  });
});
