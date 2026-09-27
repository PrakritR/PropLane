// @vitest-environment node
//
// Regression fixture: the real extracted text of
// "Ida Cares Homes_Intake Form.pdf" (proplane-mock-kit/studio/assets/ida-cares),
// captured verbatim as the four pages' text lines (one PDF.js text-content
// line per block, exactly as `pdf-source.server.ts` emits them). The
// importer previously reduced this real 4-page, ~40-prompt intake form down
// to the standard catalog's default 9 sections with zero flagged issues —
// every custom prompt was either merged into a garbled multi-field row,
// dropped as a false "duplicate", or silently swallowed as an unused
// section-heading/group-label prefix. This pins the fixed behavior: every
// non-identity prompt survives as its own source-ordered question (or is
// reported as an import issue, never silently gone), a Yes/No + "if
// yes/no, explain" pair becomes a showIf conditional, and the office-use
// block never becomes applicant-facing content.
import { describe, expect, it } from "vitest";
import { mapApplicationPdfImport } from "@/lib/rental-application/application-pdf-import";
import type { PdfImportSource } from "@/lib/pdf-import/pdf-source.server";

function page(pageNumber: number, lines: string[]): PdfImportSource["pages"][number] {
  let offset = 0;
  const blocks = lines.map((line) => {
    const text = `${line}\n`;
    const block = { text, start: offset, end: offset + text.length };
    offset += text.length;
    return block;
  });
  return { pageNumber, text: lines.join("\n"), blocks, formFields: [], issues: [] };
}

