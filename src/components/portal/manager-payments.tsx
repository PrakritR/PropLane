"use client";

import { isDemoModeActive } from "@/lib/demo/demo-session";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DestinationNav } from "@/components/ui/destination-nav";
import { PortalFilterSortSheet } from "@/components/portal/portal-filter-sort-sheet";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalActiveFilterChips, type PortalActiveFilterChip } from "@/components/portal/portal-filter-chips";
import { PaymentFilterSortFields } from "@/components/portal/payment-filter-sort-fields";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  ManagerPortalPageShell,
  PORTAL_HEADER_ACTION_BTN_RESPONSIVE,
  PORTAL_HEADER_PRIMARY_ACTION_BTN_RESPONSIVE,
} from "@/components/portal/portal-metrics";
import type { DemoManagerOutgoingPaymentRow, DemoManagerPaymentLedgerRow } from "@/data/demo-portal";
import { parseMoneyLabel } from "@/lib/portal-monthly-profit";
import { ManagerPaymentsLedgerPanel } from "@/components/portal/manager-payments-ledger-panel";
import { ManagerOutgoingPaymentsPanel } from "@/components/portal/manager-outgoing-payments-panel";
import { ManagerAddOutgoingPaymentModal } from "@/components/portal/manager-add-outgoing-payment-modal";
import type { ManagerPaymentBucket, ManagerPaymentDirection } from "@/data/demo-portal";
import {
  compareDueDateMs,
  householdChargeToLedgerRow,
  HOUSEHOLD_CHARGES_EVENT,
  readChargesForManager,
  reconcileApprovedResidentPaymentSchedules,
  removeResidentHouseholdPaymentData,
  syncHouseholdChargesFromServer,
} from "@/lib/household-charges";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { ManagerAddPaymentModal } from "@/components/portal/manager-add-payment-modal";
import { ManagerPaymentSetupModal } from "@/components/portal/manager-payment-setup-modal";
import { usePaidPortalBasePath } from "@/lib/portal-base-path-client";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import { applicationVisibleToPortalUser, buildManagerPropertyFilterOptions, collectLinkedPropertyIdsForModule } from "@/lib/manager-portfolio-access";
import { ledgerRoomNumberForApplication } from "@/lib/rental-application/data";
import { syncPropertyPipelineFromServer, readExtraListingsForUser } from "@/lib/demo-property-pipeline";
import { scopeChargesToManagerPaymentsLedger } from "@/lib/manager-payments-scope";
import {
  ReminderSettingsModal,
  useScheduledPaymentMessages,
} from "@/components/portal/payment-schedule-ui";
import { formatFriendlyReminderSchedule } from "@/lib/payment-reminder-presets";
import {
  buildManagerOutgoingPaymentRows,
  MANAGER_OUTGOING_PAYMENTS_EVENT,
  readManagerOutgoingExpenses,
  syncManagerOutgoingExpensesFromServer,
} from "@/lib/manager-outgoing-payments";
import {
  MANAGER_WORK_ORDERS_EVENT,
  readManagerWorkOrderRows,
  syncManagerWorkOrdersFromServer,
} from "@/lib/manager-work-orders-storage";
import {
  MANAGER_VENDORS_EVENT,
  readOwnActiveManagerVendorRows,
  syncManagerVendorsFromServer,
} from "@/lib/manager-vendors-storage";

const DIRECTION_LABELS: { id: ManagerPaymentDirection; label: string }[] = [
  { id: "incoming", label: "Incoming" },
  { id: "outgoing", label: "Outgoing" },
];

const PAY_LABELS: { id: ManagerPaymentBucket; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "overdue", label: "Overdue" },
  { id: "paid", label: "Paid" },
];

type PaymentListSort = "dueSoon" | "dueLatest" | "amountDesc" | "amountAsc" | "resident";

const DEFAULT_PAYMENT_LIST_SORT: PaymentListSort = "dueSoon";

