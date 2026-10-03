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
  mirrorHouseholdChargesToServerAwait,
  readChargesForManager,
  recordApprovedApplicationCharges,
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
  const found = new Map<string, DemoApplicantRow>();
  const add = (row: DemoApplicantRow | undefined) => {
    if (row && !found.has(row.id)) found.set(row.id, row);
  };
  const byAxis = (id?: string | null) => {
    const key = id ? normalizeApplicationAxisId(id) : "";
    return key ? apps.find((a) => normalizeApplicationAxisId(a.id) === key) : undefined;
  };
  const byEmail = (email?: string | null) => {
    const key = email?.trim().toLowerCase();
    return key ? apps.find((a) => a.email?.trim().toLowerCase() === key) : undefined;
  };
  if (lease.leaseKind === "joint_bundle" && lease.jointLeaseMembers?.length) {
    for (const member of lease.jointLeaseMembers) add(byAxis(member.applicationId) ?? byEmail(member.residentEmail));
  }
  if (found.size === 0) add(byAxis(lease.axisId) ?? byEmail(lease.residentEmail));
  return [...found.values()];
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

  let changed = false;
  for (const app of apps) {
    if (recordApprovedApplicationCharges(app, managerUserId, false, { leaseExecuted: false, atSigningOnly: true })) {
      changed = true;
    }
  }
  if (changed && !isDemoModeActive()) {
    // Write through before returning so the resident's lease page already shows the payment.
    await mirrorHouseholdChargesToServerAwait().catch(() => false);
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
): Promise<ExecutedLeaseChargesResult> {
  if (lease.status !== "Fully Signed") return { ok: false, reason: "The lease is not fully signed yet." };
  if (lease.pendingRenewal) return { ok: false, reason: "A renewal applies its own terms." };
  const apps = applicationsBilledByLease(lease, readManagerApplicationRows());
  if (apps.length === 0) return { ok: false, reason: "No application is on file for this lease." };

  let changed = false;
  for (const app of apps) {
    // Signature freezes the money terms before the first bill is posted, so the listing's
    // price from here on is someone else's business.
    const frozen = freezeSignedLeaseTerms(app, { managerUserId, lease });
    if (frozen.changed) persistFrozenSignedLeaseTerms([frozen.row]);
    if (recordApprovedApplicationCharges(frozen.row, managerUserId, false, { leaseExecuted: true })) changed = true;
  }
  if (changed && !isDemoModeActive()) {
    // Write through before returning so the resident's Payments is already right when this resolves.
    await mirrorHouseholdChargesToServerAwait().catch(() => false);
  }
  return { ok: true, created: changed, applications: apps.length };
}

/** Leases signed this long ago are still looked at; older ones belong to the Payments reconciler. */
const WATCH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const handled = new Set<string>();
/** A pass can find the listing catalog not hydrated yet; a lease gets a few tries, not a loop. */
const attempts = new Map<string, number>();
const MAX_ATTEMPTS = 4;

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
            if (sentApps.length > 0 && sentApps.every((app) => applicationHasAtSigningCharges(app.id, managerUserId))) {
              handled.add(sentKey);
            } else if (sentApps.length > 0) {
              const triedSent = (attempts.get(sentKey) ?? 0) + 1;
              attempts.set(sentKey, triedSent);
              const sent = await createAtSigningChargesForSentLease(lease, managerUserId).catch(() => null);
              if (triedSent >= MAX_ATTEMPTS || (sent && sent.ok)) handled.add(sentKey);
            }
          }
          continue;
        }
        if (lease.status !== "Fully Signed" || lease.pendingRenewal || handled.has(lease.id)) continue;
        const signedAt = Date.parse(lease.fullySignedAt ?? "");
        if (!Number.isFinite(signedAt) || now - signedAt > WATCH_WINDOW_MS) continue;
        const apps = applicationsBilledByLease(lease, readManagerApplicationRows());
        if (apps.length === 0) continue;
        if (apps.every((app) => applicationHasTenancyCharges(app.id, managerUserId))) {
          handled.add(lease.id);
          continue;
        }
        const tried = (attempts.get(lease.id) ?? 0) + 1;
        attempts.set(lease.id, tried);
        const result = await createChargesForExecutedLease(lease, managerUserId).catch(() => null);
        const done = apps.every((app) => applicationHasTenancyCharges(app.id, managerUserId));
        if (done || tried >= MAX_ATTEMPTS || (result && !result.ok)) handled.add(lease.id);
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
