/**
 * The manager's "Needs attention" queue — every kind of thing waiting on them,
 * in priority order: money owed, decisions, signatures, tours, setup, then
 * unread mail. The dashboard panel and the assistant's empty state both render
 * this list, so a row can never say one thing on one surface and another on
 * the other.
 */

export type ManagerAttentionRow = {
  id: string;
  title: string;
  /** Optional; the manager queue is title and action only (no muted sentence under a row). */
  detail?: string;
  actionLabel: "Review" | "Approve" | "Remind" | "Set up" | "Sign" | "Confirm" | "Continue" | "Reply" | "Verify phone";
  /** The action is a compact icon (the label is its tooltip and aria-label), for a row that is a one-step chore. */
  iconAction?: boolean;
  href: string;
  tone: "danger" | "pending" | "info";
};

export type ManagerAttentionInput = {
  basePath: string;
  overdueChargeCount: number;
  overdueBalanceLabel: string;
  pendingApplicationCount: number;
  managerSignatureLeaseCount: number;
  pendingTourCount: number;
  messagingNeedsSetup: boolean;
  messagingSettingsHref: string;
  draftPropertyCount: number;
  draftsHref: string;
  unreadConversationCount: number;
  /** Conversations whose latest outbound message failed on every channel (`latestOutboundDeliveryFailed`). */
  undeliveredConversationCount?: number;
  /** Residents who used the in-app assistant to ask for the manager and have not been read (`countResidentHandoffs`). */
  residentHandoffCount?: number;
  /** Signed leases whose resident has never been billed rent (`leasesWithoutRentCharges`): money silently not flowing. */
  unbilledResidencyCount?: number;
};

export const MANAGER_ATTENTION_MAX_ROWS = 6;

export function buildManagerAttentionRows(input: ManagerAttentionInput): ManagerAttentionRow[] {
  const {
    basePath: BASE,
    overdueChargeCount,
    overdueBalanceLabel,
    pendingApplicationCount,
    managerSignatureLeaseCount,
    pendingTourCount,
    messagingNeedsSetup,
    messagingSettingsHref,
    draftPropertyCount,
    draftsHref,
    unreadConversationCount,
    undeliveredConversationCount = 0,
    residentHandoffCount = 0,
    unbilledResidencyCount = 0,
  } = input;
  const rows: ManagerAttentionRow[] = [];
  if (undeliveredConversationCount > 0) {
    rows.push({
      id: "undelivered",
      title: `${undeliveredConversationCount} ${undeliveredConversationCount === 1 ? "message" : "messages"} didn't deliver`,
      actionLabel: "Review",
      href: `${BASE}/communication/active?filter=not-delivered`,
      tone: "danger",
    });
  }
  if (overdueChargeCount > 0) {
    rows.push({
      id: "overdue",
      title: `${overdueChargeCount} overdue ${overdueChargeCount === 1 ? "charge" : "charges"} · ${overdueBalanceLabel}`,
      actionLabel: "Remind",
      href: `${BASE}/payments/incoming/overdue`,
      tone: "danger",
    });
  }
  if (unbilledResidencyCount > 0) {
    rows.push({
      id: "unbilled-residency",
      title: `${unbilledResidencyCount} signed ${unbilledResidencyCount === 1 ? "lease has" : "leases have"} no rent charged`,
      actionLabel: "Review",
      href: `${BASE}/payments/incoming/pending`,
      tone: "danger",
    });
  }
  if (pendingApplicationCount > 0) {
    rows.push({
      id: "applications",
      title: `${pendingApplicationCount} ${pendingApplicationCount === 1 ? "application" : "applications"} ready for review`,
      actionLabel: "Review",
      href: `${BASE}/applications/pending`,
      tone: "pending",
    });
  }
  if (managerSignatureLeaseCount > 0) {
    rows.push({
      id: "leases",
      title: `${managerSignatureLeaseCount} ${managerSignatureLeaseCount === 1 ? "lease waits" : "leases wait"} for your signature`,
      actionLabel: "Sign",
      href: `${BASE}/leases/manager`,
      tone: "pending",
    });
  }
  if (pendingTourCount > 0) {
    rows.push({
      id: "tours",
      title: `${pendingTourCount} tour ${pendingTourCount === 1 ? "request" : "requests"} to confirm`,
      actionLabel: "Confirm",
      href: `${BASE}/tours/pending`,
      tone: "pending",
    });
  }
  if (residentHandoffCount > 0) {
    rows.push({
      id: "resident-handoff",
      title: residentHandoffCount === 1 ? "Resident asked for you" : `${residentHandoffCount} residents asked for you`,
      actionLabel: "Reply",
      href: `${BASE}/communication/active`,
      tone: "pending",
    });
  }
  if (messagingNeedsSetup) {
    rows.push({
      id: "messaging",
      title: "Phone number not set up",
      actionLabel: "Set up",
      href: messagingSettingsHref,
      tone: "info",
    });
  }
  if (draftPropertyCount > 0) {
    rows.push({
      id: "drafts",
      title: `${draftPropertyCount} ${draftPropertyCount === 1 ? "property" : "properties"} still in setup`,
      actionLabel: "Continue",
      href: draftsHref,
      tone: "info",
    });
  }
  if (unreadConversationCount > 0) {
    rows.push({
      id: "inbox",
      title: `${unreadConversationCount} unread ${unreadConversationCount === 1 ? "conversation" : "conversations"}`,
      actionLabel: "Reply",
      href: `${BASE}/communication/active`,
      tone: "info",
    });
  }
  return rows;
}