function paymentFilterTouches(
  propertyFilters: string[],
  residentFilters: string[],
  listSort: PaymentListSort,
  direction: ManagerPaymentDirection,
): number {
  let count = 0;
  if (propertyFilters.length > 0) count += 1;
  if (residentFilters.length > 0) count += 1;
  if (listSort !== DEFAULT_PAYMENT_LIST_SORT) count += 1;
  return count;
}

function sortLedgerRows(
  rows: DemoManagerPaymentLedgerRow[],
  bucket: ManagerPaymentBucket,
  listSort: PaymentListSort,
): DemoManagerPaymentLedgerRow[] {
  const paid = bucket === "paid";
  return [...rows].sort((a, b) => {
    switch (listSort) {
      case "dueSoon": {
        const dir = paid ? "desc" : "asc";
        return compareDueDateMs(a.dueDateSortMs, b.dueDateSortMs, dir);
      }
      case "dueLatest": {
        const dir = paid ? "asc" : "desc";
        return compareDueDateMs(a.dueDateSortMs, b.dueDateSortMs, dir);
      }
      case "amountDesc":
        return parseMoneyLabel(b.balanceDue) - parseMoneyLabel(a.balanceDue);
      case "amountAsc":
        return parseMoneyLabel(a.balanceDue) - parseMoneyLabel(b.balanceDue);
      case "resident":
        return (a.residentName || "").localeCompare(b.residentName || "", undefined, { sensitivity: "base" });
      default:
        return 0;
    }
  });
}

function sortOutgoingRows(
  rows: DemoManagerOutgoingPaymentRow[],
  bucket: ManagerPaymentBucket,
  listSort: PaymentListSort,
): DemoManagerOutgoingPaymentRow[] {
  const paid = bucket === "paid";
  return [...rows].sort((a, b) => {
    switch (listSort) {
      case "dueSoon": {
        const dir = paid ? "desc" : "asc";
        return compareDueDateMs(a.dueDateSortMs, b.dueDateSortMs, dir);
      }
      case "dueLatest": {
        const dir = paid ? "asc" : "desc";
        return compareDueDateMs(a.dueDateSortMs, b.dueDateSortMs, dir);
      }
      case "amountDesc":
        return parseMoneyLabel(b.amountLabel) - parseMoneyLabel(a.amountLabel);
      case "amountAsc":
        return parseMoneyLabel(a.amountLabel) - parseMoneyLabel(b.amountLabel);
      case "resident":
        return (a.payeeLabel || "").localeCompare(b.payeeLabel || "", undefined, { sensitivity: "base" });
      default:
        return 0;
    }
  });
}

function normalizePropertyLabel(label: string | undefined): string {
  const trimmed = (label ?? "").trim();
  if (!trimmed) return "";
  return trimmed
    .replace(/\s*·\s*[^·]*::[^·]*$/i, "")
    .replace(/\s+[.-]\s+[^\s]+::[^\s]+$/i, "")
    .trim();
}

function PaymentsFilterSheet({
  activeCount,
  onReset,
  propertyOptions,
  personOptions,
  personLabel,
  propertyFilters,
  onPropertyFiltersChange,
  residentFilters,
  onResidentFiltersChange,
  listSort,
  onListSortChange,
  sortOptions,
}: {
  activeCount: number;
  onReset: () => void;
  propertyOptions: { id: string; label: string }[];
  personOptions: { id: string; label: string }[];
  personLabel: string;
  propertyFilters: string[];
  onPropertyFiltersChange: (next: string[]) => void;
  residentFilters: string[];
  onResidentFiltersChange: (next: string[]) => void;
  listSort: PaymentListSort;
  onListSortChange: (next: PaymentListSort) => void;
  sortOptions: { value: PaymentListSort; label: string }[];
}) {
  return (
    <PortalFilterSortSheet
      activeCount={activeCount}
      compactPanel
      filterFieldCount={personOptions.length > 0 ? 3 : 2}
      className="min-w-0 max-md:w-full max-md:[&_button]:w-full max-md:[&_button]:px-2.5"
      onReset={onReset}
      dataAttr="payments-filter-sheet-open"
    >
      <PaymentFilterSortFields
        propertyOptions={propertyOptions}
        personOptions={personOptions}
        personLabel={personLabel}
        propertyFilters={propertyFilters}
        onPropertyFiltersChange={onPropertyFiltersChange}
        residentFilters={residentFilters}
        onResidentFiltersChange={onResidentFiltersChange}
        listSort={listSort}
        onListSortChange={onListSortChange}
        sortOptions={sortOptions}
      />
    </PortalFilterSortSheet>
  );
}

