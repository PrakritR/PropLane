/**
 * Payments start the moment the last signature lands.
 *
 * Approval bills nothing and sending a lease bills nothing: the deposit, the first
 * month and the rent schedule are created from the SIGNED terms when the lease
 * becomes fully signed (`residentChargeMoment` in `current-resident.ts`). This module
 * is that moment, written once, so every path to "fully signed" reaches it:
 *
 *  - the manager's countersignature (the usual last signature),
 *  - marking a lease signed off-platform (`lease-mark-signed.client.ts`, same code),
 *  - a resident's signature when the manager had already signed, seen by any
 *    manager session as soon as the lease pipeline syncs (`watchExecutedLeaseCharges`).
 *
 * It calls the existing charge code — `freezeSignedLeaseTerms` then
 * `recordApprovedApplicationCharges` — and does no arithmetic of its own. It is
 * idempotent: charges are keyed by application and kind, and an application that
 * already has its tenancy charges is left exactly as the manager has them, so
 * running it twice (a countersign and a watcher pass, two tabs) creates nothing twice.
 * The ledger code reads the manager's listing catalog, which exists only in a manager's
 * browser — which is why a resident's own browser never runs this.
 */
import type { DemoApplicantRow } from "@/data/demo-portal";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  mirrorApplicationHouseholdChargesAwait,
  recordApprovedApplicationChargesScoped,
  readAuthoritativeBillingSnapshot,
  readChargesForManager,
} from "@/lib/household-charges";
import {
  LEASE_PIPELINE_EVENT,
  readLeasePipeline,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import { freezeSignedLeaseTerms, persistFrozenSignedLeaseTerms } from "@/lib/lease-signed-terms";
import { normalizeApplicationAxisId, readManagerApplicationRows } from "@/lib/manager-applications-storage";

export type ExecutedLeaseChargesResult =
  | { ok: true; created: boolean; applications: number }
  | { ok: false; reason: string };

/** The application rows a fully signed lease bills: its own, plus every member of a joint lease. */
export function applicationsBilledByLease(lease: LeasePipelineRow, apps: readonly DemoApplicantRow[]): DemoApplicantRow[] {
  const owner = lease.managerUserId?.trim();
  const property = lease.propertyId?.trim();
  if (!owner || !property) return [];
  const eligible = apps.filter((app) => app.managerUserId?.trim() === owner && (app.assignedPropertyId?.trim() || app.propertyId?.trim() || app.application?.propertyId?.trim()) === property);
  const find = (id: string | null | undefined, email: string | null | undefined) => {
    const key = id?.trim().toUpperCase();
    const normalizedEmail = email?.trim().toLowerCase();
    const matches = key ? eligible.filter((app) => app.id.trim().toUpperCase() === key) : normalizedEmail ? eligible.filter((app) => app.email?.trim().toLowerCase() === normalizedEmail) : [];
    return matches.length === 1 ? matches[0] : undefined;
  };
  if (lease.leaseKind === "joint_bundle") {
    if (!lease.jointLeaseMembers?.length) return [];
    const members = lease.jointLeaseMembers.map((member) => member.applicationId?.trim() ? find(member.applicationId, member.residentEmail) : undefined);
    return members.every((member): member is DemoApplicantRow => Boolean(member)) ? [...new Map(members.map((member) => [member.id, member])).values()] : [];
  }
  const app = find(lease.axisId, lease.residentEmail);
  return app ? [app] : [];
}

/**
 * True once the application carries any tenancy charge (an application fee alone is not one). The lines
 * created when the lease was SENT (`dueAtSigning`: the lease fee, deposit, move-in fee) are the start of the
 * schedule, not all of it, so they alone do not mean the executed lease has been billed.
 */
export function applicationHasTenancyCharges(applicationId: string, managerUserId: string | null): boolean {
  const key = normalizeApplicationAxisId(applicationId);
  return readChargesForManager(managerUserId).some(
    (charge) =>
      charge.applicationId &&
      normalizeApplicationAxisId(charge.applicationId) === key &&
      charge.kind !== "application_fee" &&
      charge.kind !== "holding_deposit" &&
      charge.dueAtSigning !== true,
  );
}

/** True once the application carries any line collected at signing (stamped when the lease is sent). */
export function applicationHasAtSigningCharges(applicationId: string, managerUserId: string | null): boolean {
  const key = normalizeApplicationAxisId(applicationId);
  return readChargesForManager(managerUserId).some(
    (charge) =>
      charge.dueAtSigning === true &&
      charge.applicationId &&
      normalizeApplicationAxisId(charge.applicationId) === key,
  );
}

/**
 * The moment a lease is SENT: create the charges the resident pays before they can sign — the lease fee,
 * the deposit and move-in fee (and first month's rent) the listing collects at signing, and the one-time
 * fees. Each is stamped `dueAtSigning`, so the server refuses the signature until they are paid. Safe to
 * call repeatedly: lines are keyed by application and kind, and nothing is touched once the lease is signed.
 */
export async function createAtSigningChargesForSentLease(
  lease: LeasePipelineRow,
  managerUserId: string | null,
): Promise<ExecutedLeaseChargesResult> {
  if (lease.status !== "Resident Signature Pending" || lease.residentSignature) {
    return { ok: false, reason: "The lease is not waiting on the resident's signature." };
  }
  if (lease.pendingRenewal) return { ok: false, reason: "A renewal applies its own terms." };
  const apps = applicationsBilledByLease(lease, readManagerApplicationRows());
  if (apps.length === 0) return { ok: false, reason: "No application is on file for this lease." };

  // ONE authoritative read for the whole joint batch. Each member is staged from its own
  // disjoint slice of it (its application id and its own resident email), so re-reading per
  // member bought nothing and cost a full charges GET per person on the lease.
  const snapshot = await readAuthoritativeBillingSnapshot().catch(() => null);
  if (!snapshot) return { ok: false, reason: "Lease sent, but charges could not be read. Review and retry." };

  let changed = false;
  for (const app of apps) {
    const generated = recordApprovedApplicationChargesScoped(app, undefined, false, { leaseExecuted: false, atSigningOnly: true }, snapshot);
    if (!generated.ok || !generated.stage) return { ok: false, reason: "Lease sent, but charges could not be prepared. Review and retry." };
    changed ||= generated.changed;
    // Nothing to send when the generator wrote nothing: the staged rows ARE the authoritative
    // ones it staged from, so committing is a server-to-local reconcile, not a money write.
    if (generated.changed && !isDemoModeActive() && !(await mirrorApplicationHouseholdChargesAwait(app, undefined, generated.stage).catch(() => false))) return { ok: false, reason: "Lease sent, but charges could not be confirmed. Review and retry." };
    if (!generated.stage.commit()) return { ok: false, reason: "Lease sent, but charges changed. Review and retry." };
  }
  return { ok: true, created: changed, applications: apps.length };
}

/**
 * Create the deposit, first month and rent schedule of a fully signed lease, at once, from its
 * signed terms. Safe to call repeatedly. A renewal's new terms are applied by the renewal path
 * (`applySignedLeaseRenewal`), not here.
 */
export async function createChargesForExecutedLease(
  lease: LeasePipelineRow,
  managerUserId: string | null,
  options?: { recurringProfileOnly?: boolean },
): Promise<ExecutedLeaseChargesResult> {
  if (lease.status !== "Fully Signed") return { ok: false, reason: "The lease is not fully signed yet." };
  if (lease.pendingRenewal) return { ok: false, reason: "A renewal applies its own terms." };
  const apps = applicationsBilledByLease(lease, readManagerApplicationRows());
  if (apps.length === 0) return { ok: false, reason: "No application is on file for this lease." };

  let changed = false;
  const confirmedRows: DemoApplicantRow[] = [];
  for (const app of apps) {
    // Signature freezes the money terms before the first bill is posted, so the listing's
    // price from here on is someone else's business.
    const frozen = freezeSignedLeaseTerms(app, { managerUserId, lease });
    let confirmed = frozen.row;
    if (frozen.changed) {
      const result = await persistFrozenSignedLeaseTerms([frozen.row], lease.id);
      if (!result.ok) return { ok: false, reason: "Lease signed, but its payment terms could not be saved. Review and retry." };
      confirmed = result.rows[0]!;
    }
    confirmedRows.push(confirmed);
  }
  // ONE authoritative read for the whole joint batch, taken after every member's terms are
  // frozen. Each member stages from its own disjoint slice of it.
  const snapshot = await readAuthoritativeBillingSnapshot().catch(() => null);
  if (!snapshot) return { ok: false, reason: "Lease signed, but charges could not be read. Review and retry." };

  for (const [index, confirmed] of confirmedRows.entries()) {
    const app = apps[index]!;
    const generated = recordApprovedApplicationChargesScoped(confirmed, app, false, { leaseExecuted: true, ...(options?.recurringProfileOnly ? { recurringProfileOnly: true } : {}) }, snapshot);
    if (!generated.ok || !generated.stage) return { ok: false, reason: "Lease signed, but charges could not be prepared. Review and retry." };
    changed ||= generated.changed;
    // Nothing to send when the generator wrote nothing: the staged rows ARE the authoritative
    // ones it staged from, so committing is a server-to-local reconcile, not a money write.
    if (generated.changed && !isDemoModeActive() && !(await mirrorApplicationHouseholdChargesAwait(confirmed, app, generated.stage).catch(() => false))) return { ok: false, reason: "Lease signed, but charges could not be confirmed. Review and retry." };
    if (!generated.stage.commit()) return { ok: false, reason: "Lease signed, but charges changed. Review and retry." };
  }
  return { ok: true, created: changed, applications: apps.length };
}

/** Leases signed this long ago are still looked at; older ones belong to the Payments reconciler. */
const WATCH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const handled = new Set<string>();
/**
 * A pass can find the listing catalog not hydrated yet, so a lease gets a few tries — not one
 * per lease-pipeline event forever. Every attempt costs an authoritative charges GET and a
 * write, so an unbounded retry is a per-page-load egress bill on a manager with several leases
 * signed in the window. The cap stops the RETRY only: nothing is marked billed that was not,
 * and reopening the portal starts a fresh budget.
 */
const attempts = new Map<string, number>();
const MAX_ATTEMPTS = 4;

/** Test seam: drops the per-session dedupe so a watcher pass starts from nothing. */
export function resetExecutedLeaseChargeWatchState(): void {
  handled.clear();
  attempts.clear();
}

/** True once this key has spent its attempt budget. Counts the attempt it is asked about. */
function attemptBudgetSpent(key: string): boolean {
  const spent = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, spent);
  return spent >= MAX_ATTEMPTS;
}

