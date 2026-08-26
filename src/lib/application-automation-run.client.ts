/**
 * Runs the manager's enabled post-approval automation: generate the lease, then send it.
 *
 * Lives on the client for the same reason approval-time charge generation does — lease generation
 * reads the manager's local listing catalog (`generateLeaseHtmlForRow` → `leaseGenerationContextForRow`),
 * so there is no server-side equivalent to call. That means automation runs when the approving
 * manager's browser performs the approval, which is exactly when the manual buttons would have
 * been available. It is a click-remover, not a background worker.
 *
 * The ladder is strict and ordered: a send is attempted only when there is a document to send,
 * whether this run generated it or a previous one did. Each step consults `shouldAutomate`, so
 * every guard on the manual path — withdrawn application, `leaseSendGateBlocker`, demo mode —
 * still applies. Nothing here bypasses a gate; when one refuses, the step is skipped and the
 * reason is reported so the manager sees the same message the button would have shown.
 */
import {
  shouldAutomate,
  type ApplicationAutomationPreferences,
  type AutomationBlockedReason,
} from "@/lib/application-automation-preferences";
import {
  generateLeaseHtmlForRow,
  leaseLandlordNameBlocker,
  leaseSendGateBlocker,
  readLeasePipeline,
  sendLeaseToResident,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";

export type AutomationStepOutcome = {
  step: "generate" | "send";
  ran: boolean;
  /** Present when `ran` is false and the manager might want to know why. */
  reason?: AutomationBlockedReason;
  /** The gate's own message, or the failure returned by the underlying action. */
  detail?: string;
};

export type ApplicationAutomationResult = {
  leaseId: string | null;
  steps: AutomationStepOutcome[];
};

/** A row already carrying a document must not be regenerated — it may already be signed. */
function hasDocument(row: LeasePipelineRow | undefined): boolean {
  return Boolean(row?.generatedHtml || row?.managerUploadedPdf?.dataUrl);
}

/** A lease that has already gone out is not sent again. */
function alreadySent(row: LeasePipelineRow | undefined): boolean {
  return Boolean(row?.sentToResidentAt) || row?.status === "Resident Signature Pending";
}

/**
 * Find the lease row for a just-approved application. Approval creates it, so a miss here is a
 * timing or scoping problem rather than a reason to invent one — this never creates a row, and
 * returning null simply leaves the manager on the manual path.
 */
function leaseRowForApplication(
  applicationId: string,
  residentEmail: string,
  managerUserId: string | null,
): LeasePipelineRow | undefined {
  const rows = readLeasePipeline(managerUserId);
  const byApplication = rows.find(
    (r) => r.primaryApplicationId?.trim().toUpperCase() === applicationId.trim().toUpperCase(),
  );
  if (byApplication) return byApplication;
  const email = residentEmail.trim().toLowerCase();
  if (!email) return undefined;
  // Newest first: a resident who has rented before has older rows, and the lease this approval
  // just produced is the one to act on.
  return rows
    .filter((r) => r.residentEmail.trim().toLowerCase() === email)
    .sort((a, b) => (b.updatedAtIso ?? "").localeCompare(a.updatedAtIso ?? ""))[0];
}

export async function runPostApprovalAutomation(input: {
  applicationId: string;
  residentEmail: string;
  managerUserId: string | null;
  prefs: ApplicationAutomationPreferences;
  isDemo?: boolean;
  isWithdrawn?: boolean;
}): Promise<ApplicationAutomationResult> {
  const steps: AutomationStepOutcome[] = [];
  const { prefs, managerUserId, isDemo, isWithdrawn } = input;

  // Nothing enabled: do not even look up the row. Keeps a fully-manual manager's approval on
  // exactly the code path it took before this feature existed.
  if (!prefs.autoGenerateLease && !prefs.autoSendLease) return { leaseId: null, steps };

  let row = leaseRowForApplication(input.applicationId, input.residentEmail, managerUserId);
  if (!row) return { leaseId: null, steps };
  const leaseId = row.id;

  const generateDecision = shouldAutomate({
    enabled: prefs.autoGenerateLease,
    isDemo,
    isWithdrawn,
    alreadyDone: hasDocument(row),
  });
  if (generateDecision.run) {
    const res = generateLeaseHtmlForRow(leaseId, managerUserId);
    steps.push(
      res.ok
        ? { step: "generate", ran: true }
        : { step: "generate", ran: false, reason: "gate_blocked", detail: res.error },
    );
    // Re-read: the send gate below judges the row as it now stands, document included.
    row = readLeasePipeline(managerUserId).find((r) => r.id === leaseId) ?? row;
  } else {
    steps.push({ step: "generate", ran: false, reason: generateDecision.reason });
  }

  // A send needs a document. Without one there is nothing to send, and saying so is more useful
  // than reporting the send gate's opinion about an empty row.
  if (!hasDocument(row)) {
    if (prefs.autoSendLease) {
      steps.push({
        step: "send",
        ran: false,
        reason: "gate_blocked",
        detail: "No lease document to send yet.",
      });
    }
    return { leaseId, steps };
  }

  const sendDecision = shouldAutomate({
    enabled: prefs.autoSendLease,
    isDemo,
    isWithdrawn,
    alreadyDone: alreadySent(row),
    gateBlocker: leaseSendGateBlocker(row) ?? leaseLandlordNameBlocker(row),
  });
  if (!sendDecision.run) {
    steps.push({ step: "send", ran: false, reason: sendDecision.reason, detail: sendDecision.detail });
    return { leaseId, steps };
  }

  const sent = await sendLeaseToResident(leaseId, managerUserId);
  steps.push(
    sent.ok
      ? { step: "send", ran: true }
      : { step: "send", ran: false, reason: "gate_blocked", detail: sent.error },
  );
  return { leaseId, steps };
}
