import { describe, expect, it } from "vitest";
import {
  answerForQuestion,
  evaluateLinkedFormRules,
  isLinkedFormOpen,
  linkedFormFacts,
  managerStatusLabel,
  moreFormsHeading,
  owedNeededBeforeReview,
  waitingOnFormsFact,
} from "@/lib/application-linked-form-requests";
import { COSIGNER_QUESTION_STANDARD_KEY } from "@/lib/application-linked-forms";
import { isLinkedFormSharePath, linkedFormOpenPath, linkedFormSharePath } from "@/lib/linked-form-path";

const petQuestion = {
  key: "has_pets",
  label: "Do you have pets?",
  linkedForms: [
    { id: "r-pet", whenEquals: "yes", formRef: { kind: "move_in" as const, id: "mif-pet" }, neededBeforeReview: false },
  ],
};

describe("evaluating linked-form rules on submit", () => {
  it("matches a custom question's rule against its stored answer", () => {
    const matches = evaluateLinkedFormRules({
      questions: [petQuestion],
      application: { customFieldAnswers: [{ key: "has_pets", label: "Do you have pets?", type: "select", section: "additional", value: "Yes" }] },
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      questionLabel: "Do you have pets?",
      answerLabel: "Yes",
      rule: { formRef: { kind: "move_in", id: "mif-pet" } },
    });
  });

  it("owes nothing when the answer does not match", () => {
    expect(
      evaluateLinkedFormRules({
        questions: [petQuestion],
        application: { customFieldAnswers: [{ key: "has_pets", label: "x", type: "select", section: "additional", value: "No" }] },
      }),
    ).toEqual([]);
    expect(evaluateLinkedFormRules({ questions: [petQuestion], application: {} })).toEqual([]);
  });

  it("reads a built-in question's answer from its wizard field", () => {
    expect(
      answerForQuestion({ key: COSIGNER_QUESTION_STANDARD_KEY, standardKey: COSIGNER_QUESTION_STANDARD_KEY }, { hasCosigner: "yes" }),
    ).toBe("yes");
  });

  it("keeps today's co-signer behaviour: the template's co-signer link is a rule on Co-signer planned", () => {
    const questions = [{ key: COSIGNER_QUESTION_STANDARD_KEY, label: "Co-signer planned", standardKey: COSIGNER_QUESTION_STANDARD_KEY }];
    const yes = evaluateLinkedFormRules({ questions, application: { hasCosigner: "yes" }, linkedCosignerApplicationTemplateId: "cos-1" });
    expect(yes).toHaveLength(1);
    expect(yes[0]!.rule).toMatchObject({ formRef: { kind: "application", id: "cos-1" }, neededBeforeReview: true });
    expect(yes[0]!.answerLabel).toBe("Yes");
    expect(
      evaluateLinkedFormRules({ questions, application: { hasCosigner: "no" }, linkedCosignerApplicationTemplateId: "cos-1" }),
    ).toEqual([]);
  });

  it("is one request per form: two questions pointing at one form dedupe, and either can make it needed", () => {
    const first = { ...petQuestion, key: "a", label: "A", linkedForms: [{ id: "r1", whenEquals: "yes", formRef: { kind: "application" as const, id: "app-1" }, neededBeforeReview: false }] };
    const second = { ...petQuestion, key: "b", label: "B", linkedForms: [{ id: "r2", whenEquals: "yes", formRef: { kind: "application" as const, id: "app-1" }, neededBeforeReview: true }] };
    const matches = evaluateLinkedFormRules({
      questions: [first, second],
      application: {
        customFieldAnswers: [
          { key: "a", label: "A", type: "select", section: "additional", value: "Yes" },
          { key: "b", label: "B", type: "select", section: "additional", value: "Yes" },
        ],
      },
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.questionLabel).toBe("A");
    expect(matches[0]!.rule.neededBeforeReview).toBe(true);
  });
});

describe("what each surface says", () => {
  const owed = { status: "owed" as const, neededBeforeReview: true };

  it("states the waiting fact only for needed-before-review forms still owed", () => {
    expect(waitingOnFormsFact([owed])).toBe("Waiting on 1 form");
    expect(waitingOnFormsFact([owed, { status: "shared", neededBeforeReview: true }])).toBe("Waiting on 2 forms");
    expect(waitingOnFormsFact([{ status: "owed", neededBeforeReview: false }])).toBeNull();
    expect(waitingOnFormsFact([{ status: "done", neededBeforeReview: true }, { status: "not_needed", neededBeforeReview: true }])).toBeNull();
    expect(owedNeededBeforeReview([owed, { status: "done", neededBeforeReview: true }])).toHaveLength(1);
  });

  it("labels the manager's row", () => {
    expect(managerStatusLabel({ status: "owed", completedAt: null })).toBe("Waiting on applicant");
    expect(managerStatusLabel({ status: "shared", completedAt: null })).toContain("Link shared");
    expect(managerStatusLabel({ status: "done", completedAt: "2026-10-04T20:00:00Z" })).toBe("Completed Oct 4");
    expect(managerStatusLabel({ status: "not_needed", completedAt: null })).toBe("Not needed");
  });

  it("heads the applicant list and lists facts", () => {
    expect(moreFormsHeading(1)).toBe("1 more form to finish");
    expect(moreFormsHeading(3)).toBe("3 more forms to finish");
    expect(linkedFormFacts({ questionCount: 12, feeCents: 4500 })).toEqual(["12 questions", "$45 fee"]);
    expect(linkedFormFacts({ questionCount: null, feeCents: null })).toEqual(["No fee"]);
    expect(isLinkedFormOpen("shared")).toBe(true);
    expect(isLinkedFormOpen("done")).toBe(false);
  });
});

describe("share and open paths", () => {
  it("builds the token as a path segment, never a query", () => {
    const token = "A".repeat(43);
    expect(linkedFormSharePath(token)).toBe(`/f/${token}`);
    expect(linkedFormSharePath(token)).not.toContain("?");
    expect(linkedFormOpenPath("abc")).toBe("/f/open/abc");
  });

  it("lets a post-sign-in redirect return only to those two shapes", () => {
    expect(isLinkedFormSharePath(`/f/${"A".repeat(43)}`)).toBe(true);
    expect(isLinkedFormSharePath("/f/open/6f1c2a3b-0000-4000-8000-000000000001")).toBe(true);
    expect(isLinkedFormSharePath("/f/short")).toBe(false);
    expect(isLinkedFormSharePath("//f/" + "A".repeat(43))).toBe(false);
    expect(isLinkedFormSharePath("/f/open/../../admin")).toBe(false);
    expect(isLinkedFormSharePath("https://evil.example/f/" + "A".repeat(43))).toBe(false);
  });
});
