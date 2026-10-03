/**
 * Studio redesign 0930 — six-step resident lifecycle (application → move-in).
 * Lease-first workspaces reorder the same steps without changing the labels.
 */

import type { DemoApplicantRow } from "@/data/demo-portal";
import { isInProgressApplicationRow } from "@/lib/rental-application/in-progress-application";
import { applicationFeeStatusForRow } from "@/lib/resident-application-fee-status";

export type ResidentLifecycleStepId =
  | "received"
  | "review"
  | "approved"
  | "sign_lease"
  | "pay_move_in"
  | "move_in";

export type ResidentLifecycleStepState = "done" | "current" | "upcoming";

/** Who the step waits on: the resident, or the property manager. */
export type ResidentLifecycleActor = "You" | "Property manager";

export interface ResidentLifecycleStep {
  id: ResidentLifecycleStepId;
  label: string;
  state: ResidentLifecycleStepState;
  who: ResidentLifecycleActor;
}

export interface ResidentLifecycleInput {
  applicationFeePaid: boolean;
  applicationSubmitted: boolean;
  applicationApproved: boolean;
  residentSignedLease: boolean;
  managerCountersigned: boolean;
  moveInChargesPaid: boolean;
  movedIn: boolean;
  applicationFeeDeclined?: boolean;
  /** The manager declined the application. */
  applicationDeclined?: boolean;
  basePath?: string;
  /** "$3,225.00" — the unpaid move-in costs, named on the pay button. */
  moveInTotalLabel?: string;
  /** "$45.00" — the application fee, named on the pay button. */
  applicationFeeLabel?: string;
  /** The property manager's workspace name, for the countersignature wait. */
  workspaceName?: string;
}

const LABELS: Record<ResidentLifecycleStepId, string> = {
  received: "Application received",
  review: "Under review",
  approved: "Approved",
  sign_lease: "Sign lease",
  pay_move_in: "Pay move-in",
  move_in: "Move in",
};

const ACTORS: Record<ResidentLifecycleStepId, ResidentLifecycleActor> = {
  received: "You",
  review: "Property manager",
  approved: "Property manager",
  sign_lease: "You",
  pay_move_in: "You",
  move_in: "Property manager",
};

const APPLICATION_FIRST: ResidentLifecycleStepId[] = [
  "received",
  "review",
  "approved",
  "sign_lease",
  "pay_move_in",
  "move_in",
];

function stepOrder(_input: ResidentLifecycleInput): ResidentLifecycleStepId[] {
  return APPLICATION_FIRST;
}

function stepSatisfied(id: ResidentLifecycleStepId, input: ResidentLifecycleInput): boolean {
  switch (id) {
    case "received":
      return input.applicationSubmitted && input.applicationFeePaid;
    case "review":
      return input.applicationApproved || Boolean(input.applicationDeclined);
    case "approved":
      return input.applicationApproved;
    case "sign_lease":
      return input.residentSignedLease;
    case "pay_move_in":
      return input.moveInChargesPaid;
    case "move_in":
      return input.movedIn;
    default:
      return false;
  }
}

export function residentLifecycleSteps(input: ResidentLifecycleInput): ResidentLifecycleStep[] {
  const order = stepOrder(input);
  const currentIndex = order.findIndex((id) => !stepSatisfied(id, input));
  return order.map((id, index) => {
    const state: ResidentLifecycleStepState =
      currentIndex === -1 || index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
    return { id, label: LABELS[id], state, who: ACTORS[id] };
  });
}

export interface ResidentLifecycleNextAction {
  title: string;
  detail: string;
  href: string;
  ctaLabel: string;
  urgent: boolean;
  /** Whose turn it is. */
  who: ResidentLifecycleActor;
}

/**
 * The one next action, worded as the studio journey does (journey-0930): what
 * to do, one sentence on why, and a button that names the amount when money is
 * the step. Move-in costs are payable the moment the resident signs; the
 * countersignature is the last wait.
 */