const SOURCE: PdfImportSource = {
  sourceSha256: "f".repeat(64),
  fileName: "Ida Cares Homes_Intake Form.pdf",
  coverage: { extractedCharacters: 0, representedCharacters: 0, complete: true },
  issues: [],
  pages: [
    page(1, [
      "Home: Room #:",
      "Move-In Date: Rent Amount $",
      "End of Probation Date: Security Deposit $",
      "First Name: Middle Name:",
      "Last Name: Nickname:",
      "Preferred Pronoun: Gender Identity:",
      "Phone Number: Email:",
      "Date Of Birth: ____/________/_________ SSN/ITIN #: _____ -_______-_______",
      "ID/CDL#: Military ID #:",
      "Marital Status: Spouse's Name:",
      "Phone Number: Email:",
      "Monthly Income 1 ($): Source 1:",
      "Monthly Income 2 ($): Source 2:",
      "Other Monthly Income ($): Available Savings ($):",
      "Phone Number: Email:",
      "Expenses: Cell Phone Car Loans Other",
      "What is the total of your monthly expenses? $____________________",
      "Emergency Contact Information",
      "First Name: Last Name:",
      "Phone Number: Email Address:",
      "Relationship To You:",
      "First Name: Last Name:",
      "Phone Number: Email Address:",
      "Relationship To You:",
      "Medical Information",
      "Do you have Medical Insurance? Y / N",
      "Provider: Health Card #:",
      "Contact Number:",
      "Resident - General Information",
      "Secured Information",
      "Emergency Information",
      "Financial Information",
    ]),
    page(2, [
      "Do you have any allergies or dietary restrictions? Provide details below.",
      "List Medications:",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "List Food/ Beverages:",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "Other:",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "Do you have any chronic medical issues we should be concerned about? (Example:",
      "Diabetes, COPD, etc.) Please provide details below:",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "Do you have any special medical equipment?",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "Have you been exposed to someone with COVID-19? (Circle) Yes No",
      "IF YES, please explain:",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "Are you currently experiencing any of the symptoms listed below? (Circle)",
      "Fever Dry Cough Flu-like Symptoms",
    ]),
    page(3, [
      "Can you walk independently?(Circle) Yes No Sometimes",
      "If No or Sometimes Explain:_________________________________________________",
      "________________________________________________________________________",
      "Can you participate in household cleaning and chores?(Circle) Yes No",
      "If No or Sometimes Explain:_________________________________________________",
      "________________________________________________________________________",
      "Can you bath and dress yourself? (Circle) Yes No",
      "If No or Sometimes Explain:__________________________________________________",
      "________________________________________________________________________",
      "Do you bath every day? (Circle) Yes No",
      "If No or Sometimes Explain:__________________________________________________",
      "________________________________________________________________________",
      "Do you have any issues with bladder control?(Circle) Yes No Sometimes",
      "If No or Sometimes Explain:__________________________________________________",
      "_________________________________________________________________________",
      "Are you on Probation or Parole? Yes No Sometimes",
      "If Yes, provide information:",
      "Probation/Parole Officer Name: __________________________ End Date: __/____/____",
      "Probation/Parole Contact #: (_____)_________-___________ CDC #: ________________",
      "Do you smoke? (Circle) Yes No",
      "IF YES, please explain:",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "Are you recovering from any addiction that we should be aware of? (Circle) Yes No",
      "IF YES, please explain:",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "What time do you normally go to bed? _________________ PM",
      "Do you have any regular medical appointments? Please explain.",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "List food items that you do not like:",
      "Meats: _______________________________________________________",
      "Vegetables: ___________________________________________________",
      "Other: _______________________________________________________",
      "List your favorite foods:",
      "Meats: _______________________________________________________",
      "Vegetables: ___________________________________________________",
      "Other: ________________________________________________________",
      "List Activities you enjoy doing:",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "Resident Suitability Questionnaire",
    ]),
    page(4, [
      "Resident Suitability Questionnaire Continued",
      "List concerns you may have living with a roommate?",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "Do you work or volunteer anywhere?",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "List ANYTHING else we should be concerned about.",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "__________________________________________________________________________",
      "The information I have provided above is true and accurate to the best",
      "of my knowledge. I understand that if I have not provided true and",
      "accurate information that it will be grounds for eviction.",
      "Signature: _____________________________________ Date: _________________",
      "OFFICE USE ONLY: Circle Yes if applicable",
      "Temperature Check (enter temperature taken) _________ F",
      "Copy of ID/CDL Yes",
      "Copy of Proof of Military Service** Yes",
      "Proof of Income – Confirmation Yes",
      "Move-In Fee Received Yes",
      "Deposit Received Yes",
      "Initial Rent (Prorated) Received Yes",
      "COVID-19 Disclaimer Signed Yes",
      "License Agreement Signed Yes",
      "Pool Waiver Signed Yes",
      "Resident Suitability Questionnaire (Continued)",
    ]),
  ],
};

