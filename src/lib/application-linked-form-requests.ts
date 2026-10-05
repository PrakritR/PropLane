/**
 * Linked forms owed after an application is submitted (pure, isomorphic).
 *
 * A question's `linkedForms` rules (`application-linked-forms.ts`) say "when the answer is X, include THAT
 * form". On submit the server evaluates the published template's rules against the applicant's answers and
 * writes one request per form. This module holds the evaluation, the status words and the small facts every
 * surface (finish screen, resident portal, manager record, approve confirm) reads the same way.
 *
 * Nothing here touches a secret: tokens and their hashes live in `application-linked-form-requests.server.ts`.
 */
import { withCosignerLinkRule, ruleMatches, type LinkedFormRef, type LinkedFormRule } from "@/lib/application-linked-forms";
import { applicationFieldCatalogDef, BUILT_IN_ANSWER_VALUES } from "@/lib/rental-application/application-field-catalog";
import type { RentalCustomFieldAnswer } from "@/lib/rental-application/types";

export type LinkedFormRequestStatus = "owed" | "shared" | "done" | "not_needed";

export const LINKED_FORM_REQUEST_STATUSES: readonly LinkedFormRequestStatus[] = ["owed", "shared", "done", "not_needed"];

/** A share link lives this long; the migration's `expires_at` default is the same 30 days. */
export const LINKED_FORM_LINK_TTL_DAYS = 30;

export { isLinkedFormSharePath, linkedFormOpenPath, linkedFormSharePath } from "@/lib/linked-form-path";

/** What the client may see of a request. Never the token or its hash. */
export type LinkedFormRequestView = {
  id: string;
  applicationId: string;
  ruleId: string;
  formKind: "application" | "move_in";
  formId: string;
  /** The form's name, resolved from the property when the list was built. */
  formLabel: string;
  questionCount: number | null;
  sourceQuestionLabel: string;
  /** The answer that triggered the rule, as the applicant gave it. */
  sourceAnswerLabel: string;
  neededBeforeReview: boolean;
  status: LinkedFormRequestStatus;
  feeCents: number | null;
  feePaid: boolean;
  completedAt: string | null;
  applicantName: string | null;
  /** "applicant": the signed-in person owes it; "helper": linked through a share link; "manager": reading it. */
  viewerRole: "applicant" | "helper" | "manager";
  expiresAt: string;
};

/** A request as the submit response hands it back: the one time its share token is shown. */
export type IssuedLinkedFormView = LinkedFormRequestView & { shareToken: string; sharePath: string };

export type MatchedLinkedFormRule = {
  rule: LinkedFormRule;
  questionLabel: string;
  answerLabel: string;
};

type QuestionWithRules = {
  key: string;
  label: string;
  standardKey?: string;
  /** The choices a pick question shows; a built-in's wording can differ from the value it stores. */
  options?: readonly string[];
  linkedForms?: LinkedFormRule[];
};

/**
 * The answers a rule may be written against. A built-in with fixed stored values ("yes" / "no") stores the value
 * but the manager's rule can name the choice as worded on the form ("Yes, my parent will"), so both are tried.
 */
function answerCandidates(question: Pick<QuestionWithRules, "standardKey" | "options">, answer: unknown): unknown[] {
  const values = question.standardKey ? BUILT_IN_ANSWER_VALUES[question.standardKey] : undefined;
  if (!values || typeof answer !== "string") return [answer];
  const index = values.indexOf(answer.trim().toLowerCase());
  const worded = index >= 0 ? question.options?.[index]?.trim() : "";
  return worded ? [answer, worded] : [answer];
}

/** The applicant's stored answer to one question: a built-in reads its wizard field, a custom one its answer row. */
export function answerForQuestion(
  question: Pick<QuestionWithRules, "key" | "standardKey">,
  application: { customFieldAnswers?: RentalCustomFieldAnswer[] } & Record<string, unknown>,
): unknown {
  if (question.standardKey) {
    const formKey = applicationFieldCatalogDef(question.standardKey)?.wizardFormKeys[0];
    if (!formKey) return undefined;
    return application[formKey];
  }
  const answers = Array.isArray(application.customFieldAnswers) ? application.customFieldAnswers : [];
  return answers.find((answer) => answer && answer.key === question.key)?.value;
}

/** A readable form of a stored answer, for "From “<question>” = <answer>". */
export function answerLabelFor(answer: unknown): string {
  if (Array.isArray(answer)) return answer.map((entry) => String(entry)).join(", ");
  if (answer === true) return "Yes";
  if (typeof answer === "string") {
    const text = answer.trim();
    if (text.toLowerCase() === "yes") return "Yes";
    if (text.toLowerCase() === "no") return "No";
    return text;
  }
  if (answer === null || answer === undefined) return "";
  return String(answer);
}

