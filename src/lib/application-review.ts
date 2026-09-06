import type { DemoApplicantRow, ManagerApplicationBucket } from "@/data/demo-portal";
import { readManagerApplicationRows, writeManagerApplicationRows } from "@/lib/manager-applications-storage";
import {
  recordApprovedApplicationCharges,
  recordSubmittedApplicationFeeCharge,
  removeAllApplicationCharges,
  removeApprovedApplicationCharges,
} from "@/lib/household-charges";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import type { ApplicationAutomationPreferences } from "@/lib/application-automation-preferences";
import type { ApplicationAutomationResult } from "@/lib/application-automation-run.client";

export function stageLabelForApplicationBucket(bucket: ManagerApplicationBucket): string {
  if (bucket === "approved") return "Approved";
  if (bucket === "rejected") return "Rejected";
  return "Submitted";
}

async function syncResidentApprovalStatus(row: DemoApplicantRow, nextBucket: ManagerApplicationBucket): Promise<Response | null> {
  const email = row.email?.trim().toLowerCase();
  if (!email) return null;
  // /demo never writes real rows — and its sandbox rows are not on the server, so
  // a refusal here would only roll back a walkthrough that is working as intended.
  if (isDemoModeActive()) return null;
  // `applicationId` lets the server re-check the exact record's withdrawn stamp so a
  // withdrawn application can never be approved server-side (defense in depth).
  return fetch("/api/portal/resident-approval", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, approved: nextBucket === "approved", applicationId: row.id }),
  });
}

/** POST welcome email; does not open mailto (used for auto-send on approve). */
export async function requestResidentWelcomeEmail(row: DemoApplicantRow): Promise<{
  status: "sent" | "failed" | "no_email";
  mailtoHref?: string;
  error?: string;
}> {
  const email = row.email?.trim();
  if (!email) return { status: "no_email" };
  const res = await fetch("/api/portal/send-resident-welcome", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ to: email, residentName: row.name, axisId: row.id }),
  });
  const data = (await res.json()) as { ok?: boolean; error?: string; mailtoHref?: string };
  if (res.ok && data.ok) return { status: "sent" };
  return { status: "failed", mailtoHref: typeof data.mailtoHref === "string" ? data.mailtoHref : undefined, error: data.error };
}

export const WITHDRAWN_APPROVAL_BLOCKED_MESSAGE =
  "This application was withdrawn by the applicant and can no longer be approved.";
const UNCONFIRMED_APPROVAL_MESSAGE =
  "This applicant has a withdrawn application on file — refresh to see the current status before approving.";
const UNREACHABLE_APPROVAL_MESSAGE =
  "Couldn't reach the server — approval not saved, retry when connected.";

export type ApplicationBucketTransition = {
  row: DemoApplicantRow;
  welcomeSent: boolean;
  /** Set when the transition did NOT take effect; or its post-commit access setup needs retry. */
  blocked?: "withdrawn" | "error";
  message?: string;
  /** What the manager's enabled post-approval automation did, when any is on. */
  automation?: ApplicationAutomationResult;
};

type ResidentApprovalRefusal = {
  error?: unknown;
  blockedApplicationId?: unknown;
  matchedBy?: unknown;
};

/**
 * A 409 only proves THIS application is withdrawn when the server matched it by id.
 * Its email fallback can resolve a different application by the same applicant (the
 * approved row's mirror may not have landed yet), and a stamp written from that
 * would be mirrored back and permanently mislabel a record nobody withdrew.
 */
function refusalConfirmsThisApplication(id: string, refusal: ResidentApprovalRefusal): boolean {
  if (refusal.matchedBy !== "id") return false;
  const blockedId = typeof refusal.blockedApplicationId === "string" ? refusal.blockedApplicationId.trim() : "";
  return Boolean(blockedId) && blockedId.toUpperCase() === id.trim().toUpperCase();
}

/**
 * Shared application bucket transition (pending/approved/rejected): the same status change,
 * charge reconciliation, and resident-approval sync used by the Applications tab, reused by
 * the Residents tab's inline Approve/Deny so both surfaces stay on one code path.
 */