describe("mapApplicationPdfImport against the real Ida Cares intake form", () => {
  const mapping = mapApplicationPdfImport(SOURCE);

  it("FAILS BEFORE THE FIX: recovers far more than the standard catalog's default question count", () => {
    // Before the rewrite, this same source reduced to the untouched default
    // template (9 standard sections, "Additional details: 7") with zero
    // flagged issues — every one of this document's ~40 real prompts was
    // lost. The fixed importer recovers the overwhelming majority of them.
    expect(mapping.questions.length).toBeGreaterThan(85);
    expect(mapping.issues.length).toBeGreaterThan(15);
  });

  it("never lets the office-use block become an applicant-facing question", () => {
    const officeWords = ["Temperature Check", "Copy of ID/CDL", "Move-In Fee Received", "Deposit Received", "Pool Waiver"];
    for (const word of officeWords) {
      expect(mapping.questions.some((q) => q.label.includes(word))).toBe(false);
    }
    expect(mapping.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "office_use_only_manager_field" }),
    ]));
  });

  it("links a Yes/No gate to its own conditional follow-up via showIf, not as an unlinked duplicate", () => {
    const covidGate = mapping.questions.find((q) => q.label === "Have you been exposed to someone with COVID-19");
    expect(covidGate?.type).toBe("yes_no");
    const covidExplain = mapping.questions.find((q) => q.label === "Have you been exposed to someone with COVID-19 — explain");
    expect(covidExplain?.showIf).toEqual({ fieldKey: covidGate!.key, equals: "yes" });

    const smokeGate = mapping.questions.find((q) => q.label === "Do you smoke");
    const smokeExplain = mapping.questions.find((q) => q.label === "Do you smoke — explain");
    expect(smokeExplain?.showIf).toEqual({ fieldKey: smokeGate!.key, equals: "yes" });

    const walkGate = mapping.questions.find((q) => q.label === "Can you walk independently");
    expect(walkGate?.type).toBe("select");
    expect(walkGate?.options).toEqual(["Yes", "No", "Sometimes"]);
    const walkExplain = mapping.questions.find((q) => q.label === "Can you walk independently — explain");
    expect(walkExplain?.showIf).toEqual({ fieldKey: walkGate!.key, equals: "no" });
    // A single showIf can only trigger on one exact answer — flagged rather
    // than silently guessed for the three-state Yes/No/Sometimes gates.
    expect(mapping.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "conditional_covers_one_answer_only" }),
    ]));
  });

  it("keeps the Probation/Parole 'if yes, provide information' sub-fields conditional on that gate", () => {
    const gate = mapping.questions.find((q) => q.label === "Are you on Probation or Parole");
    expect(gate?.options).toEqual(["Yes", "No", "Sometimes"]);
    for (const label of ["Probation/Parole Officer Name", "End Date", "Probation/Parole Contact #", "CDC #"]) {
      const row = mapping.questions.find((q) => q.label === label);
      expect(row?.showIf).toEqual({ fieldKey: gate!.key, equals: "yes" });
    }
  });

  it("never silently drops a repeated prompt — two emergency contacts each keep their own name/phone/email", () => {
    expect(mapping.questions.filter((q) => q.label.startsWith("First Name"))).toHaveLength(3);
    expect(mapping.questions.filter((q) => q.label.startsWith("Last Name"))).toHaveLength(3);
    expect(mapping.questions.filter((q) => q.label.startsWith("Phone Number"))).toHaveLength(5);
    expect(mapping.questions.filter((q) => /^Email(?:\s\(\d+\))?$/.test(q.label))).toHaveLength(3);
    expect(mapping.questions.filter((q) => q.label.startsWith("Email Address"))).toHaveLength(2);
    expect(mapping.issues.filter((i) => i.code === "third_party_identity_requires_review").length).toBeGreaterThanOrEqual(6);
  });

  it("recovers a bare group label's real sub-fields (Meats/Vegetables/Other under two different lists)", () => {
    expect(mapping.questions.some((q) => q.label === "List food items that you do not like — Meats")).toBe(true);
    expect(mapping.questions.some((q) => q.label === "List food items that you do not like — Vegetables")).toBe(true);
    expect(mapping.questions.some((q) => q.label === "List your favorite foods — Meats")).toBe(true);
  });

  it("keeps a standalone colon-terminated prompt as its own question instead of an unused prefix", () => {
    // "List Medications:" and "List Food/ Beverages:" are each followed by
    // three blank-fill lines (their own free-answer space), not a genuine
    // short sub-field cluster — unlike "List food items..." above.
    expect(mapping.questions.some((q) => q.label === "List Medications")).toBe(true);
    expect(mapping.questions.some((q) => q.label === "List Food/ Beverages")).toBe(true);
    expect(mapping.questions.some((q) => q.label === "List Activities you enjoy doing")).toBe(true);
  });

  it("splits a merged applicant-identity line into its own labeled rows on the applicant's standard fields", () => {
    const phone = mapping.questions.find((q) => q.standardKey === "personal-phone");
    const email = mapping.questions.find((q) => q.standardKey === "personal-email");
    expect(phone?.label).toBe("Phone Number");
    expect(email?.label).toBe("Email");
  });
});
