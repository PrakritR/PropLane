"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RESIDENT_INBOX_THREAD_FALLBACK } from "@/components/portal/resident-inbox-panel";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { readInboxMessages } from "@/lib/demo-admin-partner-inbox";
import {
  readPartnerInquiries,
  syncScheduleRecordsFromServer,
} from "@/lib/demo-admin-scheduling";
import { ADMIN_UI_EVENT } from "@/lib/demo-admin-ui";
import { PROPERTY_PIPELINE_EVENT } from "@/lib/demo-property-pipeline";
import {
  applicationVisibleToPortalUser,
  moduleRowVisibleToPortalUser,
} from "@/lib/manager-portfolio-access";
import {
  isInProgressApplicationRow,
  isSubmittedPendingApplicationRow,
} from "@/lib/rental-application/in-progress-application";
import { applicationsForResidentEmail } from "@/lib/rental-application/application-policy";
import {
  approvedApplicationAxisIdForResidentEmail,
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
} from "@/lib/manager-applications-storage";
import {
  MANAGER_WORK_ORDERS_EVENT,
  readManagerWorkOrderRows,
} from "@/lib/manager-work-orders-storage";
import {
  readAllServiceRequests,
  SERVICE_REQUESTS_EVENT,
} from "@/lib/service-requests-storage";
import { countVisibleUnreadCommunication } from "@/lib/communication-inbox-filters";
import { countUnreadActiveConversations } from "@/lib/communication-active-rows";
import { loadManagerSmsArchivedIds, MANAGER_SMS_ARCHIVE_CHANGED_EVENT } from "@/lib/manager-sms-archive.client";
import { loadManagerSmsConversationsClient } from "@/lib/manager-sms-conversations-client";
import {
  loadManagerSmsOpenedIds,
  MANAGER_SMS_OPENED_CHANGED_EVENT,
} from "@/lib/manager-sms-opened.client";
import {
  MANAGER_SMS_CONTACTS_CHANGED_EVENT,
  normalizeManagerSmsConversationsPayload,
  type ManagerSmsResidentConversation,
} from "@/lib/manager-sms-messages";
import { loadSmsHiddenIds } from "@/lib/manager-sms-hidden.client";
import { pollShouldHaltAfterStatus } from "@/lib/poll-halt";
import {
  loadPersistedInbox,
  MANAGER_INBOX_STORAGE_KEY,
  PORTAL_INBOX_CHANGED_EVENT,
  RESIDENT_INBOX_STORAGE_KEY,
} from "@/lib/portal-inbox-storage";
import { readBugFeedbackRows } from "@/lib/portal-bug-feedback";
import { prefetchPortalData } from "@/lib/portal-data-store";
import type { PortalKind } from "@/lib/portal-types";
import { managerPaymentBucketCounts, readManagerPaymentsLedgerCharges } from "@/lib/manager-payments-scope";
import { PAYMENT_AUTOMATION_SETTINGS_EVENT } from "@/lib/payment-automation-settings";
import { MANAGER_TASKS_EVENT, readManagerTasksLocal } from "@/lib/manager-tasks";
import { isManagerTaskLate } from "@/lib/manager-task-display";
import { buildManagerTourRows, countManagerTourRowsByBucket } from "@/lib/manager-tour-list";
import {
  countManagerLeaseTabs,
  findLeaseForResidentEmail,
  LEASE_PIPELINE_EVENT,
  readLeasePipeline,
} from "@/lib/lease-pipeline-storage";
import {
  HOUSEHOLD_CHARGES_EVENT,
  householdChargeManagerBucket,
  readChargesForResident,
} from "@/lib/household-charges";
import {
  WORKSPACE_SELECTION_EVENT,
  activeWorkspaceIdentity,
  workspaceContainsProperty,
  workspacePropertyIdFromRow,
} from "@/lib/workspaces/selection";

/** A count that must never take the sidebar down with it — a half-migrated mirror reads as 0. */
function safeCount(read: () => number): number {
  try {
    return read();
  } catch {
    return 0;
  }
}

