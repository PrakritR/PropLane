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
import { adminOversightUrl } from "@/lib/auth/admin-oversight.client";
import { portalSessionViewerId } from "@/lib/auth/portal-session-gate";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { selectedWorkspaceId } from "@/lib/workspaces/selection";
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

/**
 * Who this browser is acting as, right now: the workspace, the signed-in viewer and the admin
 * oversight target. Every authoritative read, every stage and every acknowledged write in one
 * batch has to belong to the SAME one — a workspace switch between two members of a joint lease
 * would otherwise let the second member stage into a scope the first member's read never saw.
 * `recordApprovedApplicationChargesScoped` guards changes after ITS stage was created; this
 * guards the batch around them.
 */
function billingScopeToken(): string {
  return JSON.stringify([
    selectedWorkspaceId(),
    portalSessionViewerId(),
    adminOversightUrl("/api/portal-household-charges"),
  ]);
}

/**
 * The billing-relevant revision of one application: everything the generator reads to decide
 * WHAT to bill. A change here is a new basis, not a retry of the old one — which is why the
 * retry budget is keyed on it rather than on the application id or a charge amount.
 */
function applicationBillingRevision(app: DemoApplicantRow): unknown {
  // Preserve the full application basis: the generator reads fees, move-in/out,
  // manual-resident fields and template terms beyond the rent fields.
  return app;
}

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

  // One AUTHORITATIVE read per member, taken after the previous member's write was
  // acknowledged. Members of a joint lease are not provably disjoint — the resolver dedupes
  // application ids, not emails, and a scoped recurring profile is selected by owner + email +
  // property — so two explicit members can share a profile or a legacy charge slice. Reusing one
  // pre-loop snapshot would stage the second member from state that predates the first member's
  // acknowledged rows and write them back out.
  const batchScope = billingScopeToken();
  let changed = false;
  for (const app of apps) {
    if (billingScopeToken() !== batchScope) return { ok: false, reason: "The workspace changed while charges were being prepared. Review and retry." };
    const snapshot = await readAuthoritativeBillingSnapshot().catch(() => null);
    if (!snapshot) return { ok: false, reason: "Lease sent, but charges could not be read. Review and retry." };
    if (billingScopeToken() !== batchScope) return { ok: false, reason: "The workspace changed while charges were being prepared. Review and retry." };
    const generated = recordApprovedApplicationChargesScoped(app, undefined, false, { leaseExecuted: false, atSigningOnly: true }, snapshot);
    if (!generated.ok || !generated.stage) return { ok: false, reason: "Lease sent, but charges could not be prepared. Review and retry." };
    changed ||= generated.changed;
    if (!isDemoModeActive() && !(await mirrorApplicationHouseholdChargesAwait(app, undefined, generated.stage, snapshot).catch(() => false))) return { ok: false, reason: "Lease sent, but charges could not be confirmed. Review and retry." };
    if (billingScopeToken() !== batchScope) return { ok: false, reason: "The workspace changed while charges were being saved. Review and retry." };
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

  // One AUTHORITATIVE read per member, taken after the previous member's write was
  // acknowledged — joint members can share a recurring-profile or legacy-charge slice, so a
  // reused snapshot would restore state from before the earlier member's rows landed.
  const batchScope = billingScopeToken();
  let changed = false;
  for (const app of apps) {
    if (billingScopeToken() !== batchScope) return { ok: false, reason: "The workspace changed while charges were being prepared. Review and retry." };
    // Signature freezes the money terms before the first bill is posted, so the listing's
    // price from here on is someone else's business.
    const frozen = freezeSignedLeaseTerms(app, { managerUserId, lease });
    let confirmed = frozen.row;
    if (frozen.changed) {
      const result = await persistFrozenSignedLeaseTerms([frozen.row], lease.id);
      if (!result.ok) return { ok: false, reason: "Lease signed, but its payment terms could not be saved. Review and retry." };
      confirmed = result.rows[0]!;
    }
    const snapshot = await readAuthoritativeBillingSnapshot().catch(() => null);
    if (!snapshot) return { ok: false, reason: "Lease signed, but charges could not be read. Review and retry." };
    if (billingScopeToken() !== batchScope) return { ok: false, reason: "The workspace changed while charges were being prepared. Review and retry." };
    const generated = recordApprovedApplicationChargesScoped(confirmed, app, false, { leaseExecuted: true, ...(options?.recurringProfileOnly ? { recurringProfileOnly: true } : {}) }, snapshot);
    if (!generated.ok || !generated.stage) return { ok: false, reason: "Lease signed, but charges could not be prepared. Review and retry." };
    changed ||= generated.changed;
    if (!isDemoModeActive() && !(await mirrorApplicationHouseholdChargesAwait(confirmed, app, generated.stage, snapshot).catch(() => false))) return { ok: false, reason: "Lease signed, but charges could not be confirmed. Review and retry." };
    if (billingScopeToken() !== batchScope) return { ok: false, reason: "The workspace changed while charges were being saved. Review and retry." };
    if (!generated.stage.commit()) return { ok: false, reason: "Lease signed, but charges changed. Review and retry." };
  }
  return { ok: true, created: changed, applications: apps.length };
}

