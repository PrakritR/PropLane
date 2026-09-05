"use client";

import { MANAGER_MANUAL_PAYMENT_AUTO_CHECK_MS } from "@/lib/resident-manual-payment-client";
import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { PortalFilterSortSheet } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalActiveFilterChips, type PortalActiveFilterChip } from "@/components/portal/portal-filter-chips";
import { PaymentFilterSortFields } from "@/components/portal/payment-filter-sort-fields";
import {
  DEFAULT_PORTAL_LIST_GROUP_MODE,
  PORTAL_LIST_GROUP_MODE_LABELS,
  type PortalListGroupMode,
} from "@/lib/portal-list-grouping";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  ManagerPortalPageShell,
  PORTAL_COMMAND_ACTION_BTN,
} from "@/components/portal/portal-metrics";
import type { DemoManagerOutgoingPaymentRow, DemoManagerPaymentLedgerRow } from "@/data/demo-portal";
import { parseMoneyLabel } from "@/lib/portal-monthly-profit";
import { ManagerPaymentsLedgerPanel } from "@/components/portal/pro-payments-ledger-panel";
import { ManagerOutgoingPaymentsPanel } from "@/components/portal/pro-outgoing-payments-panel";
import { ManagerAddOutgoingPaymentModal } from "@/components/portal/pro-add-outgoing-payment-modal";
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
import { convertLapsedRolloverLeasesToMonthToMonth } from "@/lib/lease-rollover-conversion";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { ManagerAddPaymentModal } from "@/components/portal/pro-add-payment-modal";
import { ManagerPaymentSetupModal } from "@/components/portal/pro-payment-setup-modal";
import { ManagerPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";
import { usePaidPortalBasePath } from "@/lib/portal-base-path-client";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import { applicationVisibleToPortalUser, buildManagerPropertyFilterOptions, collectLinkedPropertyIdsForModule } from "@/lib/manager-portfolio-access";
import { ledgerRoomNumberForApplication } from "@/lib/rental-application/data";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
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

const PAY_LABELS: { id: ManagerPaymentBucket; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "overdue", label: "Overdue" },
  { id: "paid", label: "Paid" },
];

type PaymentListSort = "dueSoon" | "dueLatest" | "amountDesc" | "amountAsc" | "resident";

const DEFAULT_PAYMENT_LIST_SORT: PaymentListSort = "dueSoon";
const OUTGOING_DEFAULT_GROUP_MODE: PortalListGroupMode = "house";

function paymentFilterTouches(
  propertyFilters: string[],
  residentFilters: string[],
  listSort: PaymentListSort,
  groupMode: PortalListGroupMode,
  direction: ManagerPaymentDirection,
): number {
  let count = 0;
  if (propertyFilters.length > 0) count += 1;
  if (residentFilters.length > 0) count += 1;
  if (listSort !== DEFAULT_PAYMENT_LIST_SORT) count += 1;
  const defaultGroupMode =
    direction === "outgoing" ? OUTGOING_DEFAULT_GROUP_MODE : DEFAULT_PORTAL_LIST_GROUP_MODE;
  if (groupMode !== defaultGroupMode) count += 1;
  return count;
}

function paymentRowMatchesProperty(row: { propertyId?: string }, propertyFilters: string[]): boolean {
  if (propertyFilters.length === 0) return true;
  const propertyId = row.propertyId?.trim();
  return Boolean(propertyId && propertyFilters.includes(propertyId));
}

function paymentResidentKey(row: { residentEmail?: string; residentName: string }): string {
  const email = row.residentEmail?.trim().toLowerCase();
  if (email) return email;
  return row.residentName?.trim() ?? "";
}

