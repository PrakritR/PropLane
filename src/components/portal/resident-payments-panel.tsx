"use client";
import { PortalAdaptiveActionRow } from "@/components/portal/portal-adaptive-action-row";
import { recordDelightMoment } from "@/lib/native/app-review";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { ResidentAutopayCard } from "@/components/portal/resident-autopay-card";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { track } from "@/lib/analytics/track-client";
import { Button } from "@/components/ui/button";
import { Select, Input } from "@/components/ui/input";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Modal } from "@/components/ui/modal";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { MODAL_LARGE_PANEL_CLASS } from "@/components/ui/modal-styles";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { StripeEmbeddedCheckout } from "@/components/stripe-embedded-checkout";
import {
  ManagerPortalPageShell,
  PORTAL_COMMAND_ACTION_BTN,
  PORTAL_COMMAND_PRIMARY_ACTION_BTN,
  PORTAL_COMMAND_PRIMARY_ACTION_STYLE,
  PORTAL_INLINE_STATUS_NOTICE_CLASS,
  PORTAL_INLINE_UNLOCK_NOTICE_CLASS,
  PORTAL_INLINE_UNLOCK_NOTICE_STACKED_CLASS,
  formatCompactChargeLine,
} from "@/components/portal/portal-metrics";
import {
  PortalDataTableEmpty,
  PORTAL_DETAIL_BTN,
  PortalTableDetailActions,
} from "@/components/portal/portal-data-table";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import {
  ResidentPortalGroupedDataList,
  RESIDENT_PORTAL_DEFAULT_GROUP_MODE,
  type ResidentPortalGroupableRow,
} from "@/components/portal/resident-portal-grouped-data-list";
import type { PortalAdaptiveAction } from "@/components/portal/portal-adaptive-action-row";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { cn } from "@/lib/utils";
import { usePortalSession } from "@/hooks/use-portal-session";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { useNativePlatform } from "@/hooks/use-native-platform";
import {
  chargeDueLabel,
  compareChargesByDueDate,
  HOUSEHOLD_CHARGES_EVENT,
  HOUSEHOLD_CHARGES_SESSION_KEY,
  isHouseholdChargeOverdue,
  linkHouseholdChargesToResidentUser,
  applyHouseholdChargePatches,
  chargesImplyTenancy,
  readChargesForResident,
  syncHouseholdChargesFromServer,
  type HouseholdCharge,
} from "@/lib/household-charges";
import { residentVisibleCharges } from "@/lib/household-charge-visibility";
import { syncManagerApplicationsFromServer, MANAGER_APPLICATIONS_EVENT } from "@/lib/manager-applications-storage";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { syncLeasePipelineFromServer } from "@/lib/lease-pipeline-storage";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { CANONICAL_DEMO_MANAGER_NAME } from "@/lib/demo/demo-canonical-accounts";
import { paymentFailureCopy } from "@/lib/payments/payment-error-copy";
import { canPayHouseholdChargeWithAxisAch } from "@/lib/household-charge-payment-eligibility";
import {
  residentPaymentMethodLabel,
  residentProcessingFeeDisplayLabel,
  RESIDENT_CARD_PAYMENT_DISPLAY_LABEL,
  type ResidentAxisPaymentMethod,
} from "@/lib/payment-policy";
import { nativePlatformRequestHeaders } from "@/lib/platform/native-client";
import {
  chargesSupportPlatformCheckout,
  filterChargesForPayMethod,
  isPayableHouseholdCharge,
  residentPaymentMethodsForSurface,
} from "@/lib/platform/resident-payments";
import { safeFormatDateTime } from "@/lib/pacific-time";
import { applicationsForResidentEmail } from "@/lib/rental-application/application-policy";
import {
  isRecordedPaymentRow,
  recordedPaymentsMissingFromCharges,
} from "@/lib/resident-recorded-payments";
import { loadResidentLedgerRows, residentLedgerIdentityKey } from "@/lib/resident-ledger-client";
import type { ReportRow } from "@/lib/reports/types";
import {
  residentChargeDetailHref,
  residentChargesListHref,
} from "@/lib/portal-detail-routes";
import { stageResidentComposePrefill } from "@/lib/resident-compose-prefill";
import { residentChargeManagerMessageDraft } from "@/lib/resident-manager-message-draft";
import { RESIDENT_PORTAL_BASE_PATH } from "@/lib/portals/resident-sections";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import {
  buildMoveInChargeGroups,
  isMoveInGroupId,
  moveInGroupAsListRow,
  moveInGroupItemCountLabel,
  type MoveInChargeGroup,
} from "@/lib/move-in-charge-group";


type PayConfirmState = {
  chargeIds: string[];
  method: ResidentAxisPaymentMethod;
};

type CheckoutState = {
  key: string;
  chargeIds: string[];
  paymentMethod: ResidentAxisPaymentMethod;
  clientSecret: string | null;
  loading: boolean;
  error: string | null;
  /** False when retrying cannot help — a missing key or an unfinished manager setup. */
  canRetry?: boolean;
  /** True when the blocker is the manager's payment setup, not the resident's. */
  blockedByManagerSetup?: boolean;
  subtotalCents?: number;
  processingFeeCents?: number;
  axisFeeCents?: number;
  totalCents?: number;
};

const CHECKOUT_METHOD_OPTIONS: {
  id: ResidentAxisPaymentMethod;
  title: string;
}[] = [
  { id: "ach", title: "Bank (ACH)" },
  { id: "card", title: RESIDENT_CARD_PAYMENT_DISPLAY_LABEL },
  { id: "link", title: "Link" },
];

type SavedPaymentMethod = {
  id: string;
  type: "card" | "us_bank_account";
  label: string;
  isDefault: boolean;
};