/** Leases signed this long ago are still looked at; older ones belong to the Payments reconciler. */
const WATCH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * TWO sets, and the difference between them is the whole point.
 *
 * `acknowledged` holds only what the server confirmed: a batch whose every member's charges were
 * written AND acknowledged. Nothing else may enter it. A failure that merely ran out of tries is
 * not a completed write, and recording it as one would leave a signed lease unbilled with no
 * trace.
 *
 * `spentAttempts` is the backoff. A pass can find the listing catalog not hydrated yet, so a
 * batch gets a few tries — not one per lease-pipeline event forever, because each attempt costs
 * an authoritative charges GET and a write (AGENTS.md § Performance & egress).
 *
 * Both are keyed on the BASIS, not on the lease id: the scope this browser is acting in, the
 * lease's own generation, and every billed application's billing revision. So a workspace or
 * viewer switch inherits neither success nor exhaustion, and an edit to the lease or the
 * application earns a fresh budget rather than being refused by a stale one. Module globals
 * survive SPA navigation, which is why an explicit retry has
 * {@link clearExecutedLeaseChargeBackoff}.
 */
const acknowledged = new Set<string>();
const spentAttempts = new Map<string, number>();
const MAX_ATTEMPTS = 4;

/** Test seam: drops the per-session dedupe so a watcher pass starts from nothing. */
export function resetExecutedLeaseChargeWatchState(): void {
  acknowledged.clear();
  spentAttempts.clear();
}

/**
 * An explicit "try again" from a person. It drops the BACKOFF only — an acknowledged write is
 * still acknowledged, so a retry never bills the same lease twice.
 */
export function clearExecutedLeaseChargeBackoff(): void {
  spentAttempts.clear();
}

function billingBatchKey(
  stage: "sent" | "executed",
  lease: LeasePipelineRow,
  apps: readonly DemoApplicantRow[],
): string {
  return JSON.stringify([
    stage,
    billingScopeToken(),
    lease.id,
    lease.status,
    lease.versionNumber ?? null,
    lease.updatedAtIso ?? null,
    lease.fullySignedAt ?? null,
    apps.map((app) => applicationBillingRevision(app)),
  ]);
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
          const sentApps = applicationsBilledByLease(lease, readManagerApplicationRows());
          if (sentApps.length > 0) {
            const key = billingBatchKey("sent", lease, sentApps);
            if (!acknowledged.has(key) && (spentAttempts.get(key) ?? 0) < MAX_ATTEMPTS) {
              spentAttempts.set(key, (spentAttempts.get(key) ?? 0) + 1);
              const sent = await createAtSigningChargesForSentLease(lease, managerUserId).catch(() => null);
              if (sent?.ok) acknowledged.add(key);
            }
          }
          continue;
        }
        if (lease.status !== "Fully Signed" || lease.pendingRenewal) continue;
        const signedAt = Date.parse(lease.fullySignedAt ?? "");
        if (!Number.isFinite(signedAt) || now - signedAt > WATCH_WINDOW_MS) continue;
        const apps = applicationsBilledByLease(lease, readManagerApplicationRows());
        if (apps.length === 0) continue;
        const key = billingBatchKey("executed", lease, apps);
        if (acknowledged.has(key) || (spentAttempts.get(key) ?? 0) >= MAX_ATTEMPTS) continue;
        spentAttempts.set(key, (spentAttempts.get(key) ?? 0) + 1);
        const result = await createChargesForExecutedLease(lease, managerUserId).catch(() => null);
        if (result?.ok) acknowledged.add(key);
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
