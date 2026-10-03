import type { DemoApplicantRow, ManagerApplicationBucket } from "@/data/demo-portal";
import { normalizeApplicationAxisId, readManagerApplicationRows, writeManagerApplicationRows } from "@/lib/manager-applications-storage";
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

export type ApplicationApprovalNotification = {
  sms: "submitted" | "queued" | "unknown" | "skipped" | "failed";
  error?: string;
};

async function syncResidentApprovalStatus(
  row: DemoApplicantRow,
  nextBucket: ManagerApplicationBucket,
  notification?: { viaSms: boolean; viaEmail?: boolean },
): Promise<{ response: Response | null; sms?: ApplicationApprovalNotification }> {
  const email = row.email?.trim().toLowerCase();
  if (!email) return { response: null };
  // /demo never writes real rows — and its sandbox rows are not on the server, so
  // a refusal here would only roll back a walkthrough that is working as intended.
  if (isDemoModeActive()) return { response: null };
  // `applicationId` lets the server re-check the exact record's withdrawn stamp so a
  // withdrawn application can never be approved server-side (defense in depth).
  const response = await fetch("/api/portal/resident-approval", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      email,
      approved: nextBucket === "approved",
      applicationId: row.id,
      ...(nextBucket === "approved"
        ? { notifySms: notification?.viaSms === true, notifyEmail: notification?.viaEmail === true }
        : {}),
    }),
  });
  const body = await response.clone().json().catch(() => ({})) as { sms?: ApplicationApprovalNotification };
  return { response, ...(body.sms ? { sms: body.sms } : {}) };
}

/** POST welcome email; does not open mailto (used for auto-send on approve). */
export async function requestResidentWelcomeEmail(row: DemoApplicantRow, note?: string): Promise<{
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
    // `note` is the manager's own words from the Approve popup; the account-setup link
    // and ID stay in the email around it, so editing the message never loses the link.
    body: JSON.stringify({ to: email, residentName: row.name, axisId: row.id, ...(note?.trim() ? { note: note.trim() } : {}) }),
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
  blocked?: "withdrawn" | "error" | "capacity";
  message?: string;
  /**
   * With `blocked: "capacity"`: the server refused the bed because somebody else holds it (or the
   * room is full). Nothing was written for the refused approval. `slot` and `holderName` are
   * present when the refusal named them (a per-resident bed taken a moment ago).
   */
  conflict?: { slot?: number; holderName?: string | null };
  /** What the manager's enabled post-approval automation did, when any is on. */
  automation?: ApplicationAutomationResult;
  /** Approval already committed even when the selected SMS leg failed. */
  approvalSms?: ApplicationApprovalNotification;
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
  if (!blockedId) return false;
  // The server stores an id VARIANT (the normalized `PROPLANE-…` form) that need
  // not be byte-identical to the id this client holds, so both sides are
  // normalized before comparison — the same key the SQL side matches on.
  const key = (value: string) => normalizeApplicationAxisId(value).toUpperCase();
  return key(blockedId) === key(id);
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
    approvalNotification?: { viaEmail: boolean; viaSms: boolean };
    /**
     * Fields to merge into the application's own answers (the bed and its rent from the Approve
     * popup). Applied to the write the server arbitrates and to the local copy only once that
     * write is accepted — a refused approval leaves the stored application exactly as it was.
     */
    applicationPatch?: Partial<NonNullable<DemoApplicantRow["application"]>>;
    /** The manager's own welcome note from the Approve popup, placed above the standard setup email. */
    welcomeNote?: string;
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
          ...(opts.applicationPatch && r.application
            ? { application: { ...r.application, ...opts.applicationPatch } }
            : {}),
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
      if (response.status === 409 && result.blocked === "capacity") {
        // The bed was taken (or the room filled) between the picker opening and this write.
        // The server wrote nothing; the local row is untouched, so there is nothing to undo.
        return {
          row,
          welcomeSent: false,
          blocked: "capacity",
          message: typeof result.error === "string" ? result.error : "That bed was just taken.",
          conflict: result.conflict && typeof result.conflict === "object" ? result.conflict : {},
        };
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
  let approvalSms: ApplicationApprovalNotification | undefined;
  try {
    const sync = await syncResidentApprovalStatus(updatedRow, nextBucket, opts.approvalNotification);
    approvalSms = sync.sms;
    if (nextBucket === "approved" && sync.response && !sync.response.ok) {
      return { row: updatedRow, welcomeSent: false, blocked: "error", message: "Approval saved, but resident access could not be synchronized. Retry to finish setup." };
    }
  } catch {
    if (nextBucket === "approved") return { row: updatedRow, welcomeSent: false, blocked: "error", message: "Approval saved, but resident access could not be synchronized. Retry to finish setup." };
  }

  let welcomeSent = false;
  if (nextBucket === "approved" && updatedRow.email?.trim() && !opts.skipWelcomeEmail && opts.approvalNotification?.viaEmail !== false) {
    const welcome = await requestResidentWelcomeEmail(updatedRow, opts.welcomeNote);
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

  return { row: updatedRow, welcomeSent, automation, ...(nextBucket === "approved" && approvalSms ? { approvalSms } : {}) };
}

/**
 * Decline is one click. No confirm dialog: the toast reads "Declined · <name>" and
 * its one button restores the application to the bucket it came from (Pending, or
 * Approved when an approved application is declined). Shared by the Applications
 * list and record and the Residents Application tab so every Decline behaves alike.
 *
 * `run` is the caller's own bucket writer — each surface refreshes its own state
 * around `transitionApplicationBucket` — and returns the transition result.
 */
export async function declineApplicationWithUndo(args: {
  row: Pick<DemoApplicantRow, "id" | "bucket" | "name" | "email">;
  run: (id: string, next: ManagerApplicationBucket) => Promise<ApplicationBucketTransition | null>;
  showToast: (message: string, options?: { undo?: () => void | Promise<void> }) => void;
  /** Called after a decline (or its undo) was accepted, so the caller can refresh or navigate. */
  onChanged?: (event: "declined" | "restored") => void;
}): Promise<boolean> {
  const { row, run, showToast, onChanged } = args;
  const previous: ManagerApplicationBucket = row.bucket === "approved" ? "approved" : "pending";
  const who = row.name?.trim() || row.email?.trim() || "Application";
  const result = await run(row.id, "rejected");
  if (!result || result.blocked) {
    showToast(result?.message ?? "Application could not be declined.");
    return false;
  }
  showToast(`Declined · ${who}`, {
    undo: async () => {
      const restored = await run(row.id, previous);
      if (!restored || restored.blocked) {
        showToast(restored?.message ?? "Application could not be restored.");
        return;
      }
      showToast(`Restored · ${who}`);
      onChanged?.("restored");
    },
  });
  onChanged?.("declined");
  return true;
}
