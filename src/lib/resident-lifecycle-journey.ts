/**
 * Studio redesign 0930 — six-step resident lifecycle (application → move-in).
 * Lease-first workspaces reorder the same steps without changing the labels.
 */

import type { DemoApplicantRow } from "@/data/demo-portal";
import { getPropertyById } from "@/lib/rental-application/data";
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

export interface ResidentLifecycleStep {
  id: ResidentLifecycleStepId;
  label: string;
  state: ResidentLifecycleStepState;
}

export interface ResidentLifecycleInput {
  signingOrder: "application_first" | "lease_first";
  applicationFeePaid: boolean;
  applicationSubmitted: boolean;
  applicationApproved: boolean;
  residentSignedLease: boolean;
  managerCountersigned: boolean;
  moveInChargesPaid: boolean;
  movedIn: boolean;
  applicationFeeDeclined?: boolean;
  basePath?: string;
}

const LABELS: Record<ResidentLifecycleStepId, string> = {
  received: "Application received",
  review: "Under review",
  approved: "Approved",
  sign_lease: "Sign lease",
  pay_move_in: "Pay move-in",
  move_in: "Move in",
};

const APPLICATION_FIRST: ResidentLifecycleStepId[] = [
  "received",
  "review",
  "approved",
  "sign_lease",
  "pay_move_in",
  "move_in",
];

const LEASE_FIRST: ResidentLifecycleStepId[] = [
  "sign_lease",
  "received",
  "review",
  "approved",
  "pay_move_in",
  "move_in",
];

function stepOrder(input: ResidentLifecycleInput): ResidentLifecycleStepId[] {
  return input.signingOrder === "lease_first" ? LEASE_FIRST : APPLICATION_FIRST;
}

function stepSatisfied(id: ResidentLifecycleStepId, input: ResidentLifecycleInput): boolean {
  switch (id) {
    case "received":
      return input.applicationSubmitted && input.applicationFeePaid;
    case "review":
      return input.applicationApproved;
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
    return { id, label: LABELS[id], state };
  });
}

export interface ResidentLifecycleNextAction {
  title: string;
  detail: string;
  href: string;
  ctaLabel: string;
  urgent: boolean;
}

export function resolveResidentLifecycleNextAction(input: ResidentLifecycleInput): ResidentLifecycleNextAction {
  const base = input.basePath?.trim() || "/resident";

  if (input.applicationFeeDeclined) {
    return {
      title: "Pay the application fee",
      detail: "Your card was declined. Update your payment to continue.",
      href: `${base}/applications`,
      ctaLabel: "Pay fee",
      urgent: true,
    };
  }

  if (!input.applicationSubmitted) {
    return {
      title: "Finish your application",
      detail: "Submit your application to move forward.",
      href: `${base}/applications`,
      ctaLabel: "Continue application",
      urgent: false,
    };
  }

  if (input.applicationSubmitted && !input.applicationFeePaid) {
    return {
      title: "Pay the application fee",
      detail: "Your application is not complete until the fee is paid.",
      href: `${base}/applications`,
      ctaLabel: "Pay fee",
      urgent: true,
    };
  }

  if (input.signingOrder === "lease_first" && !input.residentSignedLease && input.applicationSubmitted) {
    return {
      title: "Sign your lease",
      detail: "Complete the intake lease, then finish your application.",
      href: `${base}/sign-and-pay`,
      ctaLabel: "Sign lease",
      urgent: false,
    };
  }

  if (!input.applicationApproved) {
    return {
      title: "Application under review",
      detail: "We will notify you when a decision is ready.",
      href: `${base}/applications`,
      ctaLabel: "View status",
      urgent: false,
    };
  }

  if (!input.residentSignedLease) {
    return {
      title: "Review and sign your lease",
      detail: "Sign and pay move-in costs on one page.",
      href: `${base}/sign-and-pay`,
      ctaLabel: "Sign lease",
      urgent: false,
    };
  }

  if (!input.managerCountersigned) {
    return {
      title: "Waiting for your countersignature",
      detail: "Your property manager still needs to countersign.",
      href: `${base}/lease`,
      ctaLabel: "View lease",
      urgent: false,
    };
  }

  if (!input.moveInChargesPaid) {
    return {
      title: "Pay your move-in costs",
      detail: "Deposit and move-in fees are due before move-in.",
      href: `${base}/sign-and-pay`,
      ctaLabel: "Pay move-in",
      urgent: false,
    };
  }

  if (!input.movedIn) {
    return {
      title: "Get ready to move in",
      detail: "Door code and house rules appear in Move-in.",
      href: `${base}/move-in`,
      ctaLabel: "Open move-in",
      urgent: false,
    };
  }

  return {
    title: "You're all caught up",
    detail: "Nothing needs your attention right now.",
    href: `${base}/move-in`,
    ctaLabel: "Open your home",
    urgent: false,
  };
}

export function residentLifecycleInputFromApplicationRow(
  row: DemoApplicantRow,
  residentEmail: string,
  basePath: string,
): ResidentLifecycleInput {
  const propertyId = row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
  const signingOrder =
    propertyId && getPropertyById(propertyId)?.signingOrder === "lease_first"
      ? "lease_first"
      : "application_first";
  const fee = applicationFeeStatusForRow(row, residentEmail);
  return {
    signingOrder,
    applicationFeePaid: fee.paid,
    applicationSubmitted: Boolean(row.application) && !isInProgressApplicationRow(row),
    applicationApproved: row.bucket === "approved",
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
