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
  detail: string;
  actionLabel: "Review" | "Approve" | "Remind" | "Set up" | "Sign" | "Confirm" | "Continue" | "Reply";
  href: string;
  tone: "danger" | "pending" | "info";
};

export type ManagerAttentionInput = {
  basePath: string;
  overdueChargeCount: number;
  overdueBalanceLabel: string;
  pendingApplicationCount: number;
  latestPendingApplicationProperty?: string | null;
  managerSignatureLeaseCount: number;
  pendingTourCount: number;
  messagingNeedsSetup: boolean;
  messagingSettingsHref: string;
  draftPropertyCount: number;
  draftsHref: string;
  unreadConversationCount: number;
  latestUnreadSubject?: string | null;
};

export const MANAGER_ATTENTION_MAX_ROWS = 6;

export function buildManagerAttentionRows(input: ManagerAttentionInput): ManagerAttentionRow[] {
  const {
    basePath: BASE,
    overdueChargeCount,
    overdueBalanceLabel,
    pendingApplicationCount,
    latestPendingApplicationProperty,
    managerSignatureLeaseCount,
    pendingTourCount,
    messagingNeedsSetup,
    messagingSettingsHref,
    draftPropertyCount,
    draftsHref,
    unreadConversationCount,
    latestUnreadSubject,
  } = input;
  const rows: ManagerAttentionRow[] = [];
  if (overdueChargeCount > 0) {
    rows.push({
      id: "overdue",
      title: `${overdueChargeCount} overdue ${overdueChargeCount === 1 ? "charge" : "charges"}`,
      detail: `${overdueBalanceLabel} past due across your residents`,
      actionLabel: "Remind",
      href: `${BASE}/payments/incoming/overdue`,
      tone: "danger",
    });
  }
  if (pendingApplicationCount > 0) {
    rows.push({
      id: "applications",
      title: `${pendingApplicationCount} ${pendingApplicationCount === 1 ? "application" : "applications"} ready for review`,
      detail: latestPendingApplicationProperty
        ? `Latest for ${latestPendingApplicationProperty}`
        : "Waiting for your decision",
      actionLabel: "Review",
      href: `${BASE}/applications/pending`,
      tone: "pending",
    });
  }
  if (managerSignatureLeaseCount > 0) {
    rows.push({
      id: "leases",
      title: `${managerSignatureLeaseCount} ${managerSignatureLeaseCount === 1 ? "lease waits" : "leases wait"} for your signature`,
      detail: "Residents have signed; countersign to make them official",
      actionLabel: "Sign",
      href: `${BASE}/leases/manager`,
      tone: "pending",
    });
  }
  if (pendingTourCount > 0) {
    rows.push({
      id: "tours",
      title: `${pendingTourCount} tour ${pendingTourCount === 1 ? "request" : "requests"} to confirm`,
      detail: "Confirm a time so the guest gets their reminder",
      actionLabel: "Confirm",
      href: `${BASE}/tours/pending`,
      tone: "pending",
    });
  }
  if (messagingNeedsSetup) {
    rows.push({
      id: "messaging",
      title: "Renters can't text you yet",
      detail: "Set up messaging to open the SMS channel on your listings",
      actionLabel: "Set up",
      href: messagingSettingsHref,
      tone: "info",
    });
  }
  if (draftPropertyCount > 0) {
    rows.push({
      id: "drafts",
      title: `${draftPropertyCount} ${draftPropertyCount === 1 ? "property" : "properties"} still in setup`,
      detail: "Pick up where you left off",
      actionLabel: "Continue",
      href: draftsHref,
      tone: "info",
    });
  }
  if (unreadConversationCount > 0) {
    rows.push({
      id: "inbox",
      title: `${unreadConversationCount} unread ${unreadConversationCount === 1 ? "conversation" : "conversations"}`,
      detail: latestUnreadSubject ? `Latest: ${latestUnreadSubject}` : "Waiting for a reply",
      actionLabel: "Reply",
      href: `${BASE}/communication/active`,
      tone: "info",
    });
  }
  return rows;
}
