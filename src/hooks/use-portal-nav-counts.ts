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
import { isSubmittedPendingApplicationRow } from "@/lib/rental-application/in-progress-application";
import {
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
import {
  loadPersistedInbox,
  MANAGER_INBOX_STORAGE_KEY,
  RESIDENT_INBOX_STORAGE_KEY,
} from "@/lib/portal-inbox-storage";
import { readBugFeedbackRows } from "@/lib/portal-bug-feedback";
import { prefetchPortalData } from "@/lib/portal-data-store";
import type { PortalKind } from "@/lib/portal-types";
import { countManagerManagedPropertiesForUser } from "@/lib/demo-property-pipeline";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import { managerPaymentBucketCounts, readManagerPaymentsLedgerCharges } from "@/lib/manager-payments-scope";
import { MANAGER_TASKS_EVENT, readManagerTasksLocal } from "@/lib/manager-tasks";
import { buildManagerTourRows, countManagerTourRowsByBucket } from "@/lib/manager-tour-list";

/**
 * Unread Communication conversations for the nav badge.
 *
 * Deliberately does NOT drop SMS-like rows. Communication is one section that
 * owns both the conversation list and the SMS panel, and while the SMS UI is
 * hidden an inbound-SMS notice falls through into the conversation list
 * (`keepSmsLike` in `filterEmailInboxThreads`). This hook is a client hook with
 * no access to the server-resolved `smsUiEnabled` flag, so counting every
 * unread inbox row is the only way the badge can never disagree with the list.
 */
function countUnreadCommunication(rows: { folder?: string; unread?: boolean }[]): number {
  return rows.filter((t) => t.folder === "inbox" && t.unread).length;
}

/** A count that must never take the sidebar down with it — a half-migrated mirror reads as 0. */
function safeCount(read: () => number): number {
  try {
    return read();
  } catch {
    return 0;
  }
}

/** Pending / unread counts for sidebar nav badges (0 = hide badge). */
export function usePortalNavCounts(kind: PortalKind): Partial<Record<string, number>> {
  const { userId, ready } = useManagerUserId();
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
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener(MANAGER_TASKS_EVENT, bump);
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, bump);
      window.removeEventListener(ADMIN_UI_EVENT, bump);
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, bump);
      window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
      window.removeEventListener(SERVICE_REQUESTS_EVENT, bump);
      window.removeEventListener("storage", bump);
    };
  }, [kind, bump, userId]);

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
        events: pendingMeetings + pendingTours,
        communication: inboxUnread,
        "bugs-feedback": openFeedback,
      };
    }

    if ((kind === "manager" || kind === "pro") && userId) {
      const pendingApps = readManagerApplicationRows().filter(
        (a) => applicationVisibleToPortalUser(a, userId) && isSubmittedPendingApplicationRow(a),
      ).length;
      const pendingServiceRequests = readAllServiceRequests().filter(
        (r) => moduleRowVisibleToPortalUser(r, userId, "services") && r.status === "pending",
      ).length;
      const pendingWorkOrders = readManagerWorkOrderRows().filter(
        (w) => moduleRowVisibleToPortalUser(w, userId, "services") && w.bucket === "open",
      ).length;
      const inbox = countUnreadCommunication(loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []));
      // The same numbers the list tabs render — Properties' plan meter, Tours'
      // Pending tab, Payments' Pending + Overdue, Tasks' Open — read from the
      // same local mirrors, so the nav can never disagree with the page.
      const properties = safeCount(() => countManagerManagedPropertiesForUser(userId));
      const tours = safeCount(
        () =>
          countManagerTourRowsByBucket(
            buildManagerTourRows({
              viewerUserId: userId,
              propertyIds: buildManagerPropertyFilterOptions(userId).map((o) => o.id),
            }),
          ).pending,
      );
      const payments = safeCount(() => {
        const c = managerPaymentBucketCounts(readManagerPaymentsLedgerCharges(userId));
        return c.pending + c.overdue;
      });
      const tasks = safeCount(() => readManagerTasksLocal(userId).filter((t) => !t.completed).length);
      return {
        properties,
        tours,
        applications: pendingApps,
        payments,
        tasks,
        services: pendingServiceRequests + pendingWorkOrders,
        communication: inbox,
      };
    }

    if (kind === "resident") {
      const inbox = countUnreadCommunication(
        loadPersistedInbox(RESIDENT_INBOX_STORAGE_KEY, RESIDENT_INBOX_THREAD_FALLBACK),
      );
      return { communication: inbox };
    }

    return {};
  }, [kind, ready, tick, userId]);
}
