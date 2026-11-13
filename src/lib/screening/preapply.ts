/**
 * Pre-application requirements: what an applicant completes BEFORE the application form opens, chosen by the
 * manager per listing (`ApplicantScreeningSettings`: Verify ID, Background check, either, both or none). Pure rules,
 * no I/O, shared by the applicant gate, the status/checkout routes and the application submit refusal, so the screen
 * and the server cannot disagree. See docs/agents/identity-and-screening.md § Before applying.
 *
 * - Checkr's ID add-on only exists INSIDE an order, so with Checkr "Verify ID first" is one payment for Starter + ID
 *   (the cheapest orderable), and the application opens when the ID product returns clear (or, when the manager chose
 *   "unlock after order", as soon as the order is placed).
 * - With Persona (and its keys) Verify ID is Persona's standalone flow; no background order is needed for it.
 * - Stripe Identity is never a provider (FCRA purpose; see `resident-identity/provider.ts`).
 */
import { applicationIdentityVerified } from "@/lib/checkr/identity";
import type { ApplicationBackgroundCheck } from "@/lib/checkr/types";
import {
  applicantScreeningQuote,
  type ApplicantScreeningQuote,
  type ApplicantScreeningSettings,
} from "@/lib/screening/applicant-screening";

export type PreApplyIdProvider = "checkr" | "persona";
export type PreApplyStepId = "verify_id" | "background_check";
export type PreApplyStepStatus = "done" | "todo" | "in_progress" | "blocked";
export type PreApplyBlockReason = "unavailable" | "review";

export const PRE_APPLY_STEP_LABELS: Record<PreApplyStepId, string> = {
  verify_id: "Verify ID",
  background_check: "Background check",
};

/** What the deployment can actually do, read from the environment by the server. */
export type PreApplyEnvironment = {
  /** `RESIDENT_IDENTITY_ENABLED=true`. Off means no ID requirement is enforced here. */
  idEnabled: boolean;
  /** The provider that can verify an ID right now, or null when enabled but nothing can (fails closed). */
  idProvider: PreApplyIdProvider | null;
  /** Checkr is configured (an order can be placed). */
  backgroundConfigured: boolean;
};

export type PreApplyPlan = {
  verifyId: { required: boolean; provider: PreApplyIdProvider | null; unavailable: boolean };
  backgroundCheck: { required: boolean };
  idUnlock: ApplicantScreeningSettings["idUnlock"];
  /** The Checkr order the applicant pays for before applying, or null when none is part of the plan. */
  order: { quote: ApplicantScreeningQuote; includeIdCheck: boolean } | null;
};

export function resolvePreApplyPlan(input: {
  settings: ApplicantScreeningSettings;
  env: PreApplyEnvironment;
}): PreApplyPlan {
  const { settings, env } = input;
  const idRequired = settings.idCheck && env.idEnabled;
  const unavailable = idRequired && env.idProvider === null;
  const checkrId = idRequired && env.idProvider === "checkr";
  // A background check nobody can order is not a requirement (as the post-application offer never was).
  const backgroundRequired = settings.backgroundCheck && env.backgroundConfigured;
  const needsOrder = (checkrId || backgroundRequired) && env.backgroundConfigured;
  return {
    verifyId: { required: idRequired, provider: env.idProvider, unavailable },
    backgroundCheck: { required: backgroundRequired },
    idUnlock: settings.idUnlock,
    order: needsOrder
      ? { quote: applicantScreeningQuote({ includeIdCheck: checkrId }), includeIdCheck: checkrId }
      : null,
  };
}

export type PreApplyStep = {
  id: PreApplyStepId;
  label: string;
  status: PreApplyStepStatus;
  /** Whether this step no longer blocks the application (a pending order can count, see `idUnlock`). */
  satisfied: boolean;
  reason?: PreApplyBlockReason;
};

export type PreApplyState = {
  /** At least one step is required for this listing. */
  required: boolean;
  /** Every required step is satisfied: the application form may open and a submit is allowed. */
  satisfied: boolean;
  steps: PreApplyStep[];
  /** Where a returning applicant lands: the first unsatisfied step, else the application. */
  next: PreApplyStepId | "application";
};

type CheckFacts = Pick<
  ApplicationBackgroundCheck,
  "status" | "reportSnapshot" | "addOnProducts" | "carriedIdentity"
> | null;

function checkPlaced(check: CheckFacts): boolean {
  return Boolean(check) && check!.status !== "canceled";
}

function checkHasIdProduct(check: CheckFacts): boolean {
  return Boolean(check?.carriedIdentity) || Boolean(check?.addOnProducts?.includes("identity_verification"));
}

function checkrIdStep(plan: PreApplyPlan, check: CheckFacts): Omit<PreApplyStep, "id" | "label"> {
  if (!checkPlaced(check) || !checkHasIdProduct(check)) return { status: "todo", satisfied: false };
  if (applicationIdentityVerified(check)) return { status: "done", satisfied: true };
  if (check!.status === "pending") {
    return plan.idUnlock === "order"
      ? { status: "in_progress", satisfied: true }
      : { status: "in_progress", satisfied: false };
  }
  // Complete, but the ID product did not clear (consider, or missing): the manager decides, the form stays shut.
  return { status: "blocked", satisfied: false, reason: "review" };
}

/** The applicant's progress through the required steps. */
export function evaluatePreApply(input: {
  plan: PreApplyPlan;
  /** The applicant's pre-apply Checkr order for this listing, if any. */
  check: CheckFacts;
  /** Persona only: the account's baseline identity is approved. */
  personaVerified: boolean;
}): PreApplyState {
  const { plan, check } = input;
  const steps: PreApplyStep[] = [];

  if (plan.verifyId.required) {
    let facts: Omit<PreApplyStep, "id" | "label">;
    if (plan.verifyId.unavailable || plan.verifyId.provider === null) {
      facts = { status: "blocked", satisfied: false, reason: "unavailable" };
    } else if (plan.verifyId.provider === "persona") {
      facts = input.personaVerified ? { status: "done", satisfied: true } : { status: "todo", satisfied: false };
    } else {
      facts = checkrIdStep(plan, check);
    }
    steps.push({ id: "verify_id", label: PRE_APPLY_STEP_LABELS.verify_id, ...facts });
  }

  if (plan.backgroundCheck.required) {
    const placed = checkPlaced(check);
    steps.push({
      id: "background_check",
      label: PRE_APPLY_STEP_LABELS.background_check,
      status: !placed ? "todo" : check!.status === "pending" ? "in_progress" : "done",
      // The applicant's part is authorizing and paying; they are never held for days waiting on the report.
      satisfied: placed,
    });
  }

  const firstOpen = steps.find((step) => !step.satisfied);
  return {
    required: steps.length > 0,
    satisfied: !firstOpen,
    steps,
    next: firstOpen?.id ?? "application",
  };
}

/**
 * May a NEW paid Checkr order be placed for this applicant and listing? Not when a live one already covers what the
 * plan needs (never a second charge), but yes after a canceled order, or when the manager later turned Verify ID on and
 * the earlier order did not include it.
 */
export function preApplyOrderAllowed(plan: PreApplyPlan, check: CheckFacts): boolean {
  if (!plan.order) return false;
  if (!checkPlaced(check)) return true;
  return plan.order.includeIdCheck && !checkHasIdProduct(check);
}