function paymentRowMatchesResident(
  row: { residentEmail?: string; residentName: string },
  residentFilters: string[],
): boolean {
  if (residentFilters.length === 0) return true;
  const key = paymentResidentKey(row);
  return Boolean(key && residentFilters.includes(key));
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

function PaymentsFilterSheet({
  open,
  onOpenChange,
  activeCount,
  onReset,
  propertyOptions,
  propertyFilters,
  onPropertyFiltersChange,
  residentOptions,
  residentFilters,
  onResidentFiltersChange,
  showResidentFilter,
  listSort,
  onListSortChange,
  sortOptions,
  filterFieldCount,
  groupMode,
  onGroupModeChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeCount: number;
  onReset: () => void;
  propertyOptions: { id: string; label: string }[];
  propertyFilters: string[];
  onPropertyFiltersChange: (next: string[]) => void;
  residentOptions: { id: string; label: string }[];
  residentFilters: string[];
  onResidentFiltersChange: (next: string[]) => void;
  showResidentFilter: boolean;
  listSort: PaymentListSort;
  onListSortChange: (next: PaymentListSort) => void;
  sortOptions: { value: PaymentListSort; label: string }[];
  filterFieldCount: number;
  groupMode: PortalListGroupMode;
  onGroupModeChange: (next: PortalListGroupMode) => void;
}) {
  return (
    <PortalFilterSortSheet
      open={open}
      onOpenChange={onOpenChange}
      activeCount={activeCount}
      compactPanel
      commandStripTrigger
      filterFieldCount={filterFieldCount}
      mobileFlushBody
      constrainDropdownToTitleBand={false}
      className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
      onReset={onReset}
      dataAttr="payments-filter-sheet-open"
    >
      <PaymentFilterSortFields
        propertyOptions={propertyOptions}
        propertyFilters={propertyFilters}
        onPropertyFiltersChange={onPropertyFiltersChange}
        residentOptions={residentOptions}
        residentFilters={residentFilters}
        onResidentFiltersChange={onResidentFiltersChange}
        showResidentFilter={showResidentFilter}
        listSort={listSort}
        onListSortChange={onListSortChange}
        sortOptions={sortOptions}
        defaultListSort={DEFAULT_PAYMENT_LIST_SORT}
        groupMode={groupMode}
        onGroupModeChange={onGroupModeChange}
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
  const [paymentSettingsOpen, setPaymentSettingsOpen] = useState(false);
  const [paymentSetupOpen, setPaymentSetupOpen] = useState(false);
  const [paymentsFilterOpen, setPaymentsFilterOpen] = useState(false);
  const [checkingManualPayments, setCheckingManualPayments] = useState(false);
  const [listSort, setListSort] = useState<PaymentListSort>(DEFAULT_PAYMENT_LIST_SORT);
  const [incomingGroupMode, setIncomingGroupMode] = useState<PortalListGroupMode>(
    DEFAULT_PORTAL_LIST_GROUP_MODE,
  );
  const [outgoingGroupMode, setOutgoingGroupMode] = useState<PortalListGroupMode>(
    OUTGOING_DEFAULT_GROUP_MODE,
  );
  const groupMode = direction === "incoming" ? incomingGroupMode : outgoingGroupMode;
  const setGroupMode =
    direction === "incoming" ? setIncomingGroupMode : setOutgoingGroupMode;
  // Per-payment reminder lists show the full saved default schedule, so bypass
  // the Inbox schedule-visibility window (which only gates Inbox → Schedule).
  const { messages: scheduledMessages, settings: reminderSettings, reload: reloadSchedule, setSettings: setReminderSettings } = useScheduledPaymentMessages({ includeHidden: true });
  const reminderScheduleSummary = useMemo(
    () => (reminderSettings ? formatFriendlyReminderSchedule(reminderSettings) : undefined),
    [reminderSettings],
  );
  const ledgerDataVersion = `${hcTick}:${applicationTick}:${propertyTick}:${outgoingTick}`;

  useEffect(() => {
    if (direction !== "incoming") setResidentFilters([]);
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
    // A lease whose listing rolls over has already promised, in the signed
    // document, that it continues month-to-month. Charges are bounded by the
    // lease end date, so the record has to be carried past it BEFORE the
    // schedule is rebuilt — otherwise the promised tenancy bills nothing.
    const converted = convertLapsedRolloverLeasesToMonthToMonth(userId);
    reconcileApprovedResidentPaymentSchedules(userId, converted > 0);
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

  const propertyOptions = useMemo(
    () => buildManagerPropertyFilterOptions(userId),
    [userId, propertyTick, applicationTick],
  );

  const propertyLabelById = useMemo(
    () => new Map(propertyOptions.map((option) => [option.id, option.label])),
    [propertyOptions],
  );

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

  const residentOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of mergedRows) {
      const id = paymentResidentKey(row);
      if (!id || seen.has(id)) continue;
      seen.set(id, row.residentName?.trim() || id);
    }
    return [...seen.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  }, [mergedRows]);

  const rowsForCounts = useMemo(() => {
    return mergedRows.filter((row) => {
      if (!paymentRowMatchesProperty(row, propertyFilters)) return false;
      if (!paymentRowMatchesResident(row, residentFilters)) return false;
      return true;
    });
  }, [mergedRows, propertyFilters, residentFilters]);

  const counts = useMemo(() => {
    const c: Record<ManagerPaymentBucket, number> = { pending: 0, overdue: 0, paid: 0 };
    for (const r of rowsForCounts) {
      c[r.bucket] += 1;
    }
    return c;
  }, [rowsForCounts]);

  const outgoingRowsForCounts = useMemo(() => {
    return outgoingRows.filter((row) => paymentRowMatchesProperty(row, propertyFilters));
  }, [outgoingRows, propertyFilters]);

  const outgoingCounts = useMemo(() => {
    const c: Record<ManagerPaymentBucket, number> = { pending: 0, overdue: 0, paid: 0 };
    for (const row of outgoingRowsForCounts) c[row.bucket] += 1;
    return c;
  }, [outgoingRowsForCounts]);

  const outgoingRowsForBucket = useMemo(() => {
    const filtered = outgoingRowsForCounts.filter((row) => row.bucket === bucket);
    return sortOutgoingRows(filtered, bucket, listSort);
  }, [outgoingRowsForCounts, bucket, listSort]);

  const propertyOptionsForFilter = propertyOptions;

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
      if (!paymentRowMatchesProperty(r, propertyFilters)) return false;
      if (!paymentRowMatchesResident(r, residentFilters)) return false;
      return true;
    });

    return sortLedgerRows(filtered, bucket, listSort);
  }, [mergedRows, bucket, propertyFilters, residentFilters, listSort]);

  const filterTouchCount = paymentFilterTouches(
    propertyFilters,
    residentFilters,
    listSort,
    groupMode,
    direction,
  );

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

  const paymentsFilterSheetProps = {
    open: paymentsFilterOpen,
    onOpenChange: setPaymentsFilterOpen,
    activeCount: filterTouchCount,
    onReset: () => {
      setPropertyFilters([]);
      setResidentFilters([]);
      setListSort(DEFAULT_PAYMENT_LIST_SORT);
      if (direction === "incoming") {
        setIncomingGroupMode(DEFAULT_PORTAL_LIST_GROUP_MODE);
      } else {
        setOutgoingGroupMode(OUTGOING_DEFAULT_GROUP_MODE);
      }
    },
    propertyOptions: propertyOptionsForFilter,
    propertyFilters,
    onPropertyFiltersChange: setPropertyFilters,
    residentOptions,
    residentFilters,
    onResidentFiltersChange: setResidentFilters,
    showResidentFilter: direction === "incoming",
    listSort,
    onListSortChange: setListSort,
    sortOptions,
    filterFieldCount: direction === "incoming" ? 4 : 3,
    groupMode,
    onGroupModeChange: setGroupMode,
  };

  const runCheckManualPayments = useCallback((options?: { silent?: boolean }) => {
    void (async () => {
      setCheckingManualPayments(true);
      try {
        const response = await fetch("/api/portal/gmail-payments/sync", { method: "POST", credentials: "include" });
        const body = (await response.json().catch(() => ({}))) as {
          result?: { scanned?: number; markedPaid?: number; ambiguous?: number; unmatched?: number };
          error?: string;
        };
        if (!response.ok) {
          if (!options?.silent) {
            showToast(body.error ?? "Could not check payments. Link Gmail in Payment setup first.");
          }
          return;
        }
        const result = body.result;
        const markedPaid = result?.markedPaid ?? 0;
        if (!options?.silent || markedPaid > 0) {
          showToast(
            result
              ? `Checked ${result.scanned ?? 0} receipt${result.scanned === 1 ? "" : "s"}; ${markedPaid} confirmed.${result.ambiguous ? ` ${result.ambiguous} ambiguous — left pending.` : ""}`
              : "Payment check complete.",
          );
        }
        await syncHouseholdChargesFromServer(true);
        setHcTick((n) => n + 1);
      } catch {
        if (!options?.silent) showToast("Could not check payments.");
      } finally {
        setCheckingManualPayments(false);
      }
    })();
  }, [showToast]);

  const paymentsFilterSort = <PaymentsFilterSheet {...paymentsFilterSheetProps} />;

  /*
    One Settings, not a menu of two.
    "Settings" and "Reminders" were two dialogs over the SAME
    `/api/portal/automation-settings` fields, so each could silently undo the
    other. Payments settings now IS the reminder schedule, and the menu that
    offered a choice between them has nothing left to choose.
  */
  const paymentsSettingsMenu = (
    <Button
      type="button"
      variant="outline"
      className={PORTAL_COMMAND_ACTION_BTN}
      data-attr="payments-settings-open"
      onClick={() => setPaymentSettingsOpen(true)}
    >
      Settings
    </Button>
  );

  const paymentsCheckButton =
    direction === "incoming" ? (
      <Button
        type="button"
        variant="outline"
        className={PORTAL_COMMAND_ACTION_BTN}
        data-attr="manager-check-manual-payments"
        disabled={checkingManualPayments}
        onClick={() => runCheckManualPayments()}
      >
        {checkingManualPayments ? "Checking…" : "Check"}
      </Button>
    ) : null;

  const paymentsSetupButton = (
    <Button
      type="button"
      variant="outline"
      className={PORTAL_COMMAND_ACTION_BTN}
      data-attr="payments-setup"
      onClick={() => setPaymentSetupOpen(true)}
    >
      Setup
    </Button>
  );

  const paymentsListActions = (
    <>
      {paymentsFilterSort}
      {paymentsSettingsMenu}
      {paymentsCheckButton}
      {paymentsSetupButton}
    </>
  );

  const hasIncomingManualCandidates = direction === "incoming" && counts.pending + counts.overdue > 0;
  const checkingManualPaymentsRef = useRef(checkingManualPayments);
  useEffect(() => {
    checkingManualPaymentsRef.current = checkingManualPayments;
  }, [checkingManualPayments]);

  useEffect(() => {
    if (!hasIncomingManualCandidates || isDemoModeActive()) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || checkingManualPaymentsRef.current) return;
      runCheckManualPayments({ silent: true });
    }, MANAGER_MANUAL_PAYMENT_AUTO_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [hasIncomingManualCandidates, runCheckManualPayments]);

  const activeFilterChips = useMemo((): PortalActiveFilterChip[] => {
    const chips: PortalActiveFilterChip[] = [];
    if (propertyFilters.length > 0) {
      chips.push({
        id: "property",
        label:
          propertyFilters.length === 1
            ? `Property: ${propertyLabelById.get(propertyFilters[0]!) ?? propertyFilters[0]}`
            : `${propertyFilters.length} properties`,
        onRemove: () => setPropertyFilters([]),
      });
    }
    if (residentFilters.length > 0) {
      const residentLabelById = new Map(residentOptions.map((option) => [option.id, option.label]));
      chips.push({
        id: "resident",
        label:
          residentFilters.length === 1
            ? `Resident: ${residentLabelById.get(residentFilters[0]!) ?? residentFilters[0]}`
            : `${residentFilters.length} residents`,
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
    const defaultGroupMode =
      direction === "outgoing" ? OUTGOING_DEFAULT_GROUP_MODE : DEFAULT_PORTAL_LIST_GROUP_MODE;
    if (groupMode !== defaultGroupMode) {
      chips.push({
        id: "group-mode",
        label: PORTAL_LIST_GROUP_MODE_LABELS[groupMode],
        onRemove: () => setGroupMode(defaultGroupMode),
      });
    }
    return chips;
  }, [
    propertyFilters,
    residentFilters,
    listSort,
    sortOptions,
    propertyLabelById,
    residentOptions,
    direction,
    groupMode,
    setGroupMode,
  ]);

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
        groupMode={groupMode}
      />
    ) : (
      <ManagerOutgoingPaymentsPanel
        rows={outgoingRowsForBucket}
        activeBucket={bucket}
        vendorById={vendorById}
        paymentId={paymentId}
        listBasePath={basePath}
        groupMode={outgoingGroupMode}
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
      <ManagerPortalSettingsModal
        open={paymentSettingsOpen}
        onClose={() => setPaymentSettingsOpen(false)}
        initialTab="payments"
        scopedTitle={direction === "outgoing" ? "Outgoing payments" : "Payments"}
        paymentsMode={direction === "outgoing" ? "outgoing" : "incoming"}
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
        propertyOptions={propertyOptionsForFilter}
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
      titleInlineFilter={null}
      compactFilterRow
    >
      <PortalListControlStack
        className="mb-2 max-lg:mb-2"
        variant="command"
        destinations={tabs.map((t) => ({
          id: t.id,
          label: t.label,
          href: `${paymentsBase}/${direction}/${t.id}`,
          count: t.count,
          alert: t.alert,
          dataAttr: `payments-bucket-${t.id}`,
        }))}
        activeDestinationId={bucket}
        destinationAriaLabel="Payment status"
        actions={paymentsListActions}
        activeFilterChips={<PortalActiveFilterChips chips={activeFilterChips} />}
      />
      {paymentsPanel}
      {paymentsModals}
    </ManagerPortalPageShell>
  );
}