export function resolveResidentLifecycleNextAction(input: ResidentLifecycleInput): ResidentLifecycleNextAction {
  const base = input.basePath?.trim() || "/resident";
  const manager = input.workspaceName?.trim() || "your manager";

  if (input.applicationDeclined) {
    return {
      title: "Application not approved",
      detail: `Message ${input.workspaceName?.trim() || "your property manager"} if you have questions.`,
      href: `${base}/communication`,
      ctaLabel: "Message",
      who: "Property manager",
      urgent: false,
    };
  }

  if (input.applicationFeeDeclined) {
    const fee = input.applicationFeeLabel?.trim();
    return {
      title: "Pay the application fee",
      detail: `${fee ? `${fee} sends it for review. ` : ""}Your card was declined.`,
      href: `${base}/applications`,
      ctaLabel: fee ? `Pay ${fee}` : "Pay fee",
      who: "You",
      urgent: true,
    };
  }

  if (!input.applicationSubmitted) {
    return {
      title: "Finish your application",
      detail: "Submit it to move this forward.",
      href: `${base}/applications`,
      ctaLabel: "Continue application",
      who: "You",
      urgent: false,
    };
  }

  if (input.applicationSubmitted && !input.applicationFeePaid) {
    const fee = input.applicationFeeLabel?.trim();
    return {
      title: "Pay the application fee",
      detail: fee ? `${fee} sends it for review.` : "Your application is not complete until the fee is paid.",
      href: `${base}/applications`,
      ctaLabel: fee ? `Pay ${fee}` : "Pay fee",
      who: "You",
      urgent: true,
    };
  }

  if (!input.applicationApproved) {
    return {
      title: "Application under review",
      detail: "You'll get an email and a text when it's decided.",
      href: `${base}/applications`,
      ctaLabel: "View application",
      who: "Property manager",
      urgent: false,
    };
  }

  if (!input.residentSignedLease) {
    return {
      title: "Review and sign your lease",
      detail: "Then pay your move-in costs in the same visit.",
      href: `${base}/sign-and-pay`,
      ctaLabel: "Review & sign",
      who: "You",
      urgent: false,
    };
  }

  if (!input.moveInChargesPaid) {
    const total = input.moveInTotalLabel?.trim();
    return {
      title: "Pay your move-in costs",
      detail: total ? `${total} covers your deposit, first month and any fees.` : "Deposit and move-in fees are due before move-in.",
      href: `${base}/sign-and-pay`,
      ctaLabel: total ? `Pay ${total}` : "Pay move-in",
      who: "You",
      urgent: false,
    };
  }

  if (!input.managerCountersigned) {
    return {
      title: "Waiting for your countersignature",
      detail: `Your move-in costs are paid. Your home opens once ${manager} countersigns.`,
      href: `${base}/lease`,
      ctaLabel: "View lease",
      who: "Property manager",
      urgent: false,
    };
  }

  if (!input.movedIn) {
    return {
      title: "Get ready to move in",
      detail: "Door code and house rules appear in Move-in.",
      href: `${base}/move-in`,
      ctaLabel: "Open move-in",
      who: "You",
      urgent: false,
    };
  }

  return {
    title: "You're all caught up",
    detail: "Nothing needs your attention right now.",
    href: `${base}/move-in`,
    ctaLabel: "Open your home",
    who: "You",
    urgent: false,
  };
}

export function residentLifecycleInputFromApplicationRow(
  row: DemoApplicantRow,
  residentEmail: string,
  basePath: string,
): ResidentLifecycleInput {
  const fee = applicationFeeStatusForRow(row, residentEmail);
  return {
    applicationFeePaid: fee.paid,
    applicationSubmitted: Boolean(row.application) && !isInProgressApplicationRow(row),
    applicationApproved: row.bucket === "approved",
    applicationDeclined: row.bucket === "rejected",
    residentSignedLease: false,
    managerCountersigned: false,
    moveInChargesPaid: false,
    movedIn: false,
    applicationFeeDeclined: fee.declined,
    basePath,
  };
}

export function residentLifecycleActorLine(
  steps: ResidentLifecycleStep[],
): { actor: string; next: string } | null {
  const current = steps.find((s) => s.state === "current");
  if (!current) return null;
  switch (current.id) {
    case "received":
      return { actor: "You", next: "Your application is in the queue." };
    case "review":
      return { actor: "Property manager", next: "They are reviewing your application." };
    case "approved":
      return { actor: "You", next: "Sign your lease when you are ready." };
    case "sign_lease":
      return { actor: "You", next: "Review the lease and sign." };
    case "pay_move_in":
      return { actor: "You", next: "Pay deposit and move-in fees." };
    case "move_in":
      return { actor: "You", next: "Complete move-in details." };
    default:
      return null;
  }
}
