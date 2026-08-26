/**
 * When an unattended approval may fire.
 *
 * Auto-approve had a switch, a decision and a runner but no trigger, because "when" is the part
 * that carries the risk. Approval provisions a resident account and writes rent charges, so firing
 * it at the wrong moment is expensive and hard to walk back.
 *
 * The trigger is the manager's own Applications list loading. That is deliberate and worth stating,
 * because two other options were available and are worse:
 *
 *   - **On submission** would approve an applicant seconds after they finished typing, before the
 *     screening result exists. Nothing would ever have been reviewable.
 *   - **A background job** cannot run at all: approval-time charge generation is browser-only
 *     (`recordApprovedApplicationCharges` bails via `isBrowser()` and needs the manager's local
 *     listing catalog), so a server sweep would approve applications and silently bill nobody.
 *
 * Firing on list load means it happens exactly where a manager would otherwise have clicked
 * Approve, with the same data loaded, and they see the result on the screen they are looking at.
 *
 * `eligibleForAutoApproval` is the whole rule and is pure, so what gets approved unattended is
 * readable in one place rather than spread through a component.
 */

export type AutoApproveCandidate = {
  id: string;
  /** The bucket the row is in now. Only a pending application is a candidate. */
  bucket?: string | null;
  /** Set when the resident withdrew. Never approved. */
  withdrawnAt?: string | null;
  /** False while the applicant still has required answers outstanding. */
  complete?: boolean;
  /** Screening outcome when one was ordered: "clear", "consider", "failed", or absent. */
  screeningStatus?: string | null;
};

export type AutoApproveSkipReason =
  | "not_pending"
  | "withdrawn"
  | "incomplete"
  | "screening_pending"
  | "screening_adverse";

export type AutoApproveDecision =
  | { approve: true }
  | { approve: false; reason: AutoApproveSkipReason };

/**
 * Whether ONE application may be approved without a human looking.
 *
 * Every branch refuses rather than approves when it cannot tell. An application that should have
 * been approved and was not costs the manager a click; one approved that should not have been
 * creates a resident account, bills them, and has to be unpicked by hand.
 */
export function eligibleForAutoApproval(row: AutoApproveCandidate): AutoApproveDecision {
  if ((row.bucket ?? "").toLowerCase() !== "pending") {
    return { approve: false, reason: "not_pending" };
  }
  if (row.withdrawnAt?.trim()) {
    return { approve: false, reason: "withdrawn" };
  }
  // `complete` absent means unknown, and unknown is not a yes.
  if (row.complete !== true) {
    return { approve: false, reason: "incomplete" };
  }

  const screening = (row.screeningStatus ?? "").trim().toLowerCase();
  if (screening) {
    // Only an explicitly clear result auto-approves. "consider" is the outcome that exists
    // precisely BECAUSE a human should look, and anything unrecognised is treated the same way.
    if (screening === "clear" || screening === "passed") return { approve: true };
    if (screening === "pending" || screening === "processing" || screening === "in_progress") {
      return { approve: false, reason: "screening_pending" };
    }
    return { approve: false, reason: "screening_adverse" };
  }

  // No screening was ordered, so there is no adverse signal to wait for.
  return { approve: true };
}

/**
 * Pick the applications to approve on this pass.
 *
 * Capped, and deliberately so: a manager who switches this on with a large backlog should not have
 * fifty accounts provisioned and fifty sets of charges written in one page load. The rest are
 * picked up on the next load, which keeps any mistake small and observable.
 */
export const AUTO_APPROVE_MAX_PER_PASS = 5;

export function selectAutoApprovals<T extends AutoApproveCandidate>(
  rows: readonly T[],
  options?: { enabled?: boolean; isDemo?: boolean; limit?: number },
): T[] {
  if (!options?.enabled) return [];
  // /demo must never write a real row.
  if (options?.isDemo) return [];
  const limit = options?.limit ?? AUTO_APPROVE_MAX_PER_PASS;
  const out: T[] = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    if (eligibleForAutoApproval(row).approve) out.push(row);
  }
  return out;
}
