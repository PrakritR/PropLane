import { describe, expect, it } from "vitest";
import {
  buildLeaseFirstSigningHtml,
  leaseFirstAnswersBySection,
  leaseFirstInitialsProgress,
  resolveManagerFilledSigningAnswers,
  PROPLANE_TERMS_RIDER_TITLE,
} from "@/lib/leasing/lease-first-signing-document";
import type { ApplicationTemplateQuestionConfig } from "@/lib/property-application-templates";
import type { ManagerCustomApplicationField } from "@/lib/manager-listing-submission";

const FIELDS: ManagerCustomApplicationField[] = [
  { id: "f1", key: "la_ack_1", label: "I understand this is not a lease.", type: "initials", required: true, options: [], section: "Acknowledgements" },
  { id: "f2", key: "la_ack_2", label: "I understand utilities are included.", type: "initials", required: true, options: [], section: "Acknowledgements" },
  { id: "f3", key: "la_fee_monthly", label: "Monthly license fee", type: "currency", required: true, options: [], section: "I. Fees", filledBy: "manager" },
  { id: "f4", key: "la_fee_daily", label: "Daily license fee", type: "currency", required: true, options: [], section: "I. Fees", filledBy: "manager" },
  { id: "f5", key: "la_sig_licensee", label: "Licensee signature", type: "text", required: true, options: [], section: "VII. Agreement authorization" },
];

function config(): ApplicationTemplateQuestionConfig {
  return {
    disabledStandardApplicationKeys: [],
    customApplicationFields: FIELDS,
    applicationConfigMode: "custom",
    version: 1,
    questionDisplayOrder: FIELDS.map((f) => f.id),
  };
}

describe("resolveManagerFilledSigningAnswers", () => {
  it("fills monthly and daily fee questions from the room's rent, by key/label pattern match", () => {
    const answers = resolveManagerFilledSigningAnswers(config(), { monthlyRent: 900, dailyRent: 40, moveInFeeLabel: null });
    expect(answers.la_fee_monthly).toBe("$900");
    expect(answers.la_fee_daily).toBe("$40");
  });

  it("never fills a resident-owned question, even if it happens to be currency-typed", () => {
    const withResidentCurrency: ApplicationTemplateQuestionConfig = {
      ...config(),
      customApplicationFields: [
        ...FIELDS,
        { id: "f6", key: "other_monthly", label: "Other monthly amount", type: "currency", required: false, options: [], filledBy: "resident" },
      ],
    };
    const answers = resolveManagerFilledSigningAnswers(withResidentCurrency, { monthlyRent: 900, dailyRent: 40, moveInFeeLabel: null });
    expect(answers.other_monthly).toBeUndefined();
  });

  it("leaves a manager-owned fee unresolved (no guess) when no rent is known", () => {
    const answers = resolveManagerFilledSigningAnswers(config(), { monthlyRent: null, dailyRent: null, moveInFeeLabel: null });
    expect(answers.la_fee_monthly).toBeUndefined();
  });
});

describe("buildLeaseFirstSigningHtml", () => {
  it("renders every clause grouped by section, in source order, with manager fees inline as text", () => {
    const html = buildLeaseFirstSigningHtml(config(), {
      propertyLabel: "Ida Cares — Maple House",
      fees: { monthlyRent: 900, dailyRent: 40, moveInFeeLabel: "$500 fixed." },
    });
    expect(html).toContain("Ida Cares — Maple House");
    expect(html).toContain("I understand this is not a lease.");
    expect(html).toContain("$900");
    expect(html).toContain("$40");
  });

  it("always appends a visibly separate PropLane Terms Rider, never merged into a source clause", () => {
    const html = buildLeaseFirstSigningHtml(config(), {
      propertyLabel: "Ida Cares — Maple House",
      fees: { monthlyRent: 900, dailyRent: 40, moveInFeeLabel: null },
    });
    expect(html).toContain(`<h2>${PROPLANE_TERMS_RIDER_TITLE}</h2>`);
  });

  it("escapes clause text so a manager-authored label cannot inject markup into the signed document", () => {
    const malicious: ApplicationTemplateQuestionConfig = {
      ...config(),
      customApplicationFields: [
        { id: "x1", key: "x1", label: "<script>alert(1)</script>", type: "initials", required: true, options: [], section: "Acknowledgements" },
      ],
    };
    const html = buildLeaseFirstSigningHtml(malicious, { propertyLabel: "Test", fees: {} });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("leaseFirstInitialsProgress", () => {
  it("counts only initials-type questions, answered vs total", () => {
    const progress = leaseFirstInitialsProgress(config(), { la_ack_1: "JR" });
    expect(progress).toEqual({ answered: 1, total: 2 });
  });

  it("returns null when there is no template config (an ordinary, non-imported lease)", () => {
    expect(leaseFirstInitialsProgress(null, {})).toBeNull();
  });

  it("returns null when the config has no initials questions at all", () => {
    const noInitials: ApplicationTemplateQuestionConfig = {
      ...config(),
      customApplicationFields: FIELDS.filter((f) => f.type !== "initials"),
    };
    expect(leaseFirstInitialsProgress(noInitials, {})).toBeNull();
  });

  it("ignores a blank/whitespace-only stored answer as unanswered", () => {
    const progress = leaseFirstInitialsProgress(config(), { la_ack_1: "  " });
    expect(progress).toEqual({ answered: 0, total: 2 });
  });
});

describe("leaseFirstAnswersBySection", () => {
  it("groups every clause's answer by section, in source order (C281)", () => {
    const sections = leaseFirstAnswersBySection(config(), {
      la_ack_1: "JR",
      la_fee_monthly: "$900",
    });
    expect(sections.map((s) => s.section)).toEqual(["Acknowledgements", "I. Fees", "VII. Agreement authorization"]);
    const acknowledgements = sections[0]!;
    expect(acknowledgements.facts).toEqual([
      { key: "la_ack_1", label: "I understand this is not a lease.", value: "JR" },
      { key: "la_ack_2", label: "I understand utilities are included.", value: "Not yet initialed" },
    ]);
  });

  it("reads an unanswered non-initials field as an em dash, never a guess", () => {
    const sections = leaseFirstAnswersBySection(config(), {});
    const fees = sections.find((s) => s.section === "I. Fees")!;
    expect(fees.facts.every((f) => f.value === "—")).toBe(true);
  });

  it("never invents a value the resident did not actually answer", () => {
    const sections = leaseFirstAnswersBySection(config(), { la_ack_1: "  " });
    const ack1 = sections[0]!.facts.find((f) => f.key === "la_ack_1")!;
    expect(ack1.value).toBe("Not yet initialed");
  });
});
