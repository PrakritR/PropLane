"use client";

import { useEffect, useMemo, useState } from "react";

import { readPortfolioSnapshot } from "@/components/portal/pro-dashboard-portfolio";
import { useManagerMessagingNumberStatus } from "@/hooks/use-manager-messaging-number-status";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { getPartnerInquiryWindows, readPartnerInquiries } from "@/lib/demo-admin-scheduling";
import { ADMIN_UI_EVENT } from "@/lib/demo-admin-ui";
import { PROPERTY_PIPELINE_EVENT } from "@/lib/demo-property-pipeline";
import { HOUSEHOLD_CHARGES_EVENT, householdChargeManagerBucket } from "@/lib/household-charges";
import { LEASE_PIPELINE_EVENT, readLeasePipeline } from "@/lib/lease-pipeline-storage";
import { MANAGER_APPLICATIONS_EVENT, readManagerApplicationRows } from "@/lib/manager-applications-storage";
import {
  MANAGER_ATTENTION_MAX_ROWS,
  buildManagerAttentionRows,
  type ManagerAttentionRow,
} from "@/lib/manager-attention-queue";
import { readManagerPaymentsLedgerCharges, unpaidManagerPaymentCharges } from "@/lib/manager-payments-scope";
import { applicationVisibleToPortalUser } from "@/lib/manager-portfolio-access";
import { propertyListHref } from "@/lib/portal-detail-routes";
import {
  MANAGER_INBOX_STORAGE_KEY,
  PORTAL_INBOX_CHANGED_EVENT,
  countUnopenedPersistedInbox,
  loadPersistedInbox,
} from "@/lib/portal-inbox-storage";
import { parseMoneyLabel } from "@/lib/portal-monthly-profit";
import { isSubmittedPendingApplicationRow } from "@/lib/rental-application/in-progress-application";
import { MANAGER_MESSAGING_SETTINGS_HREF } from "@/lib/sms/manager-messaging-number";

/**
 * Every read here is guarded: the assistant mounts on every portal page, and a
 * unit test of one page mocks one store with only the exports that page needs.
 * A missing export must cost that test an empty queue, not a crashed module.
 */
function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function storeEvents(): string[] {
  return [
    safe(() => PROPERTY_PIPELINE_EVENT, ""),
    safe(() => LEASE_PIPELINE_EVENT, ""),
    safe(() => MANAGER_APPLICATIONS_EVENT, ""),
    safe(() => HOUSEHOLD_CHARGES_EVENT, ""),
    safe(() => ADMIN_UI_EVENT, ""),
    safe(() => PORTAL_INBOX_CHANGED_EVENT, ""),
    "storage",
  ].filter(Boolean);
}

function formatUsd(amount: number): string {
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

/**
 * The dashboard's Needs-attention rows, read from the same client stores the
 * dashboard reads, for a surface that is not the dashboard (the assistant's
 * empty state). It reads what the app already holds and re-reads on every
 * store change; it does not start its own server syncs — the portal pages do.
 */
export function useManagerAttentionQueue(basePath = "/portal"): {
  rows: ManagerAttentionRow[];
  ready: boolean;
} {
  const { userId, ready } = useManagerUserId();
  const messaging = useManagerMessagingNumberStatus();
  const messagingNeedsSetup =
    messaging.resolved &&
    !messaging.statusError &&
    !!messaging.status &&
    !messaging.status.number?.phoneNumber &&
    messaging.status.planTier !== "free";
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const bump = () => setTick((n) => n + 1);
    const events = storeEvents();
    for (const name of events) window.addEventListener(name, bump);
    return () => {
      for (const name of events) window.removeEventListener(name, bump);
    };
  }, []);

  const rows = useMemo((): ManagerAttentionRow[] => {
    void tick;
    if (!ready || !userId) return [];
    const pendingApps = safe(
      () =>
        readManagerApplicationRows().filter(
          (a) => applicationVisibleToPortalUser(a, userId) && isSubmittedPendingApplicationRow(a),
        ),
      [],
    );
    const managerSignatureLeaseCount = safe(
      () => readLeasePipeline(userId).filter((l) => l.status === "Manager Signature Pending").length,
      0,
    );
    const overdueCharges = safe(
      () =>
        unpaidManagerPaymentCharges(readManagerPaymentsLedgerCharges(userId)).filter(
          (c) => householdChargeManagerBucket(c) === "overdue",
        ),
      [],
    );
    // One row per requested window, the way the dashboard's Upcoming list
    // counts them.
    const pendingTourCount = safe(
      () =>
        readPartnerInquiries()
          .filter((r) => r.kind === "tour" && r.status === "pending" && r.managerUserId === userId)
          .reduce((sum, r) => sum + getPartnerInquiryWindows(r).length, 0),
      0,
    );
    const inboxThreads = safe(
      () => loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []).filter((t) => t.folder === "inbox" && t.unread),
      [],
    );
    return buildManagerAttentionRows({
      basePath,
      overdueChargeCount: overdueCharges.length,
      overdueBalanceLabel: formatUsd(
        overdueCharges.reduce((sum, c) => sum + safe(() => parseMoneyLabel(c.balanceLabel), 0), 0),
      ),
      pendingApplicationCount: pendingApps.length,
      latestPendingApplicationProperty: pendingApps[0]?.property,
      managerSignatureLeaseCount,
      pendingTourCount,
      messagingNeedsSetup,
      messagingSettingsHref: safe(() => MANAGER_MESSAGING_SETTINGS_HREF, `${basePath}/settings/messaging`),
      draftPropertyCount: safe(() => readPortfolioSnapshot(userId).draftCount, 0),
      draftsHref: safe(() => propertyListHref(basePath, "drafts"), `${basePath}/properties/drafts`),
      unreadConversationCount: safe(() => countUnopenedPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []), 0),
      latestUnreadSubject: inboxThreads[0]?.subject,
    }).slice(0, MANAGER_ATTENTION_MAX_ROWS);
  }, [basePath, messagingNeedsSetup, ready, tick, userId]);

  return { rows, ready: ready && Boolean(userId) };
}