export async function transitionApplicationBucket(
  id: string,
  nextBucket: ManagerApplicationBucket,
  opts: {
    userId: string | null;
    skipWelcomeEmail?: boolean;
    /**
     * The manager's saved automation flags. Omitted (the default) means fully manual — the
     * approval behaves exactly as it did before automation existed.
     */
    automation?: ApplicationAutomationPreferences;
  },
): Promise<ApplicationBucketTransition | null> {
  const rows = readManagerApplicationRows();
  const row = rows.find((r) => r.id === id);
  if (!row) return null;
  // Money-path guard: a resident-withdrawn application must never be approved.
  // Approving it would provision a resident account + rent/deposit charges for
  // someone who explicitly pulled out. The manager UI already hides Approve for
  // withdrawn rows; this is the shared-code backstop (the Residents tab reuses
  // this same path), and the server re-checks in /api/portal/resident-approval.
  if (nextBucket === "approved" && isWithdrawnApplicationRow(row)) {
    return { row, welcomeSent: false, blocked: "withdrawn", message: WITHDRAWN_APPROVAL_BLOCKED_MESSAGE };
  }
  const next = rows.map((r) =>
    r.id === id
      ? {
          ...r,
          bucket: nextBucket,
          stage: stageLabelForApplicationBucket(nextBucket),
          managerUserId: r.managerUserId ?? (nextBucket === "approved" ? (opts.userId ?? undefined) : r.managerUserId),
        }
      : r,
  );
  const updatedRow = next.find((r) => r.id === id) ?? row;
  // Reserve the bed on the server BEFORE local publication, charges or lease sync.
  if (nextBucket === "approved" && !isDemoModeActive()) {
    try {
      const response = await fetch("/api/manager-applications", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "upsert", row: updatedRow }),
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 409 && /withdrawn/i.test(String(result.error))) {
        const confirmed = refusalConfirmsThisApplication(id, result);
        if (confirmed) writeManagerApplicationRows(readManagerApplicationRows().map(r => r.id === id ? { ...r, withdrawnAt: r.withdrawnAt || new Date().toISOString() } : r), { serverConfirmed: true });
        return { row, welcomeSent: false, blocked: confirmed ? "withdrawn" : "error", message: confirmed ? WITHDRAWN_APPROVAL_BLOCKED_MESSAGE : UNCONFIRMED_APPROVAL_MESSAGE };
      }
      if (!response.ok || result.ok !== true) return { row, welcomeSent: false, blocked: "error", message: result.error || "Approval could not be saved. Refresh and retry." };
    } catch { return { row, welcomeSent: false, blocked: "error", message: UNREACHABLE_APPROVAL_MESSAGE }; }
  }
  writeManagerApplicationRows(readManagerApplicationRows().map(r => r.id === id ? updatedRow : r), { serverConfirmed: nextBucket === "approved" && !isDemoModeActive() });

  try {
    if (nextBucket === "approved") {
      recordApprovedApplicationCharges(updatedRow, opts.userId ?? null);
    } else if (nextBucket === "pending") {
      removeApprovedApplicationCharges(id, opts.userId ?? null);
      recordSubmittedApplicationFeeCharge(updatedRow, opts.userId ?? null);
    } else {
      removeAllApplicationCharges(id, opts.userId ?? null);
    }
  } catch {
    /* Keep approval flow moving even if charge reconciliation fails. */
  }

  // The application is now authoritative. A profile-sync failure cannot revoke
  // its committed placement or remove its charges; stop downstream notifications.
  try {
    const response = await syncResidentApprovalStatus(updatedRow, nextBucket);
    if (nextBucket === "approved" && response && !response.ok) {
      return { row: updatedRow, welcomeSent: false, blocked: "error", message: "Approval saved, but resident access could not be synchronized. Retry to finish setup." };
    }
  } catch {
    if (nextBucket === "approved") return { row: updatedRow, welcomeSent: false, blocked: "error", message: "Approval saved, but resident access could not be synchronized. Retry to finish setup." };
  }

  let welcomeSent = false;
  if (nextBucket === "approved" && updatedRow.email?.trim() && !opts.skipWelcomeEmail) {
    const welcome = await requestResidentWelcomeEmail(updatedRow);
    welcomeSent = welcome.status === "sent";
  }

  // Post-approval automation runs ONLY here, after the server has committed the placement —
  // so the server has confirmed the approval and the lease row exists. Firing it earlier could
  // generate and send a lease for an approval the server then refused.
  //
  // The runner is imported DYNAMICALLY and only when a step is actually enabled. It reaches the
  // whole lease-pipeline module, and a static import would pull that entire graph into every
  // approval — including the fully-manual one this feature is not meant to touch.
  let automation: ApplicationAutomationResult | undefined;
  const wantsAutomation =
    opts.automation && (opts.automation.autoGenerateLease || opts.automation.autoSendLease);
  if (nextBucket === "approved" && opts.automation && wantsAutomation) {
    try {
      const { runPostApprovalAutomation } = await import("@/lib/application-automation-run.client");
      automation = await runPostApprovalAutomation({
        applicationId: id,
        residentEmail: updatedRow.email ?? "",
        managerUserId: opts.userId ?? null,
        prefs: opts.automation,
        // Read here rather than trusting a caller to pass it: a surface that forgets would write
        // real rows from /demo.
        isDemo: isDemoModeActive(),
        isWithdrawn: isWithdrawnApplicationRow(updatedRow),
      });
    } catch {
      // Automation is a convenience on top of a completed approval. A failure here must not
      // report the approval itself as failed — the manager can still generate and send by hand.
    }
  }

  return { row: updatedRow, welcomeSent, automation };
}