function formKey(ref: LinkedFormRef): string {
  return `${ref.kind}:${ref.id}`;
}

/**
 * Every rule the submitted answers trigger, one entry per FORM. Two questions that point at the same form
 * give one request (the first question names it; "needed before review" is true if either rule says so).
 * A co-signer link on the template reads as a rule on "Co-signer planned" (`withCosignerLinkRule`), so
 * today's co-signer behaviour is the same code path.
 */
export function evaluateLinkedFormRules(input: {
  questions: readonly QuestionWithRules[];
  application: { customFieldAnswers?: RentalCustomFieldAnswer[] } & Record<string, unknown>;
  linkedCosignerApplicationTemplateId?: string | null;
}): MatchedLinkedFormRule[] {
  const questions = withCosignerLinkRule(input.questions, input.linkedCosignerApplicationTemplateId);
  const byForm = new Map<string, MatchedLinkedFormRule>();
  for (const question of questions) {
    for (const rule of question.linkedForms ?? []) {
      const answer = answerForQuestion(question, input.application);
      if (!answerCandidates(question, answer).some((candidate) => ruleMatches(rule, candidate))) continue;
      const key = formKey(rule.formRef);
      const existing = byForm.get(key);
      if (existing) {
        if (rule.neededBeforeReview && !existing.rule.neededBeforeReview) {
          byForm.set(key, { ...existing, rule: { ...existing.rule, neededBeforeReview: true } });
        }
        continue;
      }
      byForm.set(key, { rule, questionLabel: question.label, answerLabel: answerLabelFor(answer) });
    }
  }
  return [...byForm.values()];
}

/** A request still owes the applicant work (not finished, not waived). */
export function isLinkedFormOpen(status: LinkedFormRequestStatus): boolean {
  return status === "owed" || status === "shared";
}

export function openLinkedFormCount(requests: readonly Pick<LinkedFormRequestView, "status">[]): number {
  return requests.filter((request) => isLinkedFormOpen(request.status)).length;
}

/** Forms the manager marked "needed before review" that are still owed. */
export function owedNeededBeforeReview<T extends Pick<LinkedFormRequestView, "status" | "neededBeforeReview">>(
  requests: readonly T[],
): T[] {
  return requests.filter((request) => request.neededBeforeReview && isLinkedFormOpen(request.status));
}

/** The plain fact on the application: "Waiting on 1 form". Null when nothing is owed. */
export function waitingOnFormsFact(requests: readonly Pick<LinkedFormRequestView, "status" | "neededBeforeReview">[]): string | null {
  const owed = owedNeededBeforeReview(requests).length;
  if (owed === 0) return null;
  return `Waiting on ${owed} form${owed === 1 ? "" : "s"}`;
}

/**
 * True when a share link for this request is already out there: one was minted (`shared`) and it
 * has not expired. Only the token's SHA-256 hash is stored, so that link can never be shown again -
 * which is exactly why nothing may replace it on an ordinary reveal or copy. The surfaces say
 * "Link shared" and offer an explicit new link instead.
 */
export function linkedFormHasActiveShareLink(
  request: Pick<LinkedFormRequestView, "status"> & { expiresAt?: string },
): boolean {
  if (request.status !== "shared") return false;
  const expires = Date.parse(request.expiresAt ?? "");
  return Number.isNaN(expires) || expires > Date.now();
}

/** The label on the action that replaces a link already shared: the old one stops working. */
export const LINKED_FORM_NEW_LINK_LABEL = "New link (old one stops working)";

/** The status the manager's row shows. */
export function managerStatusLabel(request: Pick<LinkedFormRequestView, "status" | "completedAt">): string {
  if (request.status === "done") {
    const date = request.completedAt ? new Date(request.completedAt) : null;
    const when =
      date && !Number.isNaN(date.getTime())
        ? date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" })
        : "";
    return when ? `Completed ${when}` : "Completed";
  }
  if (request.status === "shared") return "Link shared · not opened";
  if (request.status === "not_needed") return "Not needed";
  return "Waiting on applicant";
}

/** "N more forms to finish" heading on the applicant's finish screen and Applications section. */
export function moreFormsHeading(count: number): string {
  return `${count} more form${count === 1 ? "" : "s"} to finish`;
}

/** Facts line under a form's name: question count and fee. */
export function linkedFormFacts(request: Pick<LinkedFormRequestView, "questionCount" | "feeCents">): string[] {
  const facts: string[] = [];
  if (request.questionCount && request.questionCount > 0) {
    facts.push(`${request.questionCount} question${request.questionCount === 1 ? "" : "s"}`);
  }
  facts.push(request.feeCents && request.feeCents > 0 ? `$${(request.feeCents / 100).toFixed(2).replace(/\.00$/, "")} fee` : "No fee");
  return facts;
}
