/**
 * C118 — one journey timeline instead of four separate status cards.
 *
 * Pure decision logic only: which single step the resident is on right now,
 * and the ONE button that moves them forward. `resident-dashboard.tsx`
 * renders this above its existing "Needs attention" groups (kept for their
 * own detail) as the one-glance answer to "what do I do next."
 *
 * Order mirrors the real product journey: a tour, then the application,
 * then the lease, then keeping up with payments. Each step is "done" once
 * its own condition clears, "current" at the first one that has not, and
 * every step after that is "upcoming" — a resident is never shown two
 * simultaneous next steps.
 */

export type ResidentJourneyStepId = "tour" | "application" | "lease" | "payments";

export type ResidentJourneyStepState = "done" | "current" | "upcoming";

export interface ResidentJourneyStep {
  id: ResidentJourneyStepId;
  label: string;
  state: ResidentJourneyStepState;
}

export interface ResidentJourneyNextAction {
  id: ResidentJourneyStepId | "none";
  title: string;
  detail: string;
  href: string;
  ctaLabel: string;
  /** Danger styling for an overdue balance; every other step reads as informational. */
  urgent: boolean;
}

export interface ResidentJourneyInput {
  hasPendingTour: boolean;
  applicationSubmitted: boolean;
  applicationApproved: boolean;
  leaseSignatureNeeded: boolean;
  leaseSigned: boolean;
  overdueChargeCount: number;
  pendingChargeCount: number;
  totalBalanceDueLabel: string;
  basePath?: string;
}

const STEP_LABELS: Record<ResidentJourneyStepId, string> = {
  tour: "Tour",
  application: "Application",
  lease: "Lease",
  payments: "Payments",
};

/** Whether each step's own condition has cleared, in journey order. */
function stepDoneFlags(input: ResidentJourneyInput): Record<ResidentJourneyStepId, boolean> {
  return {
    tour: !input.hasPendingTour,
    application: input.applicationApproved,
    lease: input.leaseSigned,
    payments: input.overdueChargeCount === 0 && input.pendingChargeCount === 0,
  };
}

const STEP_ORDER: ResidentJourneyStepId[] = ["tour", "application", "lease", "payments"];

/** The step trail for the compact progress dots — one state per step, never two "current"s. */
export function residentJourneySteps(input: ResidentJourneyInput): ResidentJourneyStep[] {
  const done = stepDoneFlags(input);
  const currentIndex = STEP_ORDER.findIndex((id) => !done[id]);
  return STEP_ORDER.map((id, index) => {
    // A step's own condition can happen to already hold before the resident
    // has reached it (no charges due yet, with the lease still unsigned) —
    // that must still read "upcoming", never "done" out of sequence, or the
    // trail shows two gaps with nothing between them.
    const state: ResidentJourneyStepState =
      currentIndex === -1 || index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
    return { id, label: STEP_LABELS[id], state };
  });
}

/** The single button the resident sees — the whole point of C118. */
export function resolveResidentJourneyNextAction(input: ResidentJourneyInput): ResidentJourneyNextAction {
  const base = input.basePath?.trim() || "/resident";

  if (input.hasPendingTour) {
    return {
      id: "tour",
      title: "Your tour is pending",
      detail: "Your property manager still needs to confirm a time.",
      href: `${base}/tour`,
      ctaLabel: "View tour",
      urgent: false,
    };
  }
  if (!input.applicationSubmitted) {
    return {
      id: "application",
      title: "Finish your application",
      detail: "Submit your application to move this forward.",
      href: `${base}/applications`,
      ctaLabel: "Continue application",
      urgent: false,
    };
  }
  if (!input.applicationApproved) {
    return {
      id: "application",
      title: "Application under review",
      detail: "We will let you know as soon as it is decided.",
      href: `${base}/applications`,
      ctaLabel: "View application",
      urgent: false,
    };
  }
  if (input.leaseSignatureNeeded) {
    return {
      id: "lease",
      title: "Sign your lease",
      detail: "Your signature is the last step before move-in.",
      href: `${base}/lease`,
      ctaLabel: "Sign lease",
      urgent: false,
    };
  }
  if (!input.leaseSigned) {
    return {
      id: "lease",
      title: "Lease is being prepared",
      detail: "Your property manager is finishing your lease.",
      href: `${base}/lease`,
      ctaLabel: "View lease",
      urgent: false,
    };
  }
  if (input.overdueChargeCount > 0) {
    return {
      id: "payments",
      title: `${input.totalBalanceDueLabel} overdue`,
      detail: "Pay now to avoid late fees.",
      // `?pay=now` is the C248 shortcut: resident-payments-panel.tsx reads it
      // and opens the pay confirmation directly, skipping list -> record ->
      // Pay for the single most common resident action.
      href: `${base}/payments?pay=now`,
      ctaLabel: "Pay now",
      urgent: true,
    };
  }
  if (input.pendingChargeCount > 0) {
    return {
      id: "payments",
      title: `${input.totalBalanceDueLabel} due`,
      detail: "Take care of your next payment.",
      href: `${base}/payments?pay=now`,
      ctaLabel: "Pay now",
      urgent: false,
    };
  }
  return {
    id: "none",
    title: "You're all caught up",
    detail: "Nothing needs your attention right now.",
    href: `${base}/move-in`,
    ctaLabel: "Open your home",
    urgent: false,
  };
}