export type PortalNavCountState = { count: number; tone: "muted" | "alert" };

/** Same fail-safe as `safeCount`, for a computation that also decides tone. */
function safeState(read: () => PortalNavCountState): PortalNavCountState {
  try {
    return read();
  } catch {
    return { count: 0, tone: "muted" };
  }
}

function countState(count: number, tone: "muted" | "alert" = "muted"): PortalNavCountState {
  return { count, tone };
}

/**
 * To-do counts for sidebar nav badges (0 = hide badge). Every count is read
 * from the same local mirror the destination page renders its own tab counts
 * from, so the nav can never disagree with the page. `tone` says how the
 * badge should render: `"alert"` (blue pill) for unread mail or an overdue
 * item, `"muted"` (quiet number) for ordinary pending work.
 */
export function usePortalNavCounts(
  kind: PortalKind,
  smsUiEnabled = false,
): Partial<Record<string, PortalNavCountState>> {
  const { userId, email, ready } = useManagerUserId();
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (kind === "admin") {
      void syncScheduleRecordsFromServer().then(() => bump());
    } else if (kind === "manager" || kind === "pro") {
      void prefetchPortalData(kind, userId ?? undefined)
        .then(() => bump())
        .catch(() => {});
    } else if (kind === "resident") {
      void prefetchPortalData(kind)
        .then(() => bump())
        .catch(() => {});
    }

    window.addEventListener(PROPERTY_PIPELINE_EVENT, bump);
    window.addEventListener(ADMIN_UI_EVENT, bump);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, bump);
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
    window.addEventListener(SERVICE_REQUESTS_EVENT, bump);
    window.addEventListener(MANAGER_TASKS_EVENT, bump);
    window.addEventListener(LEASE_PIPELINE_EVENT, bump);
    window.addEventListener(HOUSEHOLD_CHARGES_EVENT, bump);
    window.addEventListener(WORKSPACE_SELECTION_EVENT, bump);
    window.addEventListener(PORTAL_INBOX_CHANGED_EVENT, bump);
    window.addEventListener(MANAGER_SMS_ARCHIVE_CHANGED_EVENT, bump);
    window.addEventListener(PAYMENT_AUTOMATION_SETTINGS_EVENT, bump);
    window.addEventListener(MANAGER_SMS_CONTACTS_CHANGED_EVENT, bump);
    window.addEventListener(MANAGER_SMS_OPENED_CHANGED_EVENT, bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener(MANAGER_TASKS_EVENT, bump);
      window.removeEventListener(LEASE_PIPELINE_EVENT, bump);
      window.removeEventListener(HOUSEHOLD_CHARGES_EVENT, bump);
      window.removeEventListener(WORKSPACE_SELECTION_EVENT, bump);
      window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, bump);
      window.removeEventListener(MANAGER_SMS_ARCHIVE_CHANGED_EVENT, bump);
      window.removeEventListener(PAYMENT_AUTOMATION_SETTINGS_EVENT, bump);
      window.removeEventListener(MANAGER_SMS_CONTACTS_CHANGED_EVENT, bump);
      window.removeEventListener(MANAGER_SMS_OPENED_CHANGED_EVENT, bump);
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, bump);
      window.removeEventListener(ADMIN_UI_EVENT, bump);
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, bump);
      window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
      window.removeEventListener(SERVICE_REQUESTS_EVENT, bump);
      window.removeEventListener("storage", bump);
    };
  }, [kind, bump, userId]);

  // The Communication badge needs every SMS conversation (not just its own
  // localStorage-backed read state) to match Active exactly once a person
  // reaches the manager on both channels. Loaded into real state — unlike
  // every other input here, this ships an actual request — through the same
  // reader `pro-unified-inbox.tsx` uses, so a concurrent load never doubles
  // the request. The shared reader only coalesces in-flight calls (no TTL), so
  // this poll is a real request on every portal page: it runs at 60s, a third
  // of the Communication page's own cadence, and leans on the opened / archive
  // / contacts events (plus refocus) for immediacy. Egress is a constraint.
  const [smsConversations, setSmsConversations] = useState<ManagerSmsResidentConversation[]>([]);
  useEffect(() => {
    if (!(kind === "manager" || kind === "pro") || !smsUiEnabled || !userId) {
      setSmsConversations([]);
      return;
    }
    let cancelled = false;
    let halted = false;
    const load = async () => {
      if (halted) return;
      try {
        const res = await loadManagerSmsConversationsClient(userId);
        if (cancelled) return;
        if (pollShouldHaltAfterStatus(res.status)) {
          halted = true;
          return;
        }
        if (!res.ok) return;
        const body = (await res.json()) as { residents?: ManagerSmsResidentConversation[] };
        if (cancelled || !body || !Array.isArray(body.residents)) return;
        setSmsConversations(normalizeManagerSmsConversationsPayload(body).residents);
      } catch {
        /* keep the last good conversations */
      }
    };
    void load();
    const onRefresh = () => void load();
    window.addEventListener(MANAGER_SMS_CONTACTS_CHANGED_EVENT, onRefresh);
    window.addEventListener(MANAGER_SMS_ARCHIVE_CHANGED_EVENT, onRefresh);
    window.addEventListener(MANAGER_SMS_OPENED_CHANGED_EVENT, onRefresh);
    const tickPoll = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load();
    };
    const id = window.setInterval(tickPoll, 60_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.removeEventListener(MANAGER_SMS_CONTACTS_CHANGED_EVENT, onRefresh);
      window.removeEventListener(MANAGER_SMS_ARCHIVE_CHANGED_EVENT, onRefresh);
      window.removeEventListener(MANAGER_SMS_OPENED_CHANGED_EVENT, onRefresh);
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [kind, smsUiEnabled, userId]);

  return useMemo(() => {
    void tick;
    if (!ready && (kind === "manager" || kind === "pro" || kind === "resident")) {
      return {};
    }

    if (kind === "admin") {
      const inboxUnread = readInboxMessages().filter((m) => m.folder === "inbox" && !m.read).length;
      const pendingMeetings = readPartnerInquiries().filter((r) => r.status === "pending" && r.kind !== "tour").length;
      const pendingTours = readPartnerInquiries().filter((r) => r.kind === "tour" && r.status === "pending").length;
      const openFeedback = readBugFeedbackRows().filter((r) => r.status === "open" || r.status === "in_progress").length;
      return {
        events: countState(pendingMeetings + pendingTours),
        communication: countState(inboxUnread, "alert"),
        "bugs-feedback": countState(openFeedback),
      };
    }

    if ((kind === "manager" || kind === "pro") && userId) {
      const pendingApps = readManagerApplicationRows().filter(
        (a) =>
          applicationVisibleToPortalUser(a, userId) &&
          isSubmittedPendingApplicationRow(a) &&
          workspaceContainsProperty(workspacePropertyIdFromRow(a) ?? undefined),
      ).length;
      const pendingServiceRequests = readAllServiceRequests().filter(
        (r) =>
          moduleRowVisibleToPortalUser(r, userId, "services") &&
          r.status === "pending" &&
          workspaceContainsProperty(r.propertyId),
      ).length;
      const pendingWorkOrders = readManagerWorkOrderRows().filter(
        (w) => moduleRowVisibleToPortalUser(w, userId, "services") && w.bucket === "open",
      ).length;
      // SMS-aware once the SMS Communication UI is on, so a person reached on
      // both channels merges into one Active row exactly as the list does —
      // matching `countVisibleUnreadCommunication` exactly when it is off,
      // since `countUnreadActiveConversations` ignores `smsConversations`
      // (never loaded) in that case.
      const inbox = safeCount(() =>
        countUnreadActiveConversations(loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []), {
          portal: "manager",
          viewerId: userId,
          workspace: activeWorkspaceIdentity(),
          archivedSmsIds: loadManagerSmsArchivedIds(),
          smsUiEnabled,
          smsConversations,
          smsOpenedIds: loadManagerSmsOpenedIds(userId),
          smsHiddenIds: loadSmsHiddenIds(),
          smsArchivedIds: loadManagerSmsArchivedIds(),
        }),
      );
      // The same numbers the list tabs render — Tours' Pending tab, Payments'
      // Overdue tab, Leases' Resident + Signed tabs, Tasks' Open tab — read
      // from the same local mirrors, so the nav can never disagree with the
      // page. Narrowed to the active workspace, like the Properties page
      // itself; the plan meter on that page stays account-wide because the
      // plan is. Properties itself is inventory, not a to-do, so it carries no
      // badge.
      const tours = safeCount(
        () =>
          countManagerTourRowsByBucket(
            // Same scope as the Tours page: the workspace, not the property
            // filter options, so the badge and the tab can never disagree.
            buildManagerTourRows({ viewerUserId: userId, propertyIds: null }).filter((row) =>
              workspaceContainsProperty(row.propertyId),
            ),
          ).pending,
      );
      // Overdue only — a charge not yet due is the normal state of the month,
      // not a to-do (PLAN-0921-0001 decision 2). Any positive count here is by
      // definition late, so the badge is always the alert pill.
      const paymentsOverdue = safeCount(
        () => managerPaymentBucketCounts(readManagerPaymentsLedgerCharges(userId)).overdue,
      );
      const openTasks = safeCount(
        () =>
          readManagerTasksLocal(userId).filter(
            (t) => !t.completed && workspaceContainsProperty(t.propertyId?.trim() || undefined),
          ).length,
      );
      const tasksOverdue = safeCount(
        () =>
          readManagerTasksLocal(userId).filter(
            (t) =>
              !t.completed &&
              workspaceContainsProperty(t.propertyId?.trim() || undefined) &&
              isManagerTaskLate(t),
          ).length,
      );
      const leaseTabs = safeState(() => {
        const tabs = countManagerLeaseTabs(readLeasePipeline(userId));
        return countState(tabs.resident + tabs.signed, "muted");
      });
      return {
        tours: countState(tours),
        applications: countState(pendingApps),
        leases: leaseTabs,
        payments: countState(paymentsOverdue, paymentsOverdue > 0 ? "alert" : "muted"),
        tasks: countState(openTasks, tasksOverdue > 0 ? "alert" : "muted"),
        services: countState(pendingServiceRequests + pendingWorkOrders),
        communication: countState(inbox, "alert"),
      };
    }

    if (kind === "resident") {
      const inbox = safeCount(() =>
        countVisibleUnreadCommunication(
          loadPersistedInbox(RESIDENT_INBOX_STORAGE_KEY, RESIDENT_INBOX_THREAD_FALLBACK),
          { portal: "resident", viewerId: userId, smsUiEnabled: false },
        ),
      );
      const residentEmail = email ?? "";
      const applications = safeCount(
        () => applicationsForResidentEmail(residentEmail).filter(isInProgressApplicationRow).length,
      );
      const lease = safeState(() => {
        const axisId = approvedApplicationAxisIdForResidentEmail(residentEmail);
        const row = findLeaseForResidentEmail(residentEmail, { residentAxisId: axisId });
        const pending = row?.bucket === "resident" && row.status === "Resident Signature Pending";
        return countState(pending ? 1 : 0, "muted");
      });
      const payments = safeState(() => {
        const buckets = readChargesForResident(residentEmail, userId).map((c) => householdChargeManagerBucket(c));
        const count = buckets.filter((b) => b !== "paid").length;
        const overdue = buckets.some((b) => b === "overdue");
        return countState(count, overdue ? "alert" : "muted");
      });
      return {
        applications: countState(applications, "muted"),
        lease,
        payments,
        communication: countState(inbox, "alert"),
      };
    }

    return {};
  }, [kind, ready, tick, userId, email, smsUiEnabled, smsConversations]);
}