function centsFromLabel(label: string): number {
  const n = Number(label.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function checkoutKey(chargeIds: string[], paymentMethod: ResidentAxisPaymentMethod): string {
  return `${[...chargeIds].sort().join(",")}:${paymentMethod}`;
}

function formatUsd(cents: number): string {
  // Same shape as every charge label ("$1,100.00"), so a total never reads
  // "$3400.00" beside lines that read "$1,100.00".
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

type PaymentStatusBucket = "overdue" | "pending" | "paid";

const EMPTY_LEDGER_ROWS: ReportRow[] = [];
const EMPTY_LEDGER_PAYMENTS: { identity: string; rows: ReportRow[] } = {
  identity: "",
  rows: EMPTY_LEDGER_ROWS,
};

function isPaymentStatusBucket(value: string | undefined): value is PaymentStatusBucket {
  return value === "overdue" || value === "pending" || value === "paid";
}

type RentReportingLastSubmission = { period: string; status: string; sentAt: string | null };

type RentReportingCardState = {
  eligible: boolean;
  addonAvailable: boolean;
  upgradeRequired: boolean;
  status: "active" | "paused" | "stopped";
  reportedAs: string | null;
  lastSubmission: RentReportingLastSubmission | null;
  bureaus: string;
};

const RENT_REPORTING_BUREAUS_FALLBACK = "Experian · TransUnion · Equifax";

const RENT_REPORTING_STATUS_LABELS: Record<string, string> = {
  on_time: "on time",
  late_30: "30 days late",
  late_60: "60 days late",
  late_90: "90+ days late",
  unpaid: "unpaid",
};

/** "Sep 5 · August rent · on time" from a raw submission row. */
function rentReportingLastReportLabel(submission: RentReportingLastSubmission): string {
  const [yearRaw, monthRaw] = submission.period.split("-").map(Number);
  const monthLabel = new Date(Date.UTC(yearRaw ?? new Date().getUTCFullYear(), (monthRaw ?? 1) - 1, 1)).toLocaleString(
    "en-US",
    { month: "long", timeZone: "UTC" },
  );
  const sentLabel = submission.sentAt
    ? new Date(submission.sentAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "—";
  const statusLabel = RENT_REPORTING_STATUS_LABELS[submission.status] ?? submission.status;
  return `${sentLabel} · ${monthLabel} rent · ${statusLabel}`;
}

export function ResidentPaymentsPanel({
  initialStatus,
  bucket: bucketProp,
  chargeId: chargeIdProp,
  basePath = "/resident",
}: {
  /** @deprecated Use routed `/payments/{pending|overdue|paid}` instead. */
  initialStatus?: string;
  bucket?: PaymentStatusBucket;
  chargeId?: string;
  basePath?: string;
}) {
  const resolvedBucketProp: PaymentStatusBucket =
    bucketProp ??
    (isPaymentStatusBucket(initialStatus) ? initialStatus : "pending");
  const { showToast } = useAppUi();
  const searchParams = useSearchParams();
  const router = useRouter();
  const portalNavigate = usePortalNavigate();
  const session = usePortalSession();
  const nativePlatform = useNativePlatform();
  const isNativeApp = nativePlatform !== null;
  const availablePaymentMethods = useMemo(
    () => residentPaymentMethodsForSurface(isNativeApp),
    [isNativeApp],
  );
  const paymentMethodOptions = useMemo(
    () => CHECKOUT_METHOD_OPTIONS.filter((option) => availablePaymentMethods.includes(option.id)),
    [availablePaymentMethods],
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [bucket, setBucket] = useState<PaymentStatusBucket>(resolvedBucketProp);
  const [prevBucketProp, setPrevBucketProp] = useState(resolvedBucketProp);
  if (resolvedBucketProp !== prevBucketProp) {
    setPrevBucketProp(resolvedBucketProp);
    setBucket(resolvedBucketProp);
  }
  const [bucketTouched, setBucketTouched] = useState(false);
  const { selectedIds, setSelectedIds, toggleSelected } = usePortalRowSelection(bucket);
  const [paymentMethod, setPaymentMethod] = useState<ResidentAxisPaymentMethod>("ach");
  const [payConfirm, setPayConfirm] = useState<PayConfirmState | null>(null);
  const [payModalStep, setPayModalStep] = useState<"select" | "pay">("select");
  const [tick, setTick] = useState(0);
  const [checkout, setCheckout] = useState<CheckoutState | null>(null);
  const [paymentMethodModalOpen, setPaymentMethodModalOpen] = useState(false);
  const [savedMethods, setSavedMethods] = useState<SavedPaymentMethod[]>([]);
  const [savedMethodsLoading, setSavedMethodsLoading] = useState(false);
  const [setupCheckout, setSetupCheckout] = useState<{ kind: "card" | "ach"; clientSecret: string } | null>(null);
  const [setupLoading, setSetupLoading] = useState<"card" | "ach" | null>(null);
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);
  const [applicationTick, setApplicationTick] = useState(0);
  const email = session.email?.trim() ?? null;
  const userId = session.userId;

  const openMessageManagerForCharge = useCallback(
    (charge: HouseholdCharge) => {
      stageResidentComposePrefill(residentChargeManagerMessageDraft(charge));
      portalNavigate(`${RESIDENT_PORTAL_BASE_PATH}/communication/active`);
    },
    [portalNavigate],
  );

  const paymentsUnlocked = useMemo(() => {
    void applicationTick;
    void tick;
    if (!email) return false;
    if (applicationsForResidentEmail(email).some((row) => row.bucket === "approved")) return true;
    // Manager-added residents should reach Payments even before an application
    // row exists in the local cache. An application or holding fee is NOT that
    // evidence — a prospect owes those — so it takes a tenancy charge.
    return chargesImplyTenancy(readChargesForResident(email, userId));
  }, [applicationTick, email, tick, userId]);

  const [rentReporting, setRentReporting] = useState<RentReportingCardState | null>(null);
  const [rentReportingConsentOpen, setRentReportingConsentOpen] = useState(false);
  const [rentReportingLegalName, setRentReportingLegalName] = useState("");
  const [rentReportingDob, setRentReportingDob] = useState("");
  const [rentReportingBusy, setRentReportingBusy] = useState(false);
  const [rentReportingError, setRentReportingError] = useState<string | null>(null);

  const loadRentReporting = useCallback(async () => {
    try {
      const response = await fetch("/api/resident/rent-reporting", { credentials: "include", cache: "no-store" });
      const body = (await response.json()) as Partial<RentReportingCardState> & { error?: string };
      if (!response.ok) return;
      setRentReporting({
        eligible: body.eligible === true,
        addonAvailable: body.addonAvailable === true,
        upgradeRequired: body.upgradeRequired === true,
        status: (body.status as RentReportingCardState["status"]) ?? "stopped",
        reportedAs: body.reportedAs ?? null,
        lastSubmission: body.lastSubmission ?? null,
        bureaus: body.bureaus ?? RENT_REPORTING_BUREAUS_FALLBACK,
      });
    } catch {
      /* the card just stays hidden on a failed read */
    }
  }, []);

  useEffect(() => {
    if (!email || !paymentsUnlocked || bucket !== "pending") return;
    void loadRentReporting();
  }, [email, paymentsUnlocked, bucket, loadRentReporting]);

  const rentReportingToggle = async (next: string) => {
    if (!rentReporting || rentReportingBusy) return;
    if (next === "on") {
      setRentReportingError(null);
      setRentReportingConsentOpen(true);
      return;
    }
    setRentReportingBusy(true);
    try {
      const response = await fetch("/api/resident/rent-reporting", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      if (response.ok) {
        track("rent_reporting_consent", { state: "off" });
        await loadRentReporting();
      }
    } finally {
      setRentReportingBusy(false);
    }
  };

  const submitRentReportingConsent = async () => {
    setRentReportingError(null);
    setRentReportingBusy(true);
    try {
      const response = await fetch("/api/resident/rent-reporting", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start",
          legalName: rentReportingLegalName,
          dob: rentReportingDob,
          consent: true,
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not turn on rent reporting.");
      track("rent_reporting_consent", { state: "on" });
      setRentReportingConsentOpen(false);
      setRentReportingLegalName("");
      setRentReportingDob("");
      await loadRentReporting();
    } catch (e) {
      setRentReportingError(e instanceof Error ? e.message : "Could not turn on rent reporting.");
    } finally {
      setRentReportingBusy(false);
    }
  };

  useEffect(() => {
    if (!availablePaymentMethods.includes(paymentMethod)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- fall back when surface policy changes
      setPaymentMethod(availablePaymentMethods[0] ?? "ach");
      setCheckout(null);
    }
  }, [availablePaymentMethods, paymentMethod]);

  const charges = useMemo(() => {
    void tick;
    if (!email) return [] as HouseholdCharge[];
    // A not-yet-due charge stays off the resident's screen until it is within
    // `RESIDENT_CHARGE_VISIBILITY_WINDOW_DAYS` of its due date (or a manager
    // surfaces it early via a manual reminder). This is the single source
    // every row list, count, and the "amount due" figure below derives from,
    // so filtering here keeps all of them in agreement with the assistant's
    // own resident charges tool, which applies the same underlying rule.
    // `residentVisibleCharges` (rather than a plain per-charge filter) keeps a
    // move-in group's lines together: the group below (`buildMoveInChargeGroups`)
    // must never lose a line just because that one line's own due date sits
    // outside the window while a sibling line makes the group visible.
    return residentVisibleCharges(readChargesForResident(email, userId));
  }, [email, userId, tick]);

  // Payments the LEDGER recorded whose charge row no longer exists. Without
  // these, Paid reads 0 while Documents › Rent receipts lists the same
  // payments (F6). Read-only and always `status: "paid"`, so they can never
  // enter a pay/select path (every one of those filters on `pending`).
  //
  // STORED AGAINST THE IDENTITY THEY WERE READ FOR. `email`/`userId` are
  // reactive, so an in-session account switch re-runs the read without
  // remounting; rows whose identity no longer matches the viewer are not
  // readable at all, so a refused or failed read can only fall back to the
  // live paid charges — never to the previous resident's money.
  const ledgerIdentity = useMemo(() => residentLedgerIdentityKey(email, userId), [email, userId]);
  const [ledgerPayments, setLedgerPayments] = useState(EMPTY_LEDGER_PAYMENTS);
  const ledgerPaymentRows = useMemo(
    () => (ledgerIdentity && ledgerPayments.identity === ledgerIdentity ? ledgerPayments.rows : EMPTY_LEDGER_ROWS),
    [ledgerIdentity, ledgerPayments],
  );

  // DERIVED, never stored. Storing the synthesized rows froze them against the
  // `charges` snapshot they were built from, so a charge that reappeared in the
  // store (a sync restore, a deferred load) while the refetch failed or was in
  // flight rendered BESIDE its synthesized twin — the double-count this whole
  // reconciliation exists to prevent. Deriving it re-dedupes on every charge
  // change, and a failed ledger read simply keeps the last known rows.
  const recordedPayments = useMemo(
    () => recordedPaymentsMissingFromCharges(ledgerPaymentRows, charges),
    [ledgerPaymentRows, charges],
  );

  const unpaidPayableCharges = useMemo(
    () => charges.filter((c) => isPayableHouseholdCharge(c)),
    [charges],
  );

  const unpaidAchCharges = useMemo(
    () => charges.filter((c) => c.status === "pending" && canPayHouseholdChargeWithAxisAch(c)),
    [charges],
  );

  const platformCheckoutAvailable = useMemo(
    () => chargesSupportPlatformCheckout(unpaidPayableCharges),
    [unpaidPayableCharges],
  );

  const managerStripeConnectBlocked = useMemo(
    () =>
      charges.some(
        (c) =>
          c.status === "pending" &&
          c.axisPaymentsEnabledSnapshot === true &&
          c.managerStripeConnectReadySnapshot === false,
      ),
    [charges],
  );

  const reloadSavedMethods = useCallback(async () => {
    if (isDemoModeActive()) {
      setSavedMethods([]);
      return;
    }
    setSavedMethodsLoading(true);
    try {
      const res = await fetch("/api/stripe/resident-payment-methods", { credentials: "include", cache: "no-store" });
      const data = (await res.json()) as { methods?: SavedPaymentMethod[] };
      setSavedMethods(Array.isArray(data.methods) ? data.methods : []);
    } catch {
      setSavedMethods([]);
    } finally {
      setSavedMethodsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!paymentMethodModalOpen) {
      setSetupCheckout(null);
      return;
    }
    void reloadSavedMethods();
  }, [paymentMethodModalOpen, reloadSavedMethods]);

  useEffect(() => {
    if (searchParams.get("payment_method") !== "added") return;
    void reloadSavedMethods();
    setPaymentMethodModalOpen(true);
    router.replace("/resident/payments", { scroll: false });
  }, [reloadSavedMethods, router, searchParams]);

  const startAddPaymentMethod = useCallback(
    async (kind: "card" | "ach") => {
      if (isDemoModeActive()) {
        showToast("Payment methods are unavailable in demo mode.");
        return;
      }
      setSetupLoading(kind);
      try {
        const returnUrl = `${window.location.origin}/resident/payments?payment_method=added`;
        const res = await fetch("/api/stripe/resident-payment-methods", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ kind, returnUrl }),
        });
        const data = (await res.json()) as { clientSecret?: string; error?: string };
        if (!res.ok || !data.clientSecret) {
          showToast(data.error ?? "Could not add payment method.");
          return;
        }
        setSetupCheckout({ kind, clientSecret: data.clientSecret });
      } finally {
        setSetupLoading(null);
      }
    },
    [showToast],
  );

  const setDefaultPaymentMethod = useCallback(
    async (paymentMethodId: string) => {
      if (isDemoModeActive()) {
        showToast("Payment methods are unavailable in demo mode.");
        return;
      }
      setSettingDefaultId(paymentMethodId);
      try {
        const res = await fetch("/api/stripe/resident-payment-methods", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ paymentMethodId }),
        });
        const data = (await res.json()) as { methods?: SavedPaymentMethod[]; error?: string };
        if (!res.ok) {
          showToast(data.error ?? "Could not set default payment method.");
          return;
        }
        setSavedMethods(Array.isArray(data.methods) ? data.methods : []);
        showToast("Default payment method updated.");
      } finally {
        setSettingDefaultId(null);
      }
    },
    [showToast],
  );

  const refresh = useCallback(() => {
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    const on = () => refresh();
    window.addEventListener(HOUSEHOLD_CHARGES_EVENT, on);
    const onStorage = (e: StorageEvent) => {
      if (e.key === HOUSEHOLD_CHARGES_SESSION_KEY) refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(HOUSEHOLD_CHARGES_EVENT, on);
      window.removeEventListener("storage", onStorage);
    };
  }, [refresh]);

  useEffect(() => {
    const onApplications = () => setApplicationTick((t) => t + 1);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, onApplications);
    return () => window.removeEventListener(MANAGER_APPLICATIONS_EVENT, onApplications);
  }, []);

  // Reconcile Paid against the accounting ledger — the same source Documents ›
  // Rent receipts reads (F6). Best-effort: a failed read leaves Paid showing
  // exactly the live paid charges, which is what it showed before. Coalesced
  // and TTL-guarded per viewer, because `tick` bumps on every charge event and
  // the read is a 12-month ledger scan.
  useEffect(() => {
    if (!session.ready || !ledgerIdentity || isDemoModeActive()) {
      setLedgerPayments(EMPTY_LEDGER_PAYMENTS);
      return;
    }
    let cancelled = false;
    void loadResidentLedgerRows(ledgerIdentity)
      .then((rows) => {
        if (cancelled) return;
        setLedgerPayments({ identity: ledgerIdentity, rows });
      })
      .catch(() => {
        /* the ledger is a reconciliation, never a blocker for paying */
      });
    return () => {
      cancelled = true;
    };
    // Keyed on `tick`, not `charges`: one ledger read per refresh, not one per
    // charge-list identity change.
  }, [session.ready, ledgerIdentity, tick]);

  useEffect(() => {
    if (!paymentsUnlocked) {
      setCheckout(null);
      setPayConfirm(null);
      setPaymentMethodModalOpen(false);
    }
  }, [paymentsUnlocked]);

  useEffect(() => {
    if (!session.ready) return;
    if (session.userId && email) linkHouseholdChargesToResidentUser(email, session.userId);
    void (async () => {
      await syncManagerApplicationsFromServer({ force: true });
      await syncPropertyPipelineFromServer({ force: true });
      await syncLeasePipelineFromServer();
      await syncHouseholdChargesFromServer(true, { skipReconcile: true });
    })().finally(refresh);
  }, [email, refresh, session.ready, session.userId]);

  useEffect(() => {
    const achCheckout = searchParams.get("ach_checkout");
    const sessionId = searchParams.get("session_id")?.trim();
    if (!achCheckout || !sessionId) return;

    if (achCheckout === "cancel") {
      showToast("Bank payment cancelled.");
      router.replace("/resident/payments");
      return;
    }

    if (achCheckout !== "success" && achCheckout !== "return") return;

    void (async () => {
      const res = await fetch(`/api/stripe/household-charge-verify?session_id=${encodeURIComponent(sessionId)}`);
      const data = (await res.json().catch(() => ({}))) as {
        paid?: boolean;
        processing?: boolean;
        error?: string;
      };

      if (!res.ok) {
        showToast(typeof data.error === "string" ? data.error : "Could not verify bank payment.");
        router.replace("/resident/payments");
        return;
      }

      if (data.paid) {
        await syncHouseholdChargesFromServer(true, { skipReconcile: true });
        refresh();
        setCheckout(null);
        setSelectedIds(new Set());
        showToast("Payment received. Thank you.");
        recordDelightMoment("charge_paid");
      } else if (data.processing) {
        showToast("Bank transfer submitted. We will mark this paid when the transfer clears (usually 3–5 business days).");
      } else {
        showToast(typeof data.error === "string" ? data.error : "Payment not completed yet.");
      }
      router.replace("/resident/payments");
    })();
  }, [refresh, router, searchParams, showToast]);

  const rows = useMemo(() => {
    return [...charges, ...recordedPayments].sort((a, b) => {
      if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
      if (a.status === "pending") {
        const aOverdue = isHouseholdChargeOverdue(a);
        const bOverdue = isHouseholdChargeOverdue(b);
        if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
        // Soonest due first among what's still owed.
        return compareChargesByDueDate(a, b, "asc");
      }
      // Paid history: most recently due first.
      return compareChargesByDueDate(a, b, "desc");
    });
  }, [charges, recordedPayments]);

  // `processing` (ACH clearing, 3–5 business days) shows alongside pending so
  // the charge doesn't vanish mid-payment — but it is never overdue or payable.
  const pendingRows = useMemo(
    () => rows.filter((c) => c.status === "pending" || c.status === "processing"),
    [rows],
  );
  // One move-in payment: the deposit, first month and move-in fees a signature
  // billed as separate lines show as ONE "Move-in total" row per home, with the
  // breakdown behind it. The lines themselves stay separate charges — and
  // separate ledger entries — so paying the total pays each of them.
  const moveInGroups = useMemo(() => buildMoveInChargeGroups(pendingRows), [pendingRows]);
  const moveInGroupedChargeIds = useMemo(
    () => new Set(moveInGroups.flatMap((group) => group.items.map((c) => c.id))),
    [moveInGroups],
  );
  const overdueRows = useMemo(
    () => [
      ...moveInGroups.filter((group) => group.overdue).map(moveInGroupAsListRow),
      ...pendingRows.filter(
        (c) => !moveInGroupedChargeIds.has(c.id) && c.status !== "processing" && isHouseholdChargeOverdue(c),
      ),
    ],
    [moveInGroupedChargeIds, moveInGroups, pendingRows],
  );
  const upcomingPendingRows = useMemo(
    () => [
      ...moveInGroups.filter((group) => !group.overdue).map(moveInGroupAsListRow),
      ...pendingRows.filter(
        (c) => !moveInGroupedChargeIds.has(c.id) && (c.status === "processing" || !isHouseholdChargeOverdue(c)),
      ),
    ],
    [moveInGroupedChargeIds, moveInGroups, pendingRows],
  );
  const paidRows = useMemo(() => rows.filter((c) => c.status === "paid"), [rows]);
  const rowsForBucket = useMemo(() => {
    if (bucket === "overdue") return overdueRows;
    if (bucket === "pending") return upcomingPendingRows;
    return paidRows;
  }, [bucket, overdueRows, upcomingPendingRows, paidRows]);

  const detailCharge = chargeIdProp ? charges.find((c) => c.id === chargeIdProp) : undefined;
  const detailMoveInGroup =
    chargeIdProp && isMoveInGroupId(chargeIdProp)
      ? moveInGroups.find((group) => group.id === chargeIdProp)
      : undefined;

  const bucketCounts = useMemo(
    () => ({
      overdue: overdueRows.length,
      pending: upcomingPendingRows.length,
      paid: paidRows.length,
    }),
    [overdueRows.length, upcomingPendingRows.length, paidRows.length],
  );

  useEffect(() => {
    if (bucketTouched || !email) return;
    // Default tab is Pending.
  }, [bucketTouched, email, overdueRows.length]);

  const statusTabs = useMemo(
    () =>
      [
        {
          id: "pending" as const,
          label: "Pending",
          count: bucketCounts.pending,
          dataAttr: "resident-payments-tab-pending",
        },
        {
          id: "overdue" as const,
          label: "Overdue",
          count: bucketCounts.overdue,
          alert: bucketCounts.overdue > 0,
          dataAttr: "resident-payments-tab-overdue",
        },
        {
          id: "paid" as const,
          label: "Paid",
          count: bucketCounts.paid,
          dataAttr: "resident-payments-tab-paid",
        },
      ] as const,
    [bucketCounts],
  );

  const loadCheckout = useCallback(
    async (chargeIds: string[], method: ResidentAxisPaymentMethod) => {
      const ids = [...new Set(chargeIds.map((id) => id.trim()).filter(Boolean))];
      if (ids.length === 0) return;
      // In the public /demo sandbox there is no real Stripe session and the
      // checkout route requires auth — keep the visitor inside the demo.
      if (isDemoModeActive()) {
        showToast("Payments are simulated in this demo.");
        return;
      }
      const key = checkoutKey(ids, method);
      setCheckout({ key, chargeIds: ids, paymentMethod: method, clientSecret: null, loading: true, error: null });
      track("household_charge_payment_started", { method, charge_count: ids.length });
      try {
        const res = await fetch("/api/stripe/household-charge-checkout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...nativePlatformRequestHeaders(nativePlatform),
          },
          body: JSON.stringify({ chargeIds: ids, embedded: true, paymentMethod: method }),
        });
        const payload = (await res.json().catch(() => ({}))) as {
          clientSecret?: string;
          url?: string;
          error?: string;
          code?: string;
          subtotalCents?: number;
          processingFeeCents?: number;
          axisFeeCents?: number;
          totalCents?: number;
        };
        if (!res.ok) {
          // The server already answers 422 MANAGER_NO_CONNECT_ACCOUNT when the
          // manager never finished onboarding — that code exists so this screen
          // can say something useful, and nothing read it. Rendering
          // `payload.error` raw showed a resident a server string for a bill the
          // product had just told them they could pay.
          const copy = paymentFailureCopy({
            code: payload.code,
            status: res.status,
            serverMessage: payload.error,
          });
          setCheckout({
            key,
            chargeIds: ids,
            paymentMethod: method,
            clientSecret: null,
            loading: false,
            error: copy.message,
            canRetry: copy.canRetry,
            blockedByManagerSetup: copy.blockedByManagerSetup,
          });
          return;
        }
        if (payload.clientSecret) {
          setCheckout({
            key,
            chargeIds: ids,
            paymentMethod: method,
            clientSecret: payload.clientSecret,
            loading: false,
            error: null,
            subtotalCents: payload.subtotalCents,
            processingFeeCents: payload.processingFeeCents,
            axisFeeCents: payload.axisFeeCents,
            totalCents: payload.totalCents,
          });
          return;
        }
        if (payload.url && typeof window !== "undefined") {
          window.location.href = payload.url;
        }
      } catch {
        setCheckout({
          key,
          chargeIds: ids,
          paymentMethod: method,
          clientSecret: null,
          loading: false,
          error: "Could not start payment.",
        });
      }
    },
    [nativePlatform, showToast],
  );

  const openPayConfirm = useCallback((chargeIds: string[], method: ResidentAxisPaymentMethod) => {
    const ids = [...new Set(chargeIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0) return;
    setCheckout(null);
    setPayModalStep("select");
    setPayConfirm({ chargeIds: ids, method });
  }, []);

  const selectPayModalMethod = useCallback((method: ResidentAxisPaymentMethod) => {
    setPaymentMethod(method);
    setCheckout(null);
    setPayModalStep("select");
    setPayConfirm((prev) => (prev ? { ...prev, method } : null));
  }, []);

  const closePayModal = useCallback(() => {
    setPayConfirm(null);
    setPayModalStep("select");
    setCheckout(null);
  }, []);

  const continuePayModal = useCallback(async () => {
    if (!payConfirm) return;
    setPayModalStep("pay");
    await loadCheckout(payConfirm.chargeIds, payConfirm.method);
  }, [loadCheckout, payConfirm]);

  // A move-in row stands for its lines: ticking it selects every one of them,
  // so Pay and the bulk bar keep working on real charge ids only.
  const toggleSelectedCharge = useCallback(
    (id: string) => {
      const group = isMoveInGroupId(id) ? moveInGroups.find((g) => g.id === id) : undefined;
      if (!group) {
        toggleSelected(id);
        return;
      }
      const ids = group.items.map((c) => c.id);
      const allSelected = ids.every((chargeId) => selectedIds.has(chargeId));
      const next = new Set(selectedIds);
      for (const chargeId of ids) {
        if (allSelected) next.delete(chargeId);
        else next.add(chargeId);
      }
      setSelectedIds(next);
    },
    [moveInGroups, selectedIds, setSelectedIds, toggleSelected],
  );
  const isRowSelected = useCallback(
    (id: string) => {
      const group = isMoveInGroupId(id) ? moveInGroups.find((g) => g.id === id) : undefined;
      if (!group) return selectedIds.has(id);
      return group.items.every((c) => selectedIds.has(c.id));
    },
    [moveInGroups, selectedIds],
  );
  // What the list draws as ticked: the real selection plus every move-in row
  // whose lines are all in it. Only real charge ids ever live in `selectedIds`.
  const listSelectedIds = useMemo(() => {
    const next = new Set(selectedIds);
    for (const group of moveInGroups) {
      if (group.items.every((c) => selectedIds.has(c.id))) next.add(group.id);
    }
    return next;
  }, [moveInGroups, selectedIds]);

  const payHeaderAction = useCallback(() => {
    const pool = filterChargesForPayMethod(unpaidPayableCharges);
    const ids =
      selectedIds.size > 0
        ? filterChargesForPayMethod(unpaidPayableCharges.filter((c) => selectedIds.has(c.id))).map((c) => c.id)
        : pool.map((c) => c.id);
    if (ids.length === 0) {
      showToast(`No selected charges can be paid with ${residentPaymentMethodLabel(paymentMethod)}.`);
      return;
    }
    if (selectedIds.size === 0) setSelectedIds(new Set(ids));
    openPayConfirm(ids, paymentMethod);
  }, [openPayConfirm, paymentMethod, selectedIds, setSelectedIds, showToast, unpaidPayableCharges]);

  const showCheckoutInExpandedRow = Boolean(
    payConfirm === null && checkout && expandedId && checkout.chargeIds.includes(expandedId),
  );
  const showBulkCheckoutBar = Boolean(
    payConfirm === null && checkout && checkout.chargeIds.length > 1 && !showCheckoutInExpandedRow,
  );

  const renderPaymentMethodPicker = (
    scopeCharges: HouseholdCharge[] = unpaidPayableCharges,
    pickerOptions?: { selected?: ResidentAxisPaymentMethod; onSelect?: (method: ResidentAxisPaymentMethod) => void },
  ) => {
    const selectedMethod = pickerOptions?.selected ?? paymentMethod;
    const onSelectMethod =
      pickerOptions?.onSelect ??
      ((method: ResidentAxisPaymentMethod) => {
        setPaymentMethod(method);
        setCheckout(null);
      });
    const options = paymentMethodOptions.map((option) => ({
      ...option,
      feeLabel: residentProcessingFeeDisplayLabel(option.id),
    }));
    return (
      <div className={`grid gap-2 ${options.length > 2 ? "sm:grid-cols-3" : "grid-cols-2"}`}>
        {options.map((option) => {
          const selected = selectedMethod === option.id;
          // Apple Pay / Google Pay ride on the card method-class in Stripe Checkout.
          const walletHint = option.id === "card";
          return (
            <button
              key={option.id}
              type="button"
              data-attr={`resident-payments-method-${option.id}`}
              onClick={() => {
                onSelectMethod(option.id);
              }}
              className={`flex min-h-[64px] flex-col justify-center rounded-xl border px-3 py-3 text-left transition active:scale-[0.99] ${
                selected
                  ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                  : "border-border bg-card hover:border-primary/30"
              }`}
            >
              <p className="text-sm font-semibold text-foreground">{option.title}</p>
              {walletHint ? (
                <p className="mt-0.5 text-[11px] font-medium text-primary">
                  {isNativeApp ? "Apple Pay in secure checkout" : "Apple Pay · Google Pay"}
                </p>
              ) : null}
              <p className="mt-1 text-xs text-muted">{option.feeLabel}</p>
            </button>
          );
        })}
      </div>
    );
  };

  const renderCheckoutBlock = (label: string) => {
    if (!checkout) return null;
    const scopeCharges = checkout.chargeIds
      .map((id) => charges.find((c) => c.id === id))
      .filter((c): c is HouseholdCharge => Boolean(c));
    return (
      <div className="space-y-3">
        <p className="text-sm font-semibold text-foreground">{label}</p>
        {renderPaymentMethodPicker(scopeCharges)}
        {checkout.totalCents != null && checkout.subtotalCents != null ? (
          <div className="flex items-baseline justify-between rounded-xl border border-border bg-accent/30 px-4 py-3">
            <span className="text-xs text-muted">
              {/* Both fee fields are 0 — PropLane covers processing — so the
                  breakdown collapses to "no added fees". The conditional stays
                  so a fee could never be collected without being shown. */}
              {(checkout.processingFeeCents ?? 0) + (checkout.axisFeeCents ?? 0) > 0 ? (
                <>
                  Subtotal {formatUsd(checkout.subtotalCents)}
                  {checkout.processingFeeCents ? ` · Processing ${formatUsd(checkout.processingFeeCents)}` : ""}
                  {checkout.axisFeeCents ? ` · PropLane fee ${formatUsd(checkout.axisFeeCents)}` : ""}
                </>
              ) : (
                "Total due · no added fees"
              )}
            </span>
            <span className="text-lg font-bold tabular-nums text-foreground">{formatUsd(checkout.totalCents)}</span>
          </div>
        ) : null}
        {checkout.loading ? (
          <p className="text-sm text-muted">Loading secure checkout…</p>
        ) : checkout.error ? (
          <div className="rounded-xl border px-4 py-3 text-sm portal-banner-danger" data-attr="resident-payment-error">
            <p>{checkout.error}</p>
            {checkout.blockedByManagerSetup ? (
              // Never a dead end: a resident who cannot pay by card needs
              // somewhere to go, and Communication is where they reach the
              // manager who has to fix it.
              <Link
                href="/resident/communication/active"
                className="mt-2 inline-block font-semibold underline underline-offset-2"
                data-attr="resident-payment-error-contact-manager"
              >
                Message your property manager
              </Link>
            ) : null}
          </div>
        ) : checkout.clientSecret ? (
          <StripeEmbeddedCheckout clientSecret={checkout.clientSecret} />
        ) : null}
      </div>
    );
  };

  const renderRowDetail = (row: HouseholdCharge) => {
    const payable = isPayableHouseholdCharge(row);
    const achPayable = row.status === "pending" && canPayHouseholdChargeWithAxisAch(row);
    const rowPayIds =
      selectedIds.has(row.id) && selectedIds.size > 1
        ? filterChargesForPayMethod(unpaidPayableCharges.filter((c) => selectedIds.has(c.id))).map((c) => c.id)
        : filterChargesForPayMethod([row]).map((c) => c.id);
    return (
      <>
        <p className="mb-3 text-sm text-muted">
          Due: <span className="font-semibold text-foreground">{chargeDueLabel(row)}</span>
        </p>
        {row.status === "processing" ? (
          <div className={`${PORTAL_INLINE_STATUS_NOTICE_CLASS} bg-[var(--status-pending-bg)] text-[var(--status-pending-fg)]`}>
            <p className="text-xs font-semibold">Bank transfer in progress</p>
            <p className="mt-1 text-sm leading-relaxed">
              Your payment was submitted and is clearing. Bank transfers take 3–5 business days. No late fees or
              reminders apply while it clears, and you&apos;ll get a confirmation the moment it lands.
            </p>
          </div>
        ) : null}
        {payable && rowPayIds.length > 0 ? (
          <p className="mb-4 text-sm text-muted">
            Tap <span className="font-semibold text-foreground">Pay {row.balanceLabel}</span> above to pay through
            PropLane secure checkout, or message your manager if something looks wrong.
          </p>
        ) : !achPayable ? (
          <p className="mb-4 leading-relaxed text-sm text-muted">
            Your property manager will update this charge when online payment is available or when they record payment
            manually.
          </p>
        ) : null}
        {row.status === "paid" && row.paidAt ? (
          <p className="mt-2 text-xs text-muted">Marked paid {safeFormatDateTime(row.paidAt)}</p>
        ) : null}
        {row.blocksLeaseUntilPaid && row.status === "pending" ? (
          <p className="mt-3 text-sm text-amber-900">
            Pay this before signing your lease.{" "}
            <Link href="/resident/lease" className="font-semibold text-primary underline underline-offset-2">
              Open lease tab
            </Link>
            .
          </p>
        ) : null}
        {(row.residentChargeMessages?.length ?? 0) > 0 ? (
          <div className={`${PORTAL_INLINE_STATUS_NOTICE_CLASS} border-border bg-accent/20`}>
            <p className="text-xs font-semibold text-foreground">Messages sent</p>
            <ul className="mt-2 space-y-2">
              {row.residentChargeMessages!.map((entry) => (
                <li key={entry.id} className="text-sm leading-relaxed text-muted">
                  <span className="text-foreground">{entry.body}</span>
                  <span className="mt-0.5 block text-xs">{safeFormatDateTime(entry.sentAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </>
    );
  };

  const showSelectCol = rowsForBucket.length > 0;

  const residentPayeeLabel = isDemoModeActive() ? CANONICAL_DEMO_MANAGER_NAME : "Property manager";

  const renderExpandedActions = (row: HouseholdCharge) => {
    const payable = isPayableHouseholdCharge(row);
    const rowPayIds = filterChargesForPayMethod([row]).map((c) => c.id);
    return (
      <PortalTableDetailActions>
        {payable && rowPayIds.length > 0 ? (
          <Button
            type="button"
            variant="primary"
            className={PORTAL_DETAIL_BTN}
            data-attr="resident-payments-row-pay"
            onClick={(event) => {
              event.stopPropagation();
              openPayConfirm(rowPayIds, paymentMethod);
            }}
          >
            Pay {row.balanceLabel}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          className={PORTAL_DETAIL_BTN}
          data-attr="resident-payments-message-manager"
          onClick={(event) => {
            event.stopPropagation();
            openMessageManagerForCharge(row);
          }}
        >
          Message manager
        </Button>
      </PortalTableDetailActions>
    );
  };

  const confirmCharges = useMemo(() => {
    if (!payConfirm) return [] as HouseholdCharge[];
    return payConfirm.chargeIds
      .map((id) => charges.find((c) => c.id === id))
      .filter((c): c is HouseholdCharge => Boolean(c));
  }, [charges, payConfirm]);

  const confirmSubtotalCents = useMemo(
    () => confirmCharges.reduce((sum, c) => sum + centsFromLabel(c.balanceLabel), 0),
    [confirmCharges],
  );

  const confirmTotalLabel = useMemo(() => formatUsd(confirmSubtotalCents), [confirmSubtotalCents]);
  // The pay sheet names the move-in when the ids are exactly one group's payable lines.
  const confirmMoveInGroup = useMemo(() => {
    if (!payConfirm) return undefined;
    const ids = new Set(payConfirm.chargeIds);
    return moveInGroups.find((group) => {
      const payable = group.items.filter((c) => isPayableHouseholdCharge(c));
      return payable.length > 1 && payable.length === ids.size && payable.every((c) => ids.has(c.id));
    });
  }, [moveInGroups, payConfirm]);

  const payModalCheckoutReady = Boolean(
    payConfirm &&
      checkout &&
      checkout.chargeIds.length === payConfirm.chargeIds.length &&
      payConfirm.chargeIds.every((id) => checkout.chargeIds.includes(id)) &&
      checkout.paymentMethod === payConfirm.method &&
      checkout.clientSecret,
  );

  const payMethodDropdownOptions = useMemo(
    () =>
      paymentMethodOptions.map((option) => ({
        id: option.id,
        title: option.title,
      })),
    [paymentMethodOptions],
  );

  const renderPayModalMethodFooter = () => {
    if (!payConfirm || payMethodDropdownOptions.length === 0) return null;
    const selectedOption = payMethodDropdownOptions.find((option) => option.id === payConfirm.method);
    return (
      <div className="mt-auto space-y-2 border-t border-border pt-4">
        <label htmlFor="resident-payments-pay-method-select" className="text-xs font-semibold text-muted">
          Payment method
        </label>
        <Select
          aria-label="Payment method"
          value={payConfirm.method}
          data-attr="resident-payments-pay-method-select"
          onChange={(event) => {
            selectPayModalMethod(event.target.value as ResidentAxisPaymentMethod);
          }}
        >
          {payMethodDropdownOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.title}
            </option>
          ))}
        </Select>
        {selectedOption ? (
          <p className="text-xs text-muted">
            Secure checkout opens in this window. Apple Pay and Google Pay appear when supported.
          </p>
        ) : null}
      </div>
    );
  };

  const showPayActions =
    paymentsUnlocked &&
    unpaidPayableCharges.length > 0 &&
    (bucket === "pending" || bucket === "overdue");

  const payButtonLabel = selectedIds.size > 0 ? "Pay" : "Pay all";

  const paymentMethodButton =
    paymentsUnlocked && unpaidAchCharges.length > 0 ? (
      <Button
        type="button"
        variant="outline"
        className={PORTAL_COMMAND_ACTION_BTN}
        data-attr="resident-payments-add-payment-method"
        onClick={() => setPaymentMethodModalOpen(true)}
      >
        Payment method
      </Button>
    ) : !paymentsUnlocked ? (
      <Button
        type="button"
        variant="outline"
        className={PORTAL_COMMAND_ACTION_BTN}
        disabled
        onClick={() => showToast("Payments unlock after your application is approved.")}
      >
        Payment method
      </Button>
    ) : null;

  const payButton = showPayActions ? (
    <Button
      type="button"
      variant="primary"
      className={cn(
        PORTAL_BULK_BAR_BTN,
        PORTAL_COMMAND_PRIMARY_ACTION_BTN,
        "!w-auto max-w-none shrink-0 justify-start",
      )}
      style={PORTAL_COMMAND_PRIMARY_ACTION_STYLE}
      data-attr={selectedIds.size > 0 ? "resident-payments-pay-selected" : "resident-payments-pay-all"}
      onClick={payHeaderAction}
    >
      {payButtonLabel}
    </Button>
  ) : null;

  const paySelectionActions = useMemo((): PortalAdaptiveAction[] => {
    if (selectedIds.size === 0) return [];
    return [
      {
        id: "pay",
        keepPriority: 10,
        node: (
          <Button
            type="button"
            variant="primary"
            className={PORTAL_BULK_BAR_BTN}
            data-attr="resident-payments-pay-selected"
            onClick={payHeaderAction}
          >
            Pay
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem data-attr="resident-payments-pay-selected" onSelect={payHeaderAction}>
            Pay
          </DropdownMenuItem>
        ),
      },
    ];
  }, [payHeaderAction, selectedIds.size]);

  const paymentsLockedEmpty = Boolean(email) && !paymentsUnlocked;

  // On Paid, the outstanding balance is $0.00 by definition — showing it turns
  // every paid row into "$0.00" and hides what the resident actually paid. The
  // unpaid buckets keep showing what is still owed.
  const rowAmountLabel = (row: HouseholdCharge) =>
    row.status === "paid" ? row.amountLabel || row.balanceLabel : row.balanceLabel;

  const moveInGroupForRow = useCallback(
    (row: HouseholdCharge): MoveInChargeGroup | undefined =>
      isMoveInGroupId(row.id) ? moveInGroups.find((group) => group.id === row.id) : undefined,
    [moveInGroups],
  );

  const paymentGroupedItems = useMemo((): ResidentPortalGroupableRow<HouseholdCharge>[] => {
    const showPropertyInMeta = RESIDENT_PORTAL_DEFAULT_GROUP_MODE !== "house";
    return rowsForBucket.map((row) => {
      const moveInGroup = moveInGroupForRow(row);
      return {
      id: row.id,
      propertyId: row.propertyId,
      propertyLabel: row.propertyLabel,
      dataListRow: {
        id: row.id,
        data: row,
        primary: row.title || "Charge",
        meta: [
          showPropertyInMeta ? row.propertyLabel : null,
          moveInGroup
            ? `${chargeDueLabel(row)} · ${moveInGroupItemCountLabel(moveInGroup)}`
            : formatCompactChargeLine(row.title || "Charge", row.balanceLabel, chargeDueLabel(row), {
                omitBalance: true,
              }),
        ]
          .filter(Boolean)
          .join(" · "),
        trailing: (
          <span className="text-sm font-semibold tabular-nums text-foreground">{rowAmountLabel(row)}</span>
        ),
        selected: isRowSelected(row.id),
        onSelectedChange: () => toggleSelectedCharge(row.id),
        onClick: isRecordedPaymentRow(row)
          ? undefined
          : () => portalNavigate(residentChargeDetailHref(basePath, bucket, row.id)),
      },
      };
    });
  }, [
    basePath,
    bucket,
    isRowSelected,
    moveInGroupForRow,
    rowsForBucket,
    portalNavigate,
    toggleSelectedCharge,
  ]);

  const renderChargeList = () => (
    <div
      className={cn(
        "portal-list-page-body w-full min-w-0 pb-4 lg:pb-5",
        !showPayActions && "max-lg:pb-[calc(5.5rem+var(--portal-mobile-scroll-bottom-inset,0px))]",
      )}
    >
      <ResidentPortalGroupedDataList
        items={paymentGroupedItems}
        groupMode={RESIDENT_PORTAL_DEFAULT_GROUP_MODE}
        selectable={showSelectCol}
        selectedIds={listSelectedIds}
        onToggleSelected={toggleSelectedCharge}
        dataAttr="resident-payments-grouped-list"
        columns={[
          { id: "charge", header: "Charge", cell: (row) => row.title || "Charge" },
          { id: "property", header: "Property", cell: (row) => row.propertyLabel || "—" },
          { id: "due", header: "Due", cell: (row) => chargeDueLabel(row) },
          {
            id: "amount",
            header: "Amount",
            cell: (row) => rowAmountLabel(row),
            headerClassName: "text-right",
            cellClassName: "text-right tabular-nums",
          },
        ]}
        emptyState={
          <PortalDataTableEmpty
            icon="payment"
            message={
              bucket === "overdue"
                ? "No overdue charges."
                : bucket === "pending"
                  ? "No upcoming charges."
                  : "No payments in this tab yet."
            }
          />
        }
      />
    </div>
  );

  const paymentsBody = (
    <div className={paymentsLockedEmpty ? "space-y-0" : undefined}>
      {!paymentsUnlocked ? (
        <p className={paymentsLockedEmpty ? PORTAL_INLINE_UNLOCK_NOTICE_STACKED_CLASS : PORTAL_INLINE_UNLOCK_NOTICE_CLASS}>
          <span className="font-semibold">Payments unlock after your application is approved.</span>{" "}
          Application fees, rent, and deposits become available once your property manager approves your application.
        </p>
      ) : null}

      {!email ? (
        <p className="text-sm text-muted">Sign in to see your application fees, rent, and deposits.</p>
      ) : !paymentsUnlocked ? (
        <PortalDataTableEmpty icon="payment" message="No charges yet." variant="stacked" />
      ) : (
        <>
          {bucket === "pending" && rentReporting && (rentReporting.addonAvailable || rentReporting.upgradeRequired) ? (
            <div className="mb-4 rounded-xl border border-border bg-card p-4" data-attr="resident-rent-reporting-card">
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm font-semibold text-foreground">Report my rent to credit bureaus</span>
                {rentReporting.upgradeRequired ? (
                  <Link href="/pricing" className="text-sm font-semibold text-primary hover:underline" data-attr="resident-rent-reporting-upgrade">
                    Upgrade
                  </Link>
                ) : (
                  <FieldSingleSelect
                    label="Report my rent to credit bureaus"
                    hideLabel
                    variant="cell"
                    wrapperClassName="w-28"
                    value={rentReporting.status === "active" ? "on" : "off"}
                    onChange={(next) => void rentReportingToggle(next)}
                    disabled={rentReportingBusy}
                    options={[
                      { value: "on", label: "On" },
                      { value: "off", label: "Off" },
                    ]}
                    dataAttr="resident-rent-reporting-toggle"
                  />
                )}
              </div>
              {rentReporting.status === "active" ? (
                <div className="mt-3 space-y-2 border-t border-border pt-3">
                  {rentReporting.reportedAs ? (
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-sm text-muted">Reported as</span>
                      <span className="text-sm font-medium text-foreground">{rentReporting.reportedAs}</span>
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm text-muted">Last report</span>
                    <span className="text-sm font-medium text-foreground" data-attr="resident-rent-reporting-last-report">
                      {rentReporting.lastSubmission ? rentReportingLastReportLabel(rentReporting.lastSubmission) : "Not sent yet"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm text-muted">Bureaus</span>
                    <span className="text-sm font-medium text-foreground">{rentReporting.bureaus}</span>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {showBulkCheckoutBar && checkout ? (
            <div className="mb-4 rounded-xl border border-border bg-card p-3 sm:p-4">
              {renderCheckoutBlock(
                checkout.chargeIds.length > 1
                  ? `Pay ${checkout.chargeIds.length} charges (${formatUsd(
                      checkout.chargeIds.reduce((sum, id) => {
                        const charge = charges.find((c) => c.id === id);
                        return sum + (charge ? centsFromLabel(charge.balanceLabel) : 0);
                      }, 0),
                    )})`
                  : `Pay online (${residentPaymentMethodLabel(checkout?.paymentMethod ?? paymentMethod)})`,
              )}
            </div>
          ) : null}
          {rows.length === 0 ? (
            <PortalDataTableEmpty icon="payment" message="No charges yet." />
          ) : rowsForBucket.length === 0 ? (
            <PortalDataTableEmpty
              icon="payment"
              message={
                bucket === "overdue"
                  ? "No overdue charges."
                  : bucket === "pending"
                    ? "No upcoming charges."
                    : "No payments in this tab yet."
              }
            />
          ) : chargeIdProp ? null : (
            renderChargeList()
          )}
        </>
      )}
    </div>
  );

  const paymentModals = (
    <>
    <Modal
      open={rentReportingConsentOpen}
      onClose={() => {
        if (rentReportingBusy) return;
        setRentReportingConsentOpen(false);
        setRentReportingError(null);
      }}
      title="Turn on rent reporting"
      description="PropLane will send your rent payment history for this lease to Experian, TransUnion and Equifax each month, starting with the payments already made under this lease. On-time payments can raise your score; a payment more than 30 days late is reported as late. You can turn this off at any time, and reporting stops the next cycle."
      panelClassName="max-w-md"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" disabled={rentReportingBusy} onClick={() => setRentReportingConsentOpen(false)}>
            Not now
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={rentReportingBusy || !rentReportingLegalName.trim() || !rentReportingDob.trim()}
            onClick={() => submitRentReportingConsent()}
          >
            I agree, turn it on
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {rentReportingError ? (
          <p role="alert" className="text-sm text-danger">
            {rentReportingError}
          </p>
        ) : null}
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-foreground">Legal name on your credit file</span>
          <Input
            value={rentReportingLegalName}
            onChange={(e) => setRentReportingLegalName(e.target.value)}
            placeholder="Full legal name"
            data-attr="resident-rent-reporting-legal-name"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-foreground">Date of birth</span>
          <Input
            type="date"
            value={rentReportingDob}
            onChange={(e) => setRentReportingDob(e.target.value)}
            data-attr="resident-rent-reporting-dob"
          />
        </label>
      </div>
    </Modal>
    <Modal
      open={paymentMethodModalOpen}
      onClose={() => {
        setSetupCheckout(null);
        setPaymentMethodModalOpen(false);
      }}
      title="Payment methods"
      panelClassName="max-w-lg"
    >
      {setupCheckout ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Add {setupCheckout.kind === "card" ? "a credit card" : "a bank account"} to pay in PropLane.
          </p>
          <StripeEmbeddedCheckout clientSecret={setupCheckout.clientSecret} />
          <div className="flex justify-start">
            <Button type="button" variant="outline" className="rounded-full" onClick={() => setSetupCheckout(null)}>
              Back
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted">
            Save a bank account or card for faster checkout. Choose your default below — you pick how to pay each time
            you pay a charge.
          </p>

          <div>
            {savedMethodsLoading ? (
              <p className="text-sm text-muted">Loading saved methods…</p>
            ) : savedMethods.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border bg-accent/20 px-4 py-3 text-sm text-muted">
                No saved payment methods yet. Add a bank account or card below.
              </p>
            ) : (
              <ul className="space-y-2" role="radiogroup" aria-label="Default payment method">
                {savedMethods.map((method) => (
                  <li key={method.id}>
                    <label
                      className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-3 transition ${
                        method.isDefault
                          ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                          : "border-border bg-card hover:border-primary/30"
                      }`}
                    >
                      <input
                        type="radio"
                        name="resident-default-payment-method"
                        className="h-4 w-4 shrink-0 border-border text-primary"
                        checked={method.isDefault}
                        disabled={settingDefaultId !== null}
                        data-attr="resident-payments-set-default"
                        onChange={() => {
                          if (!method.isDefault) void setDefaultPaymentMethod(method.id);
                        }}
                      />
                      <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{method.label}</span>
                      {method.isDefault ? (
                        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-primary">
                          Default
                        </span>
                      ) : settingDefaultId === method.id ? (
                        <span className="shrink-0 text-xs text-muted">Saving…</span>
                      ) : null}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Add</p>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-xl border border-dashed border-border bg-card px-4 py-3 text-left text-sm font-semibold text-foreground transition hover:border-primary/40 hover:bg-primary/5 disabled:opacity-60"
              disabled={setupLoading !== null}
              data-attr="resident-payments-add-bank"
              onClick={() => { return startAddPaymentMethod("ach"); }}
            >
              <span>Bank (ACH)</span>
              <span className="text-xs font-medium text-muted">
                {setupLoading === "ach" ? "Loading…" : "Add"}
              </span>
            </button>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-xl border border-dashed border-border bg-card px-4 py-3 text-left text-sm font-semibold text-foreground transition hover:border-primary/40 hover:bg-primary/5 disabled:opacity-60"
              disabled={setupLoading !== null}
              data-attr="resident-payments-add-card"
              onClick={() => { return startAddPaymentMethod("card"); }}
            >
              <span>Credit card</span>
              <span className="text-xs font-medium text-muted">
                {setupLoading === "card" ? "Loading…" : "Add"}
              </span>
            </button>
          </div>
        </div>
      )}
    </Modal>

    {payConfirm && payModalStep === "select" ? (
      <PortalDialog
        open
        onClose={closePayModal}
        title="Pay charges"
        primaryAction={{
          label: `Pay ${confirmTotalLabel}`,
          onClick: () => void continuePayModal(),
          disabled: checkout?.loading,
          dataAttr: "resident-payments-confirm-pay",
        }}
      >
        <div className="flex min-h-[min(50vh,20rem)] flex-col gap-4">
          <div className="flex flex-1 flex-col justify-center space-y-4">
            <div className="space-y-1 text-center">
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Amount due</p>
              <p className="text-3xl font-bold tabular-nums tracking-tight text-foreground">{confirmTotalLabel}</p>
              {confirmMoveInGroup ? (
                <p className="text-sm text-muted">Move-in total · {moveInGroupItemCountLabel(confirmMoveInGroup)}</p>
              ) : confirmCharges.length > 1 ? (
                <p className="text-sm text-muted">{confirmCharges.length} charges</p>
              ) : confirmCharges[0]?.title ? (
                <p className="text-sm text-muted">{confirmCharges[0].title}</p>
              ) : null}
            </div>
            {payConfirm.method ? (
              <p className="text-center text-xs text-muted">No added fees · PropLane covers payment processing</p>
            ) : null}
          </div>
          {renderPayModalMethodFooter()}
        </div>
      </PortalDialog>
    ) : null}

    {/* The checkout step stops at the Stripe element: its own Back control and
        embedded iframe are unchanged, not folded into PortalDialog's fixed
        footer, since the commit action there lives inside the iframe. */}
    <Modal
      open={payConfirm !== null && payModalStep !== "select"}
      onClose={closePayModal}
      title="Pay charges"
      scrollableContent
      panelClassName={payModalCheckoutReady ? MODAL_LARGE_PANEL_CLASS : "max-w-lg"}
    >
      {payConfirm ? (
        <div className="flex min-h-[min(50vh,20rem)] flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <Button
              type="button"
              variant="outline"
              className="rounded-full"
              disabled={checkout?.loading}
              onClick={() => {
                setPayModalStep("select");
                setCheckout(null);
              }}
            >
              Back
            </Button>
            <p className="text-sm text-foreground">
              <span className="font-semibold tabular-nums">{confirmTotalLabel}</span>
            </p>
          </div>
          <div className="space-y-3">
            {checkout?.loading ? (
              <p className="text-sm text-muted">Loading secure checkout…</p>
            ) : checkout?.error ? (
              <div className="rounded-xl border px-4 py-3 text-sm portal-banner-danger" data-attr="resident-payment-error">
                <p>{checkout.error}</p>
                {checkout.blockedByManagerSetup ? (
                  // Never a dead end: a resident who cannot pay by card needs
                  // somewhere to go, and Communication is where they reach the
                  // manager who has to fix it.
                  <Link
                    href="/resident/communication/active"
                    className="mt-2 inline-block font-semibold underline underline-offset-2"
                    data-attr="resident-payment-error-contact-manager"
                  >
                    Message your property manager
                  </Link>
                ) : null}
              </div>
            ) : payModalCheckoutReady && checkout?.clientSecret ? (
              <div className="min-h-[min(50vh,28rem)] overflow-hidden rounded-2xl border border-border bg-card">
                <StripeEmbeddedCheckout clientSecret={checkout.clientSecret} />
              </div>
            ) : (
              <p className="text-sm text-muted">Could not load secure checkout. Go back and try again.</p>
            )}
          </div>
        </div>
      ) : null}
    </Modal>

    </>
  );

  const paymentsCommandActions = paymentMethodButton;

  if (chargeIdProp && detailMoveInGroup) {
    const group = detailMoveInGroup;
    const payableIds = filterChargesForPayMethod(group.items.filter((c) => isPayableHouseholdCharge(c))).map(
      (c) => c.id,
    );
    const payableCents = group.items
      .filter((c) => payableIds.includes(c.id))
      .reduce((sum, c) => sum + centsFromLabel(c.balanceLabel), 0);
    return (
      <>
        <PortalRecordDetailPage
          pageTitle="Payments"
          title="Move-in total"
          subtitle={group.propertyLabel || undefined}
          backHref={residentChargesListHref(basePath, bucket)}
          hideBackText
          bareHeader
          dataAttrBack="resident-payment-detail-back"
          inlineActions
          actions={
            <PortalTableDetailActions>
              {payableIds.length > 0 ? (
                <Button
                  type="button"
                  variant="primary"
                  className={PORTAL_DETAIL_BTN}
                  data-attr="resident-payments-move-in-pay"
                  onClick={(event) => {
                    event.stopPropagation();
                    openPayConfirm(payableIds, paymentMethod);
                  }}
                >
                  Pay {formatUsd(payableCents)}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                className={PORTAL_DETAIL_BTN}
                data-attr="resident-payments-message-manager"
                onClick={(event) => {
                  event.stopPropagation();
                  openMessageManagerForCharge(group.items[0]);
                }}
              >
                Message manager
              </Button>
            </PortalTableDetailActions>
          }
        >
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <p className="text-sm text-muted">
              Due: <span className="font-semibold text-foreground">{group.dueLabel}</span>
            </p>
            <p className="text-2xl font-bold tabular-nums tracking-tight text-foreground" data-attr="resident-payments-move-in-total">
              {group.totalLabel}
            </p>
          </div>
          <ul className="divide-y divide-border rounded-xl border border-border bg-card" data-attr="resident-payments-move-in-breakdown">
            {group.items.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{item.title || "Charge"}</p>
                  <p className="text-xs text-muted">
                    {item.status === "processing" ? "Bank transfer clearing" : chargeDueLabel(item)}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">{item.balanceLabel}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-muted">
            One payment covers everything above. Your deposit is still held separately, so it is refunded on its own
            terms when you move out.
          </p>
          {group.blocksLeaseUntilPaid ? (
            <p className="mt-3 text-sm text-amber-900">
              Pay this before signing your lease.{" "}
              <Link href="/resident/lease" className="font-semibold text-primary underline underline-offset-2">
                Open lease tab
              </Link>
              .
            </p>
          ) : null}
        </PortalRecordDetailPage>
        {paymentModals}
      </>
    );
  }

  if (chargeIdProp && detailCharge) {
    return (
      <>
        <PortalRecordDetailPage
          pageTitle="Payments"
          title={detailCharge.title || "Charge"}
          subtitle={detailCharge.propertyLabel || undefined}
          backHref={residentChargesListHref(basePath, bucket)}
          hideBackText
          bareHeader
          dataAttrBack="resident-payment-detail-back"
          inlineActions
          actions={renderExpandedActions(detailCharge)}
        >
          {renderRowDetail(detailCharge)}
        </PortalRecordDetailPage>
        {paymentModals}
      </>
    );
  }

  if (chargeIdProp) {
    return (
      <ManagerPortalPageShell title="Payments" hideTitleOnMobileNav>
        <PortalDataTableEmpty icon="payment" message="Charge not found." />
      </ManagerPortalPageShell>
    );
  }

  return (
    <>
      <ManagerPortalPageShell title="Payments" hideTitleOnMobileNav compactFilterRow>
        <PortalListControlStack
          className={paymentsLockedEmpty ? "mb-0" : "mb-2 max-lg:mb-1.5"}
          variant="command"
          stickyDestinations={false}
          destinations={statusTabs.map((t) => ({
            id: t.id,
            label: t.label,
            href: residentChargesListHref(basePath, t.id),
            count: t.count,
            alert: "alert" in t ? t.alert : undefined,
            dataAttr: t.dataAttr,
          }))}
          activeDestinationId={bucket}
          destinationAriaLabel="Payment status"
          actions={paymentsCommandActions ?? undefined}
        />
        {managerStripeConnectBlocked ? (
          <div
            className={`${PORTAL_INLINE_STATUS_NOTICE_CLASS} mb-3 border-[var(--status-pending-border)] bg-[var(--status-pending-bg)] text-[var(--status-pending-fg)]`}
            data-attr="resident-payments-connect-blocked"
          >
            Your property manager is still finishing PropLane payment setup, so bank and card checkout
            is not available yet. Message your manager in Communication if you need help.
          </div>
        ) : platformCheckoutAvailable ? (
          <p className="mb-3 px-1 text-sm text-muted" data-attr="resident-payments-platform-copy">
            Pay rent through PropLane secure checkout — bank transfer, card, Apple Pay, or Google Pay.
          </p>
        ) : null}
        {!paymentsLockedEmpty ? (
          <div className="mb-3">
            <ResidentAutopayCard
              onManagePaymentMethods={() => setPaymentMethodModalOpen(true)}
              onPayChargeNow={(chargeId) => openPayConfirm([chargeId], paymentMethod)}
            />
          </div>
        ) : null}
        {showPayActions && selectedIds.size === 0 ? <div className="mb-3 flex justify-end">{payButton}</div> : null}<PortalRecordListSurface className="mt-0" onBulkClear={() => { for (const id of selectedIds) toggleSelected(id); }} bulkCount={selectedIds.size} bulkActions={<PortalAdaptiveActionRow actions={paySelectionActions} />}>{paymentsBody}</PortalRecordListSurface>
      </ManagerPortalPageShell>

      {paymentModals}
    </>
  );
}