/**
 * For a manager session that did not itself take the last signature (the resident signed last,
 * in their own browser): as soon as the lease pipeline shows a recently executed lease whose
 * application has no tenancy charges yet, create them. Nothing waits for Payments to be opened.
 * Returns the cleanup.
 */
export function watchExecutedLeaseCharges(managerUserId: string | null): () => void {
  if (typeof window === "undefined") return () => undefined;
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      for (const lease of readLeasePipeline(managerUserId)) {
        // A lease sent by a path that did not create its at-signing lines (another session, an agent) gets
        // them here, so the resident is never offered a signature that skips the payment.
        if (lease.status === "Resident Signature Pending" && !lease.residentSignature && !lease.pendingRenewal) {
          const sentKey = `sent:${lease.id}`;
          if (!handled.has(sentKey)) {
            const sentApps = applicationsBilledByLease(lease, readManagerApplicationRows());
            if (sentApps.length > 0) {
              const spent = attemptBudgetSpent(sentKey);
              const sent = await createAtSigningChargesForSentLease(lease, managerUserId).catch(() => null);
              if (sent?.ok || spent) handled.add(sentKey);
            }
          }
          continue;
        }
        if (lease.status !== "Fully Signed" || lease.pendingRenewal || handled.has(lease.id)) continue;
        const signedAt = Date.parse(lease.fullySignedAt ?? "");
        if (!Number.isFinite(signedAt) || now - signedAt > WATCH_WINDOW_MS) continue;
        const apps = applicationsBilledByLease(lease, readManagerApplicationRows());
        if (apps.length === 0) continue;
        const spent = attemptBudgetSpent(lease.id);
        const result = await createChargesForExecutedLease(lease, managerUserId).catch(() => null);
        if (result?.ok || spent) handled.add(lease.id);
      }
    } finally {
      running = false;
    }
  };
  const onPipeline = () => void pass();
  window.addEventListener(LEASE_PIPELINE_EVENT, onPipeline);
  void pass();
  return () => window.removeEventListener(LEASE_PIPELINE_EVENT, onPipeline);
}