export function ManagerPayments({
  direction = "incoming",
  bucket = "pending",
  basePath = "/portal",
  paymentId,
}: {
  direction?: ManagerPaymentDirection;
  bucket?: ManagerPaymentBucket;
  basePath?: string;
  paymentId?: string;
}) {
  const { showToast } = useAppUi();
  const { userId, ready: authReady } = useManagerUserId();
  const portalBase = usePaidPortalBasePath();
  const paymentsBase = `${basePath}/payments`;
  const [hcTick, setHcTick] = useState(0);
  const [outgoingTick, setOutgoingTick] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [addOutgoingOpen, setAddOutgoingOpen] = useState(false);
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [residentFilters, setResidentFilters] = useState<string[]>([]);
  const [applicationTick, setApplicationTick] = useState(0);
  const [propertyTick, setPropertyTick] = useState(0);
  const [reminderSettingsOpen, setReminderSettingsOpen] = useState(false);
  const [paymentSetupOpen, setPaymentSetupOpen] = useState(false);
  const [checkingManualPayments, setCheckingManualPayments] = useState(false);
  const [listSort, setListSort] = useState<PaymentListSort>(DEFAULT_PAYMENT_LIST_SORT);
  const [searchQuery, setSearchQuery] = useState("");
  // Per-payment reminder lists show the full saved default schedule, so bypass
  // the Inbox schedule-visibility window (which only gates Inbox → Schedule).
  const { messages: scheduledMessages, settings: reminderSettings, reload: reloadSchedule, setSettings: setReminderSettings } = useScheduledPaymentMessages({ includeHidden: true });
  const reminderScheduleSummary = useMemo(
    () => (reminderSettings ? formatFriendlyReminderSchedule(reminderSettings) : undefined),
    [reminderSettings],
  );
  const ledgerDataVersion = `${hcTick}:${applicationTick}:${propertyTick}:${outgoingTick}`;

  useEffect(() => {
    setResidentFilters([]);
  }, [direction]);

  useEffect(() => {
    const onOutgoing = () => setOutgoingTick((n) => n + 1);
    void syncManagerOutgoingExpensesFromServer().then(onOutgoing);
    void syncManagerWorkOrdersFromServer().then(onOutgoing);
    void syncManagerVendorsFromServer();
    window.addEventListener(MANAGER_OUTGOING_PAYMENTS_EVENT, onOutgoing);
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, onOutgoing);
    window.addEventListener(MANAGER_VENDORS_EVENT, onOutgoing);
    return () => {
      window.removeEventListener(MANAGER_OUTGOING_PAYMENTS_EVENT, onOutgoing);
      window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, onOutgoing);
      window.removeEventListener(MANAGER_VENDORS_EVENT, onOutgoing);
    };
  }, []);

  useEffect(() => {
    const on = () => setHcTick((n) => n + 1);
    void syncHouseholdChargesFromServer(true).then(on);
    window.addEventListener(HOUSEHOLD_CHARGES_EVENT, on);
    return () => window.removeEventListener(HOUSEHOLD_CHARGES_EVENT, on);
  }, []);

  useEffect(() => {
    const on = () => setApplicationTick((n) => n + 1);
    // Only sync once on mount, not on every event to avoid excessive syncs
    void syncManagerApplicationsFromServer({ managerUserId: userId }).then(on);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, on);
    return () => {
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, on);
    };
  }, [userId]);

  useEffect(() => {
    // Don't repeatedly sync applications on charge updates
    void syncPropertyPipelineFromServer().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!authReady || !userId) return;
    void syncPropertyPipelineFromServer().then(() => setPropertyTick((n) => n + 1));
  }, [authReady, userId]);

  useEffect(() => {
    if (!authReady || !userId || isDemoModeActive()) return;
    let cancelled = false;
    void fetch("/api/portal/purge-orphaned-records", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "current_only" }),
    })
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { deleted?: Record<string, number>; purgedEmails?: string[] };
        const total = Object.values(body.deleted ?? {}).reduce((a, b) => a + b, 0);
        if (total === 0) return;
        await syncManagerApplicationsFromServer({ force: true, managerUserId: userId });
        // Clear local cache first so the re-sync doesn't push orphaned charges back to server
        for (const email of body.purgedEmails ?? []) {
          removeResidentHouseholdPaymentData(email);
        }
        void syncHouseholdChargesFromServer(true).then(() => {
          if (cancelled) return;
          setApplicationTick((n) => n + 1);
          setHcTick((n) => n + 1);
        });
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [authReady, userId]);

  useEffect(() => {
    if (!authReady || !userId) return;
    const visibleApprovedCount = readManagerApplicationRows().filter(
      (row) => row.bucket === "approved" && applicationVisibleToPortalUser(row, userId),
    ).length;
    if (visibleApprovedCount === 0) return;
    reconcileApprovedResidentPaymentSchedules(userId);
  }, [authReady, userId, applicationTick]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const payouts = params.get("payouts");
    const connect = params.get("connect");
    if (connect === "done" || connect === "refresh") {
      if (window.opener && !window.opener.closed) {
        try {
          window.opener.postMessage({ type: "axis-stripe-connect", connect }, window.location.origin);
        } catch {
          /* cross-origin or closed */
        }
        window.close();
        return;
      }
      if (connect === "done") {
        showToast("Bank account linked. You're ready to receive resident payments.");
      } else if (connect === "refresh") {
        showToast("Setup link expired. Open Payment setup to try again.");
      }
      const url = new URL(window.location.href);
      url.searchParams.delete("connect");
      const next = `${url.pathname}${url.search}${url.hash}`;
      window.history.replaceState({}, "", next);
      window.dispatchEvent(new Event("axis-stripe-connect-refresh"));
      return;
    }
    if (payouts === "1") {
      window.location.replace(`${portalBase}/payments`);
    }
  }, [portalBase, showToast]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type !== "axis-stripe-connect") return;
      if (e.data?.connect === "done") {
        showToast("Bank account linked. You're ready to receive resident payments.");
      } else if (e.data?.connect === "refresh") {
        showToast("Setup link expired. Open Payment setup to try again.");
      }
      window.dispatchEvent(new Event("axis-stripe-connect-refresh"));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [showToast]);

  const mergedRows = useMemo(() => {
    void ledgerDataVersion;
    const applications = readManagerApplicationRows();
    // Scoping lives in `manager-payments-scope` so the dashboard's Payments
    // group counts exactly these rows too (F-PAY-1).
    const scoped = scopeChargesToManagerPaymentsLedger(
      readChargesForManager(userId, {
        linkedPropertyIds: collectLinkedPropertyIdsForModule(userId ?? "", "payments"),
      }),
      applications,
    );
    return scoped
      .map((charge) => {
        const ledgerRow = householdChargeToLedgerRow(charge);
        const chargeEmail = charge.residentEmail?.trim().toLowerCase() ?? "";
        const application = applications.find((row) => {
          if (charge.applicationId && row.id === charge.applicationId) return true;
          const rowEmail = row.email?.trim().toLowerCase();
          const rowPropertyId = row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
          return rowEmail === chargeEmail && rowPropertyId === charge.propertyId;
        });
        const roomNumber = application ? ledgerRoomNumberForApplication(application) : "";
        return roomNumber ? { ...ledgerRow, roomNumber } : ledgerRow;
      });
  }, [userId, ledgerDataVersion]);

  const residentOptions = useMemo(() => {
    void applicationTick;
    // Use readManagerApplicationRows as source of truth (same as Residents page)
    const applications = readManagerApplicationRows();
    const seen = new Map<string, string>();
    
    for (const app of applications) {
      // If property filter is active, only include residents from that property
      if (propertyFilters.length > 0) {
        const appPropertyName = normalizePropertyLabel(app.property?.trim() || "");
        if (!propertyFilters.includes(appPropertyName)) continue;
      }
      
      const name = app.name?.trim();
      if (!name) continue;
      if (!seen.has(name)) seen.set(name, name);
    }
    
    return [...seen.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  }, [propertyFilters, applicationTick]);
  const propertyLabelById = useMemo(() => {
    void propertyTick;
    const map = new Map<string, string>();
    if (!userId) return map;
    for (const property of [...readExtraListingsForUser(userId)]) {
      const id = property.id.trim();
      const label = normalizePropertyLabel(property.buildingName.trim() || property.title);
      if (id && label) map.set(id, label);
    }
    return map;
  }, [userId, propertyTick]);

  const vendorById = useMemo(() => {
    void ledgerDataVersion;
    return new Map(readOwnActiveManagerVendorRows(userId).map((vendor) => [vendor.id, vendor]));
  }, [userId, ledgerDataVersion]);

  const outgoingRows = useMemo(() => {
    void ledgerDataVersion;
    const vendorNameById = new Map([...vendorById.entries()].map(([id, vendor]) => [id, vendor.name]));
    return buildManagerOutgoingPaymentRows({
      managerUserId: userId,
      expenses: readManagerOutgoingExpenses(),
      workOrders: readManagerWorkOrderRows(),
      propertyLabelById,
      vendorNameById,
      vendorById,
    });
  }, [userId, ledgerDataVersion, propertyLabelById, vendorById]);

  const payeeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of outgoingRows) {
      if (propertyFilters.length > 0 && !propertyFilters.includes(normalizePropertyLabel(row.propertyName))) {
        continue;
      }
      const label = row.payeeLabel?.trim();
      if (!label || seen.has(label)) continue;
      seen.set(label, label);
    }
    return [...seen.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  }, [outgoingRows, propertyFilters]);

  const personOptions = direction === "incoming" ? residentOptions : payeeOptions;
  const personLabel = direction === "incoming" ? "Resident" : "Payee";

  const activeResidentFilters = residentFilters.filter((name) => personOptions.some((option) => option.id === name));

  const rowsForCounts = useMemo(() => {
    return mergedRows.filter((row) => {
      if (propertyFilters.length > 0 && !propertyFilters.includes(normalizePropertyLabel(row.propertyName))) return false;
      if (activeResidentFilters.length > 0 && !activeResidentFilters.includes(row.residentName)) return false;
      return true;
    });
  }, [mergedRows, propertyFilters, activeResidentFilters]);

  const counts = useMemo(() => {
    const c: Record<ManagerPaymentBucket, number> = { pending: 0, overdue: 0, paid: 0 };
    for (const r of rowsForCounts) {
      c[r.bucket] += 1;
    }
    return c;
  }, [rowsForCounts]);

  const outgoingRowsForCounts = useMemo(() => {
    return outgoingRows.filter((row) => {
      if (propertyFilters.length > 0 && !propertyFilters.includes(normalizePropertyLabel(row.propertyName))) return false;
      if (activeResidentFilters.length > 0 && !activeResidentFilters.includes(row.payeeLabel)) return false;
      return true;
    });
  }, [outgoingRows, propertyFilters, activeResidentFilters]);

  const outgoingCounts = useMemo(() => {
    const c: Record<ManagerPaymentBucket, number> = { pending: 0, overdue: 0, paid: 0 };
    for (const row of outgoingRowsForCounts) c[row.bucket] += 1;
    return c;
  }, [outgoingRowsForCounts]);

  const outgoingRowsForBucket = useMemo(() => {
    const filtered = outgoingRowsForCounts.filter((row) => row.bucket === bucket);
    const sorted = sortOutgoingRows(filtered, bucket, listSort);
    const q = searchQuery.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((row) => {
      const hay = [row.payeeLabel, row.propertyName, row.chargeTitle, row.amountLabel]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [outgoingRowsForCounts, bucket, listSort, searchQuery]);

  const propertyOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of mergedRows) {
      const key = normalizePropertyLabel(row.propertyName);
      if (!key) continue;
      if (!seen.has(key)) seen.set(key, key);
    }
    for (const row of outgoingRows) {
      const key = normalizePropertyLabel(row.propertyName);
      if (!key) continue;
      if (!seen.has(key)) seen.set(key, key);
    }
    return [...seen.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  }, [mergedRows, outgoingRows]);

  const paymentSetupPropertyOptions = useMemo(
    () => buildManagerPropertyFilterOptions(userId),
    [userId, mergedRows, outgoingRows],
  );

  const tabs = useMemo(
    () =>
      PAY_LABELS.map(({ id, label }) => ({
        id,
        label,
        count: direction === "incoming" ? counts[id] : outgoingCounts[id],
        alert: id === "overdue" && (direction === "incoming" ? counts.overdue : outgoingCounts.overdue) > 0,
      })),
    [counts, outgoingCounts, direction],
  );
  const rowsForBucket = useMemo(() => {
    const filtered = mergedRows.filter((r) => {
      if (r.bucket !== bucket) return false;
      if (propertyFilters.length > 0 && !propertyFilters.includes(normalizePropertyLabel(r.propertyName))) return false;
      if (activeResidentFilters.length > 0 && !activeResidentFilters.includes(r.residentName)) return false;
      return true;
    });

    const sorted = sortLedgerRows(filtered, bucket, listSort);
    const q = searchQuery.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((row) => {
      const hay = [row.residentName, row.propertyName, row.chargeTitle, row.balanceDue]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [mergedRows, bucket, propertyFilters, activeResidentFilters, listSort, searchQuery]);

  const filterTouchCount = paymentFilterTouches(propertyFilters, residentFilters, listSort, direction);

  const sortOptions = useMemo(
    () => [
      { value: "dueSoon" as const, label: "Due soonest" },
      { value: "dueLatest" as const, label: "Due latest" },
      { value: "amountDesc" as const, label: "Amount (high to low)" },
      { value: "amountAsc" as const, label: "Amount (low to high)" },
      {
        value: "resident" as const,
        label: direction === "incoming" ? "Resident (A–Z)" : "Payee (A–Z)",
      },
    ],
    [direction],
  );

  const resetPaymentFilters = () => {
    setPropertyFilters([]);
    setResidentFilters([]);
    setListSort(DEFAULT_PAYMENT_LIST_SORT);
  };

  const paymentsFilterSheetProps = {
    activeCount: filterTouchCount,
    onReset: resetPaymentFilters,
    propertyOptions,
    personOptions,
    personLabel,
    propertyFilters,
    onPropertyFiltersChange: (nextProperties: string[]) => {
      setPropertyFilters(nextProperties);
      setResidentFilters([]);
    },
    residentFilters: activeResidentFilters,
    onResidentFiltersChange: setResidentFilters,
    listSort,
    onListSortChange: setListSort,
    sortOptions,
  };

  const paymentsRemindersButton =
    direction === "incoming" ? (
      <Button
        type="button"
        variant="outline"
        className={PORTAL_HEADER_ACTION_BTN_RESPONSIVE}
        onClick={() => setReminderSettingsOpen(true)}
        data-attr="payments-reminder-settings"
      >
        Reminders
      </Button>
    ) : null;

  const paymentsSetupButton = (
    <Button
      type="button"
      variant="outline"
      className={PORTAL_HEADER_ACTION_BTN_RESPONSIVE}
      onClick={() => setPaymentSetupOpen(true)}
      data-attr="payments-setup"
    >
      Payment setup
    </Button>
  );

  const checkPaymentsButton = direction === "incoming" ? (
    <Button
      type="button"
      variant="outline"
      className={PORTAL_HEADER_ACTION_BTN_RESPONSIVE}
      disabled={checkingManualPayments}
      data-attr="manager-check-manual-payments"
      onClick={() => {
        void (async () => {
          setCheckingManualPayments(true);
          try {
            const response = await fetch("/api/portal/gmail-payments/sync", { method: "POST", credentials: "include" });
            const body = (await response.json().catch(() => ({}))) as {
              result?: { scanned?: number; markedPaid?: number; ambiguous?: number; unmatched?: number };
              error?: string;
            };
            if (!response.ok) {
              showToast(body.error ?? "Could not check payments. Link Gmail in Payment setup first.");
              return;
            }
            const result = body.result;
            showToast(
              result
                ? `Checked ${result.scanned ?? 0} receipt${result.scanned === 1 ? "" : "s"}; ${result.markedPaid ?? 0} confirmed.${result.ambiguous ? ` ${result.ambiguous} ambiguous — left pending.` : ""}`
                : "Payment check complete.",
            );
            await syncHouseholdChargesFromServer(true);
            setHcTick((n) => n + 1);
          } catch {
            showToast("Could not check payments.");
          } finally {
            setCheckingManualPayments(false);
          }
        })();
      }}
    >
      {checkingManualPayments ? "Checking…" : "Check payments"}
    </Button>
  ) : null;

  const paymentsAddButton = (
    <Button
      type="button"
      variant="primary"
      className={PORTAL_HEADER_PRIMARY_ACTION_BTN_RESPONSIVE}
      onClick={() => (direction === "incoming" ? setAddOpen(true) : setAddOutgoingOpen(true))}
      data-attr="payments-add"
    >
      {direction === "incoming" ? "Add charge" : "Add payment"}
    </Button>
  );

  const paymentsHeaderActions = (
    <>
      {paymentsRemindersButton}
      {checkPaymentsButton}
      {paymentsSetupButton}
      {paymentsAddButton}
    </>
  );

  const paymentsFilterControl = <PaymentsFilterSheet {...paymentsFilterSheetProps} />;

  const activeFilterChips = useMemo((): PortalActiveFilterChip[] => {
    const chips: PortalActiveFilterChip[] = [];
    if (propertyFilters.length > 0) {
      chips.push({
        id: "property",
        label:
          propertyFilters.length === 1
            ? `Property: ${propertyFilters[0]}`
            : `${propertyFilters.length} properties`,
        onRemove: () => {
          setPropertyFilters([]);
          setResidentFilters([]);
        },
      });
    }
    if (direction === "incoming" && activeResidentFilters.length > 0) {
      chips.push({
        id: "resident",
        label:
          activeResidentFilters.length === 1
            ? `Resident: ${activeResidentFilters[0]}`
            : `${activeResidentFilters.length} residents`,
        onRemove: () => setResidentFilters([]),
      });
    }
    if (listSort !== DEFAULT_PAYMENT_LIST_SORT) {
      const sortLabel = sortOptions.find((opt) => opt.value === listSort)?.label ?? listSort;
      chips.push({
        id: "sort",
        label: `Sort: ${sortLabel}`,
        onRemove: () => setListSort(DEFAULT_PAYMENT_LIST_SORT),
      });
    }
    return chips;
  }, [propertyFilters, activeResidentFilters, listSort, direction, sortOptions]);

  const directionNav = (
    <DestinationNav
      items={DIRECTION_LABELS.map((d) => ({
        id: d.id,
        label: d.label,
        href: `${paymentsBase}/${d.id}/pending`,
        dataAttr: `payments-direction-${d.id}`,
      }))}
      activeId={direction}
      ariaLabel="Payment direction"
      size="toolbar"
      className="max-w-none"
    />
  );

  const paymentsListDestinations = (
    <div className="flex w-full min-w-0 flex-col gap-2 max-lg:gap-1.5">
      {directionNav}
      <DestinationNav
        items={tabs.map((t) => ({
          id: t.id,
          label: t.label,
          href: `${paymentsBase}/${direction}/${t.id}`,
          count: t.count,
          alert: t.alert,
          dataAttr: `payments-bucket-${t.id}`,
        }))}
        activeId={bucket}
        ariaLabel="Payment status"
      />
    </div>
  );

  const paymentsPanel =
    direction === "incoming" ? (
      <ManagerPaymentsLedgerPanel
        rows={rowsForBucket}
        managerUserId={userId ?? null}
        activeBucket={bucket}
        scheduledMessages={scheduledMessages}
        reminderScheduleSummary={reminderScheduleSummary}
        onOpenReminderSettings={() => setReminderSettingsOpen(true)}
        onScheduleChanged={() => void reloadSchedule()}
        onRowsChanged={() => setHcTick((n) => n + 1)}
        paymentId={paymentId}
        listBasePath={basePath}
        direction={direction}
        onAddPayment={() => setAddOpen(true)}
      />
    ) : (
      <ManagerOutgoingPaymentsPanel
        rows={outgoingRowsForBucket}
        activeBucket={bucket}
        vendorById={vendorById}
        paymentId={paymentId}
        listBasePath={basePath}
        onAddPayment={() => setAddOutgoingOpen(true)}
        onRowsChanged={() => {
          setOutgoingTick((n) => n + 1);
          void syncManagerOutgoingExpensesFromServer(true);
          void syncManagerWorkOrdersFromServer();
        }}
      />
    );

  const paymentsModals = (
    <>
      <ReminderSettingsModal
        open={reminderSettingsOpen}
        onClose={() => setReminderSettingsOpen(false)}
        settings={reminderSettings}
        onSaved={(next) => {
          setReminderSettings(next);
          void reloadSchedule();
          setReminderSettingsOpen(false);
        }}
      />
      <ManagerAddPaymentModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        managerUserId={userId ?? null}
        onSubmitted={() => {
          setAddOpen(false);
          setHcTick((n) => n + 1);
          void reloadSchedule();
        }}
      />
      <ManagerAddOutgoingPaymentModal
        open={addOutgoingOpen}
        onClose={() => setAddOutgoingOpen(false)}
        managerUserId={userId ?? null}
        onSubmitted={() => {
          setAddOutgoingOpen(false);
          setOutgoingTick((n) => n + 1);
          void syncManagerOutgoingExpensesFromServer(true);
        }}
      />
      <ManagerPaymentSetupModal
        open={paymentSetupOpen}
        onClose={() => setPaymentSetupOpen(false)}
        portalBase={portalBase}
        propertyOptions={paymentSetupPropertyOptions}
      />
    </>
  );

  if (paymentId) {
    return (
      <>
        {paymentsPanel}
        {paymentsModals}
      </>
    );
  }

  return (
    <ManagerPortalPageShell
      title="Payments"
      hideTitleOnMobileNav
      titleInlineFilter={paymentsFilterControl}
      titleAside={paymentsHeaderActions}
      compactFilterRow
    >
      <PortalListControlStack
        className="mb-2"
        destinationRow={paymentsListDestinations}
        search={{
          value: searchQuery,
          onChange: setSearchQuery,
          placeholder: "Search charges",
          dataAttr: "payments-search",
        }}
        activeFilterChips={<PortalActiveFilterChips chips={activeFilterChips} />}
      />
      {paymentsPanel}
      {paymentsModals}
    </ManagerPortalPageShell>
  );
}
