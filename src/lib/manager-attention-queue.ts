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
  } = input;
  const rows: ManagerAttentionRow[] = [];
  if (overdueChargeCount > 0) {
    rows.push({
      id: "overdue",
      title: `${overdueChargeCount} overdue ${overdueChargeCount === 1 ? "charge" : "charges"} · ${overdueBalanceLabel}`,
      actionLabel: "Remind",
      href: `${BASE}/payments/incoming/overdue`,
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
