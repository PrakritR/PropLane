/**
 * Per-resident charge lines (application fee, security deposit, etc.) tied to listings.
 * Supabase is the persistence layer; this module keeps only in-memory page-session state.
 */

import { isDemoModeActive } from "@/lib/demo/demo-session";
import { createCoalescedRefresher, type CoalescedRefresher } from "@/lib/coalesced-refresh";
import { getPropertyById } from "@/lib/rental-application/data";
import { parseMoneyAmount } from "@/lib/parse-money";
import { paymentAtSigningPriceLabel } from "@/lib/rental-application/listing-fees-display";
import {
  entireHomeMonthlyRentAmount,
  isEntireHomeListing,
  normalizeManagerListingSubmissionV1,
  type ManagerCustomFeeRow,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { listingPresetFeeAmount } from "@/lib/listing-fees";
import { formatRoomPriceAmount, resolveStayPricing, roomDailyRentPrice } from "@/lib/room-pricing";
import { resolveSubmissionRoom } from "@/lib/listing-room-resolution";
import { utilitiesBillableMonthlyAmount } from "@/lib/listing-utilities-payment";
import { paymentSnapshotsFromListing } from "@/lib/household-charge-payment-eligibility";
import { ensureChargeDueDateForReminders } from "@/lib/payment-reminder-bootstrap";
import {
  rentDueDayModeFromSubmission,
  resolveRentDueDayForMonth,
  type RentDueDayMode,
  type ResidentAcceptedPaymentMethod,
} from "@/lib/payment-policy";
import { shouldReconcileResidentPaymentSchedule } from "@/lib/current-resident";
import { applicationVisibleToPortalUser } from "@/lib/manager-portfolio-access";
import type { DemoManagerPaymentLedgerRow, ManagerPaymentBucket } from "@/data/demo-portal";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { readManagerApplicationRows } from "@/lib/manager-applications-storage";
import { generatePaymentReference } from "@/lib/payment-reference";
import {
  intraMonthStaySpan,
  shortTermStayChargeTitle,
  shortTermStayNightCount,
  shortTermStayTotalAmount,
} from "@/lib/short-term-stay-pricing";
import {
  normalizeGroupId,
} from "@/lib/rental-application/application-groups";
import {
  buildBundleApplicationGroups,
  bundleIdForApplication,
  isBundleGroupApplication,
  memberIndexInBundleGroup,
  type BundleGroupRowInput,
} from "@/lib/bundle-group/bundle-group-application";
import {
  resolveBundleFinancialTotals,
  splitMoneyEvenly,
  splitShareLabel,
  moneyLabel,
} from "@/lib/bundle-group/bundle-cost-split";
import { notePortalResponse, portalSessionEnded } from "@/lib/auth/portal-session-gate";

export const HOUSEHOLD_CHARGES_EVENT = "axis:household-charges";

/** Default holding deposit for new listings when the manager leaves the field blank. */
export const DEFAULT_HOLDING_DEPOSIT_LABEL = "$100";

export function normalizeHoldingDepositLabel(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return DEFAULT_HOLDING_DEPOSIT_LABEL;
  return trimmed;
}

function withPaymentReference(charge: HouseholdCharge): HouseholdCharge {
  return {
    ...charge,
    paymentReference: charge.paymentReference?.trim() || generatePaymentReference(charge.id),
  };
}

let memoryCharges: HouseholdCharge[] = [];
let memoryRentProfiles: RecurringRentProfile[] = [];
const HOUSEHOLD_CHARGES_SYNC_TTL_MS = 15_000;
let householdChargesLastSyncedAt = 0;
type HouseholdChargesSyncResult = { charges: HouseholdCharge[]; rentProfiles: RecurringRentProfile[] };
let householdChargesSyncPromise: Promise<HouseholdChargesSyncResult> | null = null;
const householdChargesRefreshers = new Map<string, CoalescedRefresher<HouseholdChargesSyncResult>>();
export const HOUSEHOLD_CHARGES_SESSION_KEY = "axis:household-charges:v1";
const HOUSEHOLD_RENT_PROFILES_SESSION_KEY = "axis:household-rent-profiles:v1";

function chargesChanged(a: HouseholdCharge[], b: HouseholdCharge[]) {
  return JSON.stringify(dedupeCharges(a)) !== JSON.stringify(dedupeCharges(b));
}

function rentProfilesChanged(a: RecurringRentProfile[], b: RecurringRentProfile[]) {
  return JSON.stringify(dedupeRecurringRentProfiles(a)) !== JSON.stringify(dedupeRecurringRentProfiles(b));
}

/** When no manager Supabase session, work-order pass-through charges use this scope so Payments still lists them. */
export const HOUSEHOLD_CHARGE_DEMO_MANAGER_SCOPE = "__axis_demo_manager_scope__";

export type HouseholdChargeKind =
  | "application_fee"
  | "holding_deposit"
  | "stay_total"
  | "first_month_rent"
  | "prorated_rent"
  | "prorated_last_month_rent"
  | "rent"
  | "utilities"
  | "prorated_utilities"
  | "prorated_last_month_utilities"
  | "security_deposit"
  | "move_in_fee"
  | "other_cost"
  | "payment_at_signing"
  | "work_order_charge"
  | "late_fee"
  /** Not created anywhere yet (Phase 2/6 of the financials buildout) — added now so the category mapping exists ahead of that work. */
  | "nsf_fee";

export type ResidentChargeMessage = {
  id: string;
  body: string;
  sentAt: string;
  residentUserId: string;
};

export type HouseholdCharge = {
  id: string;
  createdAt: string;
  applicationId?: string;
  residentEmail: string;
  residentName: string;
  residentUserId: string | null;
  propertyId: string;
  propertyLabel: string;
  managerUserId: string | null;
  kind: HouseholdChargeKind;
  title: string;
  amountLabel: string;
  balanceLabel: string;
  /** `processing` = ACH bank debit submitted, clearing (3–5 business days) — not payable, not overdue, no reminders/late fees. */
  status: "pending" | "processing" | "partially_paid" | "paid" | "cancelled" | "refunded" | "failed";
  paidAmountCents?: number;
  paidAt?: string;
  /** Snapshot of Zelle / SMS contact from listing when charge was created */
  zelleContactSnapshot?: string;
  /** Snapshot of Venmo contact from listing when charge was created */
  venmoContactSnapshot?: string;
  /** Resident-reported manual payment channel (Zelle/Venmo); charge stays pending until manager marks paid. */
  manualPaymentChannel?: "zelle" | "venmo";
  /** ISO timestamp when the resident confirmed they sent a manual payment. */
  manualPaymentReportedAt?: string;
  /** Short memo code residents include in Zelle/Venmo payments for manager matching. */
  paymentReference?: string;
  /** Resident questions or issues about this charge, newest last. */
  residentChargeMessages?: ResidentChargeMessage[];
  /** Gmail API message id when auto-marked from linked Gmail sync. */
  paidViaGmailMessageId?: string;
  /** Snapshot of whether Axis ACH was enabled on the listing when the charge was created or synced. */
  axisPaymentsEnabledSnapshot?: boolean;
  /** Payment methods the property currently accepts, refreshed from the listing on each server sync. */
  acceptedPaymentMethodsSnapshot?: ResidentAcceptedPaymentMethod[];
  /** When true, lease signing stays disabled until this line is paid */
  blocksLeaseUntilPaid: boolean;
  /** When this charge was created from a manager work order pass-through */
  workOrderId?: string;
  recurringRentProfileId?: string;
  rentMonth?: string;
  /** Set on charges generated from a listing custom fee (`ManagerCustomFeeRow.id`). It gives
   *  each custom fee its own charge identity so several custom fees — and a monthly custom
   *  fee across months — never collapse onto the single `other_cost|applicationId` key. */
  customFeeId?: string;
  dueDay?: number;
  /** When set, dueDay is computed per month (1st vs last day). */
  dueDayMode?: RentDueDayMode;
  dueDateLabel?: string;
  cancelledReminders?: Array<"7d" | "5d" | "3d" | "12h" | "overdue_daily">;
  /** Late fee assessed against this original charge id. */
  sourceChargeId?: string;
  /** Bundle group cost split metadata (equal shares of household totals). */
  bundleGroupId?: string;
  bundleId?: string;
  splitMemberIndex?: number;
  splitMemberCount?: number;
  splitTotalAmountLabel?: string;
};

export type RecurringRentProfile = {
  id: string;
  residentEmail: string;
  residentName: string;
  residentUserId: string | null;
  propertyId: string;
  propertyLabel: string;
  roomLabel: string;
  managerUserId: string | null;
  monthlyRent: number;
  /**
   * Headline daily rent rate (USD dollars) when the room is priced by the day.
   * When set (> 0), each recurring rent charge bills days-in-month × dailyRentPrice
   * instead of the flat monthlyRent, and the partial last month bills its billable
   * days × dailyRentPrice. Absent → the profile bills monthly exactly as before.
   */
  dailyRentPrice?: number;
  /** Full monthly utilities/RUBS from listing or manager override — billed each month with rent. */
  monthlyUtilities?: number;
  /** Monthly custom fees (parking, storage, …) billed each recurring month alongside rent.
   *  Each fee's `id` is stable so its charges dedupe across syncs and can be purged on removal. */
  monthlyFees?: { id: string; label: string; amount: number }[];
  /**
   * Bundle-group split, carried so the RECURRING months divide the household
   * total the same way the move-in charges do.
   *
   * `monthlyRent` / `monthlyUtilities` / `monthlyFees` are stored as the FULL
   * household amounts (`selectedRoomRentAmount` returns the bundle's total),
   * and only the upfront charges used to pass through `applyBundleGroupSplit`.
   * The recurring generator applied no split at all, so each member of a group
   * was billed the whole household rent every month after move-in — a 3-person
   * group on a $2,400 bundle paid a correct $800 each at move-in and then
   * $2,400 each, every month, dunned and late-feed like any other balance.
   *
   * Absent → no split, which is every non-bundle profile and therefore the
   * unchanged path.
   */
  bundleGroupId?: string;
  bundleId?: string;
  splitMemberIndex?: number;
  splitMemberCount?: number;
  dueDay: number;
  dueDayMode?: RentDueDayMode;
  startMonth: string;
  /** ISO date YYYY-MM-DD — last day of the lease; used to prorate the final partial month. */
  leaseEnd?: string;
  active: boolean;
  updatedAt: string;
  zelleContact?: string;
  venmoContact?: string;
};

type LeaseBoundaryProration = {
  prorated: boolean;
  factor: number;
  billableDays: number;
  daysInMonth: number;
  dueDateLabel?: string;
};

function isBrowser() {
  return typeof window !== "undefined";
}

function hydrateHouseholdStateFromSession() {
  if (!isBrowser()) return;
  try {
    if (memoryCharges.length === 0) {
      const rawCharges = window.sessionStorage.getItem(HOUSEHOLD_CHARGES_SESSION_KEY);
      if (rawCharges) {
        const parsed = JSON.parse(rawCharges) as HouseholdCharge[];
        if (Array.isArray(parsed)) memoryCharges = dedupeCharges(parsed);
      }
    }
    if (memoryRentProfiles.length === 0) {
      const rawProfiles = window.sessionStorage.getItem(HOUSEHOLD_RENT_PROFILES_SESSION_KEY);
      if (rawProfiles) {
        const parsed = JSON.parse(rawProfiles) as RecurringRentProfile[];
        if (Array.isArray(parsed)) memoryRentProfiles = dedupeRecurringRentProfiles(parsed);
      }
    }
  } catch {
    /* ignore */
  }
}

function persistHouseholdStateToSession() {
  if (!isBrowser()) return;
  try {
    window.sessionStorage.setItem(HOUSEHOLD_CHARGES_SESSION_KEY, JSON.stringify(memoryCharges));
    window.sessionStorage.setItem(HOUSEHOLD_RENT_PROFILES_SESSION_KEY, JSON.stringify(memoryRentProfiles));
  } catch {
    /* ignore */
  }
}

function reconcileChargeWithLocal(serverCharge: HouseholdCharge, local: HouseholdCharge | undefined): HouseholdCharge {
  if (!local) return serverCharge;
  // Local mark-paid must win over stale server pending rows (including duplicate ids for the same bill).
  if (local.status === "paid") {
    return {
      ...local,
      status: "paid",
      paidAt: local.paidAt ?? serverCharge.paidAt,
      balanceLabel: "$0.00",
    };
  }
  if (serverCharge.status === "paid") {
    return { ...local, status: "paid", paidAt: serverCharge.paidAt, balanceLabel: "$0.00" };
  }
  return local;
}

/** Exported for unit tests — merges server rows with in-session manager edits. */
export function mergeHouseholdChargesWithServer(serverCharges: HouseholdCharge[], localCharges: HouseholdCharge[]): {
  merged: HouseholdCharge[];
  hasUpdated: boolean;
} {
  const localById = new Map(localCharges.map((c) => [c.id, c]));
  const localByBusinessKey = new Map(localCharges.map((c) => [chargeBusinessKey(c), c]));
  const serverIds = new Set(serverCharges.map((c) => c.id));
  const serverKeys = new Set(serverCharges.map((c) => chargeBusinessKey(c)));
  let hasUpdated = false;

  const reconciled: HouseholdCharge[] = serverCharges.map((sc) => {
    const local = localById.get(sc.id) ?? localByBusinessKey.get(chargeBusinessKey(sc));
    const merged = reconcileChargeWithLocal(sc, local);
    if (local?.status === "paid" && sc.status !== "paid") hasUpdated = true;
    if (local && (local.amountLabel !== sc.amountLabel || local.title !== sc.title)) hasUpdated = true;
    return merged;
  });

  const localOnly = localCharges.filter((c) => !serverIds.has(c.id) && !serverKeys.has(chargeBusinessKey(c)));
  if (localOnly.some((c) => c.status === "paid")) hasUpdated = true;
  return { merged: dedupeCharges([...reconciled, ...localOnly]), hasUpdated };
}

function mergeServerAuthoritativeRentProfiles(serverProfiles: RecurringRentProfile[], localProfiles: RecurringRentProfile[]) {
  const serverIds = new Set(serverProfiles.map((profile) => profile.id));
  const serverKeys = new Set(serverProfiles.map((profile) => recurringRentProfileKey(profile)));
  const localOnly = localProfiles.filter(
    (profile) => !serverIds.has(profile.id) && !serverKeys.has(recurringRentProfileKey(profile)),
  );
  return dedupeRecurringRentProfiles([...serverProfiles, ...localOnly]);
}

function emit() {
  if (!isBrowser()) return;
  window.dispatchEvent(new Event(HOUSEHOLD_CHARGES_EVENT));
}

function postHouseholdPayload(body: unknown) {
  if (!isBrowser() || isDemoModeActive()) return;
  void postHouseholdPayloadAwait(body).catch(() => { /* fire-and-forget */ });
}

async function postHouseholdPayloadAwait(body: unknown): Promise<boolean> {
  if (!isBrowser() || isDemoModeActive()) return false;
  const res = await fetch("/api/portal-household-charges", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok;
}

function deleteChargeRowFromServer(id: string) {
  postHouseholdPayload({ action: "deleteCharge", id });
}

function mirrorChargeRows(rows: HouseholdCharge[]) {
  postHouseholdPayload({ action: "replace", charges: rows, rentProfiles: readRentProfiles() });
}

/** Await server persistence after regenerating charges so a forced sync cannot resurrect stale rows. */
export async function mirrorHouseholdChargesToServerAwait(): Promise<boolean> {
  return postHouseholdPayloadAwait({
    action: "replace",
    charges: readAll(),
    rentProfiles: readRentProfiles(),
  });
}

function mirrorRentProfiles(rows: RecurringRentProfile[]) {
  postHouseholdPayload({ action: "replace", charges: readAll(), rentProfiles: rows });
}

export async function syncHouseholdChargesFromServer(
  force = false,
  { skipReconcile = false }: { skipReconcile?: boolean } = {},
): Promise<HouseholdChargesSyncResult> {
  if (!isBrowser()) return { charges: [], rentProfiles: [] };
  if (isDemoModeActive()) {
    hydrateHouseholdStateFromSession();
    return { charges: readAll(), rentProfiles: readRentProfiles() };
  }
  // Signed out: stop the interval-driven refetch instead of 401ing forever.
  if (portalSessionEnded()) {
    hydrateHouseholdStateFromSession();
    return { charges: readAll(), rentProfiles: readRentProfiles() };
  }
  if (!force && householdChargesSyncPromise) return householdChargesSyncPromise;
  if (!force && householdChargesLastSyncedAt > 0 && Date.now() - householdChargesLastSyncedAt < HOUSEHOLD_CHARGES_SYNC_TTL_MS) {
    return { charges: readAll(), rentProfiles: readRentProfiles() };
  }
  // `force` bypasses the TTL by design, so the panels that force a refresh on
  // mount each issued their own request (measured: 3 on one `/portal/payments`
  // load). Collapse concurrent forced callers without ever serving one a fetch
  // that began before it asked — this is a money path, so a forced read after a
  // charge write must never be answered from a read that predates the write.
  // Keyed on `skipReconcile`, which changes what the run WRITES back (the
  // resident path must not run the manager's reconcile), so the two can never
  // share a run.
  const key = skipReconcile ? "skipReconcile" : "reconcile";
  let refresher = householdChargesRefreshers.get(key);
  if (!refresher) {
    refresher = createCoalescedRefresher(() => runHouseholdChargesSync({ skipReconcile }));
    householdChargesRefreshers.set(key, refresher);
  }
  return refresher.run(force);
}

async function runHouseholdChargesSync({
  skipReconcile,
}: {
  skipReconcile: boolean;
}): Promise<HouseholdChargesSyncResult> {
  const syncPromise = fetch("/api/portal-household-charges")
    .then(async (res) => {
      notePortalResponse(res.status);
      const body = res.ok ? (await res.json() as { charges?: HouseholdCharge[]; rentProfiles?: RecurringRentProfile[] }) : {};
      const serverCharges = Array.isArray(body.charges) ? body.charges : [];
      const serverProfiles = Array.isArray(body.rentProfiles) ? body.rentProfiles : [];
      hydrateHouseholdStateFromSession();
      let mergedCharges: HouseholdCharge[];
      let hasUpdatedCharges = false;
      if (skipReconcile) {
        // Resident portal: residents never generate charges locally, so server amounts are
        // always correct. Using the local-wins merge would lock stale session data in place
        // whenever the manager updates charge amounts (e.g. switching proration methods).
        mergedCharges = dedupeCharges(serverCharges);
      } else {
        const result = mergeHouseholdChargesWithServer(serverCharges, memoryCharges);
        mergedCharges = result.merged;
        hasUpdatedCharges = result.hasUpdated;
      }
      const mergedProfiles = mergeServerAuthoritativeRentProfiles(serverProfiles, memoryRentProfiles);
      const hasLocalOnlyCharges = mergedCharges.length > serverCharges.length;
      const hasLocalOnlyProfiles = mergedProfiles.length > serverProfiles.length;
      memoryCharges = mergedCharges;
      memoryRentProfiles = mergedProfiles;
      persistHouseholdStateToSession();
      // Push to server if we have local-only rows or local amounts that differ from what the server stored.
      if (hasLocalOnlyCharges || hasLocalOnlyProfiles || hasUpdatedCharges) {
        postHouseholdPayload({ action: "replace", charges: memoryCharges, rentProfiles: memoryRentProfiles });
      }
      if (!skipReconcile) {
        reconcileApprovedResidentPaymentSchedules(null);
        syncAllRecurringRentCharges();
      }
      return { charges: readAll(), rentProfiles: readRentProfiles() };
    })
    .catch(() => {
      hydrateHouseholdStateFromSession();
      if (!skipReconcile) {
        reconcileApprovedResidentPaymentSchedules(null);
        syncAllRecurringRentCharges();
      }
      return { charges: readAll(), rentProfiles: readRentProfiles() };
    });
  householdChargesSyncPromise = syncPromise;
  const result = await syncPromise;
  householdChargesLastSyncedAt = Date.now();
  if (householdChargesSyncPromise === syncPromise) {
    householdChargesSyncPromise = null;
  }
  return result;
}

function readAll(): HouseholdCharge[] {
  hydrateHouseholdStateFromSession();
  return isBrowser() ? memoryCharges : [];
}

/** All household charges currently in the browser session (manager + resident rows). */
export function readHouseholdCharges(): HouseholdCharge[] {
  return readAll();
}

/** Apply server-confirmed charge rows without exposing the store's private writers. */
export function applyHouseholdChargeServerUpdates(updates: HouseholdCharge[]): void {
  if (!isBrowser() || updates.length === 0) return;
  hydrateHouseholdStateFromSession();
  const byId = new Map(updates.map((charge) => [charge.id, charge]));
  writeAll(readAll().map((charge) => byId.get(charge.id) ?? charge));
}

function writeAll(rows: HouseholdCharge[], silent = false) {
  if (!isBrowser()) return;
  const normalized = dedupeCharges(rows);
  if (!chargesChanged(memoryCharges, normalized)) return;
  memoryCharges = normalized;
  persistHouseholdStateToSession();
  householdChargesLastSyncedAt = Date.now();
  mirrorChargeRows(normalized);
  if (!silent) emit();
}

function readRentProfiles(): RecurringRentProfile[] {
  hydrateHouseholdStateFromSession();
  return isBrowser() ? memoryRentProfiles : [];
}

function writeRentProfiles(rows: RecurringRentProfile[]) {
  if (!isBrowser()) return;
  const normalized = dedupeRecurringRentProfiles(rows);
  if (!rentProfilesChanged(memoryRentProfiles, normalized)) return;
  memoryRentProfiles = normalized;
  persistHouseholdStateToSession();
  householdChargesLastSyncedAt = Date.now();
  mirrorRentProfiles(normalized);
  syncAllRecurringRentCharges();
  emit();
}

/**
 * Demo seed: load charges + rent profiles directly into the local store without
 * mirroring to the server (used only by the public `/demo` sandbox). Overwrites
 * whatever is cached so re-seeding is idempotent.
 */
export function seedDemoHouseholdCharges(charges: HouseholdCharge[], rentProfiles: RecurringRentProfile[] = []): void {
  if (!isBrowser()) return;
  memoryCharges = dedupeCharges(charges);
  memoryRentProfiles = dedupeRecurringRentProfiles(rentProfiles);
  persistHouseholdStateToSession();
  householdChargesLastSyncedAt = Date.now();
  emit();
}

export { parseMoneyAmount } from "@/lib/parse-money";

function currentRentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function chargeKeyPart(raw: string): string {
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase();
  if (upper.startsWith("AXIS-")) {
    const suffix = upper
      .slice(5)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return suffix ? `pl_${suffix}` : "unknown";
  }
  if (upper.startsWith("PROPLANE-")) {
    const suffix = upper
      .slice(9)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return suffix ? `pl_${suffix}` : "unknown";
  }
  const cleaned = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "unknown";
}

/** Legacy charge URLs used `axis_` / `proplane_` slug segments; new ones use `pl_`. */
export function legacyChargeIdAliases(id: string): string[] {
  const trimmed = id.trim();
  if (!trimmed) return [];
  const variants = new Set<string>([trimmed]);
  if (trimmed.includes("_axis_")) variants.add(trimmed.replace(/_axis_/g, "_pl_"));
  if (trimmed.includes("_pl_")) variants.add(trimmed.replace(/_pl_/g, "_axis_"));
  if (trimmed.includes("_proplane_")) variants.add(trimmed.replace(/_proplane_/g, "_pl_"));
  if (trimmed.includes("_pl_")) variants.add(trimmed.replace(/_pl_/g, "_proplane_"));
  return [...variants];
}

function approvedChargeIdAliases(applicationId: string, kind: HouseholdChargeKind): string[] {
  const canonical = approvedChargeId(applicationId, kind);
  const variants = new Set<string>([canonical, ...legacyChargeIdAliases(canonical)]);
  const trimmed = applicationId.trim();
  const upper = trimmed.toUpperCase();
  if (upper.startsWith("PROPLANE-") || upper.startsWith("AXIS-")) {
    const legacySlug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    variants.add(`hc_app_${legacySlug}_${kind}`);
  }
  return [...variants];
}

/** PropLane-branded charge id for payment detail URLs (no legacy `axis_` segment). */
export function publicChargeIdForUrl(id: string): string {
  return id.replace(/_axis_/g, "_pl_");
}

function applicationFeeChargeIdForApplication(applicationId: string): string {
  return `hc_app_fee_${chargeKeyPart(applicationId)}`;
}

function applicationFeeFallbackChargeId(residentEmail: string, propertyId: string): string {
  return `hc_app_fee_${chargeKeyPart(residentEmail)}_${chargeKeyPart(propertyId)}`;
}

function approvedChargeId(applicationId: string, kind: HouseholdChargeKind): string {
  return `hc_app_${chargeKeyPart(applicationId)}_${kind}`;
}

function recurringRentProfileKey(profile: Pick<RecurringRentProfile, "residentEmail" | "propertyId">): string {
  return `${profile.residentEmail.trim().toLowerCase()}|${profile.propertyId}`;
}

function dedupeRecurringRentProfiles(rows: RecurringRentProfile[]): RecurringRentProfile[] {
  const byKey = new Map<string, RecurringRentProfile>();
  for (const profile of rows) {
    const key = recurringRentProfileKey(profile);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, profile);
      continue;
    }
    const existingUpdatedAt = new Date(existing.updatedAt).getTime();
    const nextUpdatedAt = new Date(profile.updatedAt).getTime();
    if (!Number.isFinite(existingUpdatedAt) || nextUpdatedAt >= existingUpdatedAt) {
      byKey.set(key, profile);
    }
  }
  return [...byKey.values()];
}

function applicationPropertyIdForCharges(row: DemoApplicantRow): string {
  return row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
}

/** Update rent profiles with monthly utilities from approved application data (no sync recursion). */
function backfillMonthlyUtilitiesOnRentProfiles(): void {
  if (!isBrowser()) return;
  const apps = readManagerApplicationRows().filter((a) => a.bucket === "approved" && a.email?.trim());
  if (apps.length === 0) return;
  const profiles = readRentProfiles();
  let changed = false;
  const next = profiles.map((p) => {
    if (!p.active) return p;
    if ((p.monthlyUtilities ?? 0) > 0) return p;
    const email = p.residentEmail.trim().toLowerCase();
    const propId = p.propertyId.trim();
    const app = apps.find((a) => {
      if (a.email!.trim().toLowerCase() !== email) return false;
      return applicationPropertyIdForCharges(a) === propId;
    });
    if (!app) return p;
    const u = selectedRoomUtilities(app);
    if (!(u.amount > 0)) return p;
    changed = true;
    return {
      ...p,
      monthlyUtilities: Number(u.amount.toFixed(2)),
      updatedAt: new Date().toISOString(),
    };
  });
  if (!changed) return;
  const normalized = dedupeRecurringRentProfiles(next);
  memoryRentProfiles = normalized;
  persistHouseholdStateToSession();
  mirrorRentProfiles(normalized);
}

function upfrontApprovedChargeSlotKey(charge: Pick<HouseholdCharge, "kind" | "applicationId" | "recurringRentProfileId">): string | null {
  if (!charge.applicationId?.trim()) return null;
  if (charge.kind === "first_month_rent" || charge.kind === "prorated_rent") {
    return `upfront_first_rent|${charge.applicationId.trim()}`;
  }
  if (
    (charge.kind === "utilities" || charge.kind === "prorated_utilities") &&
    !charge.recurringRentProfileId
  ) {
    return `upfront_first_utilities|${charge.applicationId.trim()}`;
  }
  if (charge.kind === "prorated_last_month_rent") {
    return `upfront_last_rent|${charge.applicationId.trim()}`;
  }
  if (charge.kind === "prorated_last_month_utilities") {
    return `upfront_last_utilities|${charge.applicationId.trim()}`;
  }
  return null;
}

function chargeBusinessKey(charge: HouseholdCharge): string {
  if (charge.kind === "rent") {
    return `rent|${charge.residentEmail.trim().toLowerCase()}|${charge.propertyId}|${charge.rentMonth ?? ""}`;
  }
  if (
    charge.kind === "utilities" &&
    charge.rentMonth &&
    charge.recurringRentProfileId &&
    !charge.applicationId
  ) {
    return `utilities_recurring|${charge.residentEmail.trim().toLowerCase()}|${charge.propertyId}|${charge.rentMonth}`;
  }
  /** One pending/paid application fee per resident email + listing — avoids duplicates when id linkage or property id varies on the row. */
  if (charge.kind === "application_fee") {
    return `application_fee|${charge.residentEmail.trim().toLowerCase()}|${charge.propertyId}`;
  }
  if (charge.kind === "holding_deposit") {
    return `holding_deposit|${charge.residentEmail.trim().toLowerCase()}|${charge.propertyId}`;
  }
  // Custom fees each get their own key, per fee AND per month (recurring), so multiple
  // custom fees never collide on `other_cost|applicationId` and a monthly fee emits exactly
  // once per month across repeated syncs.
  if (charge.customFeeId) {
    return `custom_fee|${charge.residentEmail.trim().toLowerCase()}|${charge.propertyId}|${charge.customFeeId}|${charge.rentMonth ?? ""}`;
  }
  const upfrontSlot = upfrontApprovedChargeSlotKey(charge);
  if (upfrontSlot) return upfrontSlot;
  if (charge.applicationId && (
    charge.kind === "first_month_rent" ||
    charge.kind === "prorated_rent" ||
    charge.kind === "prorated_last_month_rent" ||
    charge.kind === "utilities" ||
    charge.kind === "prorated_utilities" ||
    charge.kind === "prorated_last_month_utilities" ||
    charge.kind === "security_deposit" ||
    charge.kind === "move_in_fee" ||
    charge.kind === "other_cost" ||
    charge.kind === "stay_total"
  )) {
    return `${charge.kind}|${charge.applicationId}`;
  }
  return charge.id;
}

function mergeHouseholdApplicationFeeRows(a: HouseholdCharge, b: HouseholdCharge): HouseholdCharge {
  const aPaid = a.status === "paid";
  const bPaid = b.status === "paid";
  const [primary, secondary] =
    aPaid && !bPaid
      ? [a, b]
      : bPaid && !aPaid
        ? [b, a]
        : ((): [HouseholdCharge, HouseholdCharge] => {
            const ta = new Date(a.createdAt).getTime();
            const tb = new Date(b.createdAt).getTime();
            if (Number.isFinite(ta) && Number.isFinite(tb) && ta >= tb) return [a, b];
            return [b, a];
          })();
  const applicationId = primary.applicationId?.trim() || secondary.applicationId?.trim() || undefined;
  const paid = aPaid || bPaid;
  const mergedId = applicationId ? applicationFeeChargeIdForApplication(applicationId) : primary.id;
  return {
    ...primary,
    id: mergedId,
    applicationId,
    residentUserId: primary.residentUserId ?? secondary.residentUserId ?? null,
    residentName: primary.residentName?.trim() ? primary.residentName : secondary.residentName,
    status: paid ? "paid" : primary.status,
    paidAt: paid ? primary.paidAt || secondary.paidAt : undefined,
    balanceLabel: paid ? "$0.00" : primary.balanceLabel,
    amountLabel: primary.amountLabel?.trim() ? primary.amountLabel : secondary.amountLabel,
    zelleContactSnapshot: primary.zelleContactSnapshot ?? secondary.zelleContactSnapshot,
    venmoContactSnapshot: primary.venmoContactSnapshot ?? secondary.venmoContactSnapshot,
  };
}

function mergeApprovedApplicationChargeRows(
  a: HouseholdCharge,
  b: HouseholdCharge,
  canonicalId: string,
): HouseholdCharge {
  const aPaid = a.status === "paid";
  const bPaid = b.status === "paid";
  const [primary, secondary] =
    aPaid && !bPaid
      ? [a, b]
      : bPaid && !aPaid
        ? [b, a]
        : ((): [HouseholdCharge, HouseholdCharge] => {
            const ta = new Date(a.createdAt).getTime();
            const tb = new Date(b.createdAt).getTime();
            if (Number.isFinite(ta) && Number.isFinite(tb) && ta >= tb) return [a, b];
            return [b, a];
          })();
  const paid = aPaid || bPaid;
  return {
    ...primary,
    id: canonicalId,
    applicationId: primary.applicationId?.trim() || secondary.applicationId?.trim() || undefined,
    residentUserId: primary.residentUserId ?? secondary.residentUserId ?? null,
    residentName: primary.residentName?.trim() ? primary.residentName : secondary.residentName,
    status: paid ? "paid" : primary.status,
    paidAt: paid ? primary.paidAt || secondary.paidAt : undefined,
    balanceLabel: paid ? "$0.00" : primary.balanceLabel,
    amountLabel: primary.amountLabel?.trim() ? primary.amountLabel : secondary.amountLabel,
    title: primary.title?.trim() ? primary.title : secondary.title,
    zelleContactSnapshot: primary.zelleContactSnapshot ?? secondary.zelleContactSnapshot,
    venmoContactSnapshot: primary.venmoContactSnapshot ?? secondary.venmoContactSnapshot,
  };
}

function dedupeCharges(rows: HouseholdCharge[]): HouseholdCharge[] {
  const byKey = new Map<string, HouseholdCharge>();
  for (const raw of rows) {
    // Rows hydrated from localStorage/server JSON (readAll → line ~137, server
    // merge) are cast `as HouseholdCharge` without runtime validation, so string
    // fields the type promises can actually be missing. Coerce residentEmail /
    // residentName / propertyLabel to "" here — the single chokepoint every
    // read/write passes through — so keying below and every downstream
    // consumer (e.g. householdChargeToLedgerRow → normalizePropertyLabel) can
    // safely call `.trim()` instead of crashing (e.g. the Payments tab error
    // boundary).
    const charge: HouseholdCharge =
      typeof raw.residentEmail === "string" && typeof raw.residentName === "string" && typeof raw.propertyLabel === "string"
        ? raw
        : {
            ...raw,
            residentEmail: raw.residentEmail ?? "",
            residentName: raw.residentName ?? "",
            propertyLabel: raw.propertyLabel ?? "",
          };
    const key = chargeBusinessKey(charge);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, charge);
      continue;
    }
    if (existing.kind === "application_fee" && charge.kind === "application_fee") {
      byKey.set(key, mergeHouseholdApplicationFeeRows(existing, charge));
      continue;
    }
    const existingSlot = upfrontApprovedChargeSlotKey(existing);
    const chargeSlot = upfrontApprovedChargeSlotKey(charge);
    if (
      existing.applicationId &&
      charge.applicationId &&
      existingSlot &&
      existingSlot === chargeSlot &&
      existing.kind !== charge.kind
    ) {
      const preferred =
        charge.status === "paid"
          ? charge
          : existing.status === "paid"
            ? existing
            : new Date(charge.createdAt).getTime() >= new Date(existing.createdAt).getTime()
              ? charge
              : existing;
      const other = preferred === charge ? existing : charge;
      const canonicalId = approvedChargeId(preferred.applicationId!, preferred.kind);
      const merged = mergeApprovedApplicationChargeRows(other, preferred, canonicalId);
      byKey.set(key, {
        ...merged,
        kind: preferred.kind,
        title: preferred.title?.trim() ? preferred.title : merged.title,
        amountLabel: preferred.amountLabel?.trim() ? preferred.amountLabel : merged.amountLabel,
        balanceLabel: merged.status === "paid" ? "$0.00" : preferred.balanceLabel || merged.balanceLabel,
      });
      continue;
    }
    if (
      existing.applicationId &&
      charge.applicationId &&
      existing.kind === charge.kind &&
      existing.kind === "stay_total"
    ) {
      const canonicalId = approvedChargeId(existing.applicationId, existing.kind);
      byKey.set(key, mergeApprovedApplicationChargeRows(existing, charge, canonicalId));
      continue;
    }
    if (existing.status !== "paid" && charge.status === "paid") {
      byKey.set(key, charge);
      continue;
    }
    if (existing.status === "paid" && charge.status !== "paid") {
      continue;
    }
    const existingCreatedAt = new Date(existing.createdAt).getTime();
    const nextCreatedAt = new Date(charge.createdAt).getTime();
    if (!Number.isFinite(existingCreatedAt) || nextCreatedAt >= existingCreatedAt) {
      byKey.set(key, charge);
    }
  }
  return [...byKey.values()];
}

export function householdChargeBusinessKey(charge: HouseholdCharge): string {
  return chargeBusinessKey(charge);
}

export function dedupeHouseholdCharges(rows: HouseholdCharge[]): HouseholdCharge[] {
  return dedupeCharges(rows);
}

/** Charge row ids dropped when deduping (e.g. legacy fallback application-fee ids). */
export function duplicateHouseholdChargeIds(rows: HouseholdCharge[]): string[] {
  const canonicalIds = new Set(dedupeCharges(rows).map((charge) => charge.id));
  return [...new Set(rows.map((charge) => charge.id).filter((id) => !canonicalIds.has(id)))];
}

function formatRecurringRentDueLabel(month: string, dueDay: number, dueDayMode?: RentDueDayMode) {
  const day = effectiveDueDayForMonth(dueDay, dueDayMode, month);
  const [year, monthIndex] = month.split("-").map(Number);
  const dt = new Date(year!, (monthIndex ?? 1) - 1, day, 12, 0, 0, 0);
  return Number.isNaN(dt.getTime())
    ? `${month}-${String(day).padStart(2, "0")}`
    : dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function effectiveDueDayForMonth(dueDay: number | undefined, dueDayMode: RentDueDayMode | undefined, monthKey: string): number {
  const mode = dueDayMode ?? "first_of_month";
  if (mode === "last_of_month") return resolveRentDueDayForMonth("last_of_month", monthKey);
  return Math.min(28, Math.max(1, Math.round(dueDay ?? 1)));
}

function recurringRentDueDate(
  month: string | undefined,
  dueDay: number | undefined,
  dueDayMode?: RentDueDayMode,
): Date | null {
  if (!month) return null;
  const [year, monthIndex] = month.split("-").map(Number);
  const day = effectiveDueDayForMonth(dueDay, dueDayMode, month);
  const dt = new Date(year!, (monthIndex ?? 1) - 1, day, 12, 0, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function parseDueDateLabelToDate(label: string | undefined): Date | null {
  const raw = label?.trim();
  if (!raw) return null;
  // Strip display prefixes like "By " or "Before " before attempting to parse
  const stripped = raw.replace(/^(by|before)\s+/i, "").trim();
  const parsed = new Date(stripped);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 12, 0, 0, 0);
}

function startOfTodayLocal(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

export function householdChargeDueDate(charge: HouseholdCharge): Date | null {
  if (
    (charge.kind === "rent" || (charge.kind === "utilities" && charge.recurringRentProfileId)) &&
    charge.rentMonth
  ) {
    return recurringRentDueDate(charge.rentMonth, charge.dueDay ?? 1, charge.dueDayMode);
  }
  return parseDueDateLabelToDate(charge.dueDateLabel);
}

/**
 * Order two due-date timestamps (epoch ms; `null` = no real date).
 * `asc` = soonest first (for pending/overdue: the next thing due is at the top).
 * `desc` = most recent first (for paid history). Undated rows always sort last.
 */
export function compareDueDateMs(
  a: number | null | undefined,
  b: number | null | undefined,
  direction: "asc" | "desc" = "asc",
): number {
  const at = a ?? null;
  const bt = b ?? null;
  if (at === bt) return 0;
  if (at === null) return 1;
  if (bt === null) return -1;
  return direction === "asc" ? at - bt : bt - at;
}

/** Compare two charges by their resolved due date. See {@link compareDueDateMs}. */
export function compareChargesByDueDate(
  a: HouseholdCharge,
  b: HouseholdCharge,
  direction: "asc" | "desc" = "asc",
): number {
  return compareDueDateMs(
    householdChargeDueDate(a)?.getTime() ?? null,
    householdChargeDueDate(b)?.getTime() ?? null,
    direction,
  );
}

export function isHouseholdChargeOverdue(charge: HouseholdCharge, now = new Date()): boolean {
  if (!isUnpaidHouseholdCharge(charge)) return false;
  const due = householdChargeDueDate(charge);
  if (!due) return false;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  return due.getTime() < today.getTime();
}

/** True when a charge still has an outstanding balance and should receive payment reminders. */
export function isUnpaidHouseholdCharge(charge: HouseholdCharge): boolean {
  if (charge.status === "paid") return false;
  if (charge.paidAt) return false;
  if (parseMoneyAmount(charge.balanceLabel) <= 0) return false;
  return true;
}

function hasUpfrontProratedLastMonthCharge(
  allCharges: HouseholdCharge[],
  residentEmail: string,
  propertyId: string,
  kind: "prorated_last_month_rent" | "prorated_last_month_utilities",
): boolean {
  const emailLower = residentEmail.trim().toLowerCase();
  return allCharges.some(
    (c) => c.kind === kind && c.residentEmail.trim().toLowerCase() === emailLower && c.propertyId === propertyId,
  );
}

/** Manager-entered move-in/out on manually added residents wins over stale application dates. */
function resolveLeaseDatesForBilling(row: Pick<DemoApplicantRow, "manuallyAdded" | "manualResidentDetails" | "application">): {
  leaseStart?: string;
  leaseEnd?: string;
} {
  const manualIn = row.manualResidentDetails?.moveInDate?.trim();
  const manualOut = row.manualResidentDetails?.moveOutDate?.trim();
  const appIn = row.application?.leaseStart?.trim();
  const appOut = row.application?.leaseEnd?.trim();
  if (row.manuallyAdded || manualIn || manualOut) {
    return {
      leaseStart: manualIn || appIn || undefined,
      leaseEnd: manualOut || appOut || undefined,
    };
  }
  return {
    leaseStart: appIn || manualIn || undefined,
    leaseEnd: appOut || manualOut || undefined,
  };
}

/** Pending recurring rent/utilities rows that should not bill or receive reminders. */
export function isStaleRecurringHouseholdCharge(
  charge: HouseholdCharge,
  profileById: Map<string, RecurringRentProfile>,
  allCharges: HouseholdCharge[],
): boolean {
  if (charge.status === "paid" || !charge.recurringRentProfileId || !charge.rentMonth) return false;
  // Recurring rent/utilities AND monthly custom-fee rows are all bounds-checked below. A
  // custom row is purged only when its month falls outside the lease (before start / after
  // end) — NOT when its fee is removed or its amount changes: an already-emitted unpaid month
  // is a charge the resident may owe, so removal just stops FUTURE emission and an amount
  // change applies only to months not yet emitted.
  const isCustomRecurring = Boolean(charge.customFeeId);
  if (charge.kind !== "rent" && charge.kind !== "utilities" && !isCustomRecurring) return false;
  const prof = profileById.get(charge.recurringRentProfileId);
  if (!prof) return false;

  const startMonth = prof.startMonth?.trim();
  if (startMonth && charge.rentMonth < startMonth) return true;

  const leaseEndParts = prof.leaseEnd?.trim().split("-").map(Number) ?? [];
  const leaseEndYear = leaseEndParts[0] && Number.isFinite(leaseEndParts[0]) ? leaseEndParts[0] : null;
  const leaseEndMonthNum = leaseEndParts[1] && Number.isFinite(leaseEndParts[1]) ? leaseEndParts[1] : null;
  const leaseEndDay = leaseEndParts[2] && Number.isFinite(leaseEndParts[2]) ? leaseEndParts[2] : null;

  if (leaseEndYear && leaseEndMonthNum) {
    const leaseEndMonth = `${leaseEndYear}-${String(leaseEndMonthNum).padStart(2, "0")}`;
    if (charge.rentMonth > leaseEndMonth) return true;

    const daysInEndMonth = new Date(leaseEndYear, leaseEndMonthNum, 0).getDate();
    const partialLastMonth = leaseEndDay != null && leaseEndDay > 0 && leaseEndDay < daysInEndMonth;
    // Only rent/utilities have an upfront prorated-last-month charge that would duplicate the
    // recurring row; custom fees are flat (full each month), so this dedup does not apply.
    if (!isCustomRecurring && partialLastMonth && charge.rentMonth === leaseEndMonth) {
      const hasUpfront =
        charge.kind === "rent"
          ? hasUpfrontProratedLastMonthCharge(allCharges, prof.residentEmail, prof.propertyId, "prorated_last_month_rent")
          : hasUpfrontProratedLastMonthCharge(
              allCharges,
              prof.residentEmail,
              prof.propertyId,
              "prorated_last_month_utilities",
            );
      if (hasUpfront) return true;
    }
  }

  return false;
}

/** Charges that should appear in payment reminders (excludes paid and stale recurring rows). */
export function filterChargesEligibleForPaymentReminders(
  charges: HouseholdCharge[],
  rentProfiles: RecurringRentProfile[],
): HouseholdCharge[] {
  const profileById = new Map(rentProfiles.map((profile) => [profile.id, profile]));
  return charges.filter(
    (charge) => isUnpaidHouseholdCharge(charge) && !isStaleRecurringHouseholdCharge(charge, profileById, charges),
  );
}

/** Manager Payments → Add payment rows (id prefix `hc_mgr_`). */
export function isManagerAddedOneOffCharge(charge: Pick<HouseholdCharge, "id" | "kind" | "workOrderId">): boolean {
  if (charge.id.startsWith("hc_mgr_")) return true;
  // Legacy: createManagerCharge used kind work_order_charge without a workOrderId.
  if (charge.kind === "work_order_charge" && !charge.workOrderId) return true;
  return false;
}

function dueLabelForLeaseStart(leaseStart?: string | null): string {
  const raw = leaseStart?.trim();
  if (!raw) return "Before move-in";
  let date: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split("-").map(Number);
    date = new Date(year, month - 1, day);
  } else {
    date = new Date(raw);
  }
  if (Number.isNaN(date.getTime())) return "Before move-in";
  return `Before ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

function shouldDisplayChargeInPayments(charge: HouseholdCharge, now = new Date()): boolean {
  if (charge.status === "paid") return true;
  const due = householdChargeDueDate(charge);
  if (!due) return true;
  // Show upcoming unpaid charges through the END OF NEXT MONTH (current + next
  // month), plus anything already overdue (due in the past). Recurring rent is
  // materialized for exactly this horizon (current month + 1), so the display
  // window and the generated data align — the manager/resident always see the
  // next cycle. (Was: only within 7 days, which left the Pending tab empty.)
  const endOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59, 999);
  return due.getTime() <= endOfNextMonth.getTime();
}

export function chargeDueLabel(charge: HouseholdCharge): string {
  if (charge.dueDateLabel?.trim()) return charge.dueDateLabel.trim();
  if (
    (charge.kind === "rent" || (charge.kind === "utilities" && charge.recurringRentProfileId)) &&
    charge.rentMonth
  ) {
    return formatRecurringRentDueLabel(charge.rentMonth, charge.dueDay ?? 1, charge.dueDayMode);
  }
  switch (charge.kind) {
    case "application_fee":
    case "holding_deposit":
      return "Before approval";
    case "security_deposit":
    case "move_in_fee":
      return "Before lease signing";
    case "stay_total":
      return "Before check-in";
    case "first_month_rent":
    case "prorated_rent":
    case "utilities":
    case "prorated_utilities":
      return "Before move-in";
    case "prorated_last_month_rent":
    case "prorated_last_month_utilities":
      return "By lease end";
    default:
      return new Date(charge.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
}

function chargeTitle(kind: HouseholdChargeKind): string {
  switch (kind) {
    case "application_fee":
      return "Application fee";
    case "holding_deposit":
      return "Holding deposit";
    case "stay_total":
      return "Stay total";
    case "first_month_rent":
      return "First month's rent";
    case "prorated_rent":
      return "Prorated first month's rent";
    case "prorated_last_month_rent":
      return "Prorated last month's rent";
    case "rent":
      return "Monthly rent";
    case "utilities":
      return "Utilities";
    case "prorated_utilities":
      return "Prorated utilities";
    case "prorated_last_month_utilities":
      return "Prorated last month's utilities";
    case "security_deposit":
      return "Security deposit";
    case "move_in_fee":
      return "Move-in cost";
    case "other_cost":
      return "Other cost";
    case "payment_at_signing":
      return "Payment due at signing";
    case "work_order_charge":
      return "Work order charge";
    case "late_fee":
      return "Late payment fee";
    default:
      return "Charge";
  }
}

function submissionAmount(sub: ManagerListingSubmissionV1, kind: HouseholdChargeKind): string {
  switch (kind) {
    case "application_fee":
      return sub.applicationFee;
    case "holding_deposit":
      return normalizeHoldingDepositLabel(sub.holdingDeposit);
    case "stay_total":
      return "$0";
    case "first_month_rent":
    case "prorated_rent":
    case "prorated_last_month_rent":
    case "prorated_utilities":
    case "prorated_last_month_utilities":
    case "rent":
      return "$0";
    case "utilities":
      return "$0";
    case "security_deposit":
      return sub.securityDeposit;
    case "move_in_fee":
      return sub.moveInFee;
    case "other_cost":
      return "$0";
    case "payment_at_signing":
      return paymentAtSigningPriceLabel(sub);
    case "work_order_charge":
      return "$0";
    default:
      return "$0";
  }
}

function moneyAmountLabel(amount: number): string {
  // Thousands separators to match seed/label formatting ($2,400.00, not $2400.00).
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function monthKeyFromDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function addMonthsToMonthKey(month: string, offset: number): string {
  const [yearRaw, monthRaw] = month.split("-").map(Number);
  if (!yearRaw || !monthRaw) return month;
  const next = new Date(yearRaw, monthRaw - 1 + offset, 1);
  return monthKeyFromDate(next);
}

function monthsBetweenInclusive(startMonth: string, endMonth: string): string[] {
  if (startMonth > endMonth) return [];
  const out: string[] = [];
  let current = startMonth;
  while (current <= endMonth) {
    out.push(current);
    current = addMonthsToMonthKey(current, 1);
  }
  return out;
}

function firstRecurringMonthAfterLeaseStart(leaseStart: string | undefined): string {
  const raw = leaseStart?.trim();
  if (!raw) return currentRentMonth();
  const [yearRaw, monthRaw] = raw.split("-").map(Number);
  if (!yearRaw || !monthRaw) return currentRentMonth();
  const nextMonth = new Date(yearRaw, monthRaw, 1);
  return monthKeyFromDate(nextMonth);
}

function leaseStartProration(leaseStart: string | undefined): { prorated: boolean; factor: number; billableDays: number; daysInMonth: number; label: string } {
  if (!leaseStart?.trim()) return { prorated: false, factor: 1, billableDays: 0, daysInMonth: 0, label: "full first month" };
  const [yearRaw, monthRaw, dayRaw] = leaseStart.split("-").map(Number);
  if (!yearRaw || !monthRaw || !dayRaw) return { prorated: false, factor: 1, billableDays: 0, daysInMonth: 0, label: "full first month" };
  const daysInMonth = new Date(yearRaw, monthRaw, 0).getDate();
  if (!Number.isFinite(daysInMonth) || daysInMonth <= 0 || dayRaw <= 1) {
    return { prorated: false, factor: 1, billableDays: daysInMonth, daysInMonth, label: "full first month" };
  }
  const billableDays = Math.max(1, daysInMonth - dayRaw + 1);
  return {
    prorated: true,
    factor: billableDays / daysInMonth,
    billableDays,
    daysInMonth,
    label: `${billableDays}/${daysInMonth} days from lease start`,
  };
}

function leaseEndProration(leaseEnd: string | undefined): LeaseBoundaryProration {
  if (!leaseEnd?.trim()) return { prorated: false, factor: 1, billableDays: 0, daysInMonth: 0 };
  const [yearRaw, monthRaw, dayRaw] = leaseEnd.split("-").map(Number);
  if (!yearRaw || !monthRaw || !dayRaw) return { prorated: false, factor: 1, billableDays: 0, daysInMonth: 0 };
  const daysInMonth = new Date(yearRaw, monthRaw, 0).getDate();
  if (!Number.isFinite(daysInMonth) || daysInMonth <= 0 || dayRaw >= daysInMonth) {
    return { prorated: false, factor: 1, billableDays: daysInMonth, daysInMonth };
  }
  const leaseEndDate = new Date(yearRaw, monthRaw - 1, dayRaw);
  const reminderDate = new Date(leaseEndDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  return {
    prorated: true,
    factor: dayRaw / daysInMonth,
    billableDays: dayRaw,
    daysInMonth,
    dueDateLabel: `By ${reminderDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`,
  };
}

/**
 * Proration for the FIRST billed period. Normally that is the partial month from the
 * lease start; for a lease that also ends in the same month it is the whole lease term.
 *
 * Collapsing the two edges into one span is DAILY-ONLY (`collapseIntraMonth`): monthly
 * rooms must bill exactly as they always have, so they keep the plain lease-start
 * proration even when the lease ends in the same month.
 */
function leaseFirstPeriodProration(
  leaseStart: string | undefined,
  leaseEnd: string | undefined,
  collapseIntraMonth: boolean,
): ReturnType<typeof leaseStartProration> {
  const span = collapseIntraMonth ? intraMonthStaySpan(leaseStart, leaseEnd) : null;
  if (!span) return leaseStartProration(leaseStart);
  return {
    prorated: true,
    factor: span.billableDays / span.daysInMonth,
    billableDays: span.billableDays,
    daysInMonth: span.daysInMonth,
    label: `${span.billableDays}/${span.daysInMonth} days of lease term`,
  };
}

function firstMonthRentChargeForLeaseStart(
  monthlyRent: number,
  leaseStart: string | undefined,
  prorateMethod?: "auto" | "daily_rate",
  dailyRentRate?: number,
  /** Headline daily rate when the room is priced by the day — bills EVERY first month (full or partial) per day. */
  dailyBasisRate?: number,
  /** Lease end, so a DAILY-priced lease that starts and ends in one month bills its true span once. */
  leaseEnd?: string,
): {
  kind: HouseholdChargeKind;
  amount: number;
  title: string;
  proration: ReturnType<typeof leaseStartProration>;
} | null {
  const isDailyBasis = (dailyBasisRate ?? 0) > 0;
  const proration = leaseFirstPeriodProration(leaseStart, leaseEnd, isDailyBasis);
  // Room priced by the day: the first month bills its billable days × daily rate
  // whether it is a full or partial month (billableDays is daysInMonth for a full month).
  if (dailyBasisRate && dailyBasisRate > 0) {
    const days = proration.billableDays > 0 ? proration.billableDays : proration.daysInMonth;
    // Without a parseable lease start there is no real day count, and a daily charge
    // must never be invented from the sorting-only 30-day estimate.
    if (!(days > 0)) return null;
    const amount = Number((days * dailyBasisRate).toFixed(2));
    return {
      kind: proration.prorated ? "prorated_rent" : "first_month_rent",
      amount,
      title: proration.prorated
        ? `Prorated first month's rent (${days} days × ${formatRoomPriceAmount(dailyBasisRate)}/day)`
        : `First month's rent (${days} days × ${formatRoomPriceAmount(dailyBasisRate)}/day)`,
      proration,
    };
  }
  let amount: number;
  if (proration.prorated && prorateMethod === "daily_rate" && dailyRentRate && dailyRentRate > 0) {
    amount = Number((proration.billableDays * dailyRentRate).toFixed(2));
  } else {
    amount = proration.prorated ? monthlyRent * proration.factor : monthlyRent;
  }
  return {
    kind: proration.prorated ? "prorated_rent" : "first_month_rent",
    amount,
    title: proration.prorated
      ? prorateMethod === "daily_rate" && dailyRentRate && dailyRentRate > 0
        ? `Prorated first month's rent (${proration.billableDays} days × $${dailyRentRate}/day)`
        : `Prorated first month's rent (${proration.label})`
      : "First month's rent",
    proration,
  };
}

function lastMonthChargeForLeaseEnd(
  monthlyAmount: number,
  leaseEnd: string | undefined,
  chargeLabel: "rent" | "utilities",
  prorateMethod?: "auto" | "daily_rate",
  dailyRate?: number,
  /** Headline daily rate when the room is priced by the day — bills the partial last month per day. */
  dailyBasisRate?: number,
): {
  kind: HouseholdChargeKind;
  amount: number;
  title: string;
  dueDateLabel?: string;
} | null {
  const proration = leaseEndProration(leaseEnd);
  if (!proration.prorated) return null;
  // A daily-priced room bills its partial last month per day regardless of prorateMethod.
  const effectiveDailyRate = dailyBasisRate && dailyBasisRate > 0 ? dailyBasisRate : dailyRate;
  const useDailyRate =
    (dailyBasisRate != null && dailyBasisRate > 0) ||
    (prorateMethod === "daily_rate" && dailyRate != null && dailyRate > 0);
  const amount = useDailyRate
    ? Number((proration.billableDays * (effectiveDailyRate ?? 0)).toFixed(2))
    : Number((monthlyAmount * proration.factor).toFixed(2));
  const rateLabel = formatRoomPriceAmount(effectiveDailyRate ?? 0);
  const title = chargeLabel === "rent"
    ? useDailyRate
      ? `Prorated last month's rent (${proration.billableDays} days × ${rateLabel}/day)`
      : "Prorated last month's rent"
    : useDailyRate
      ? `Prorated last month's utilities (${proration.billableDays} days × ${rateLabel}/day)`
      : "Prorated last month's utilities";
  return {
    kind: chargeLabel === "rent" ? "prorated_last_month_rent" : "prorated_last_month_utilities",
    amount,
    title,
    dueDateLabel: proration.dueDateLabel,
  };
}

/**
 * The row's listing submission and its resolved room, both derived ONCE through the shared
 * chain in `listing-room-resolution.ts` that the lease document also uses.
 *
 * Every rent/utilities/deposit figure on this side must come from the SAME room the document
 * priced, so this is the only place the ledger is allowed to pick one. Resolving it per
 * call site is what let a single approval bill off one room while its lease quoted another.
 */
function resolveRowSubmissionRoom(
  row: Pick<
    DemoApplicantRow,
    "assignedRoomChoice" | "application" | "propertyId" | "assignedPropertyId" | "manualResidentDetails" | "signedMonthlyRent"
  >,
): { sub: ReturnType<typeof normalizeManagerListingSubmissionV1> | null; room: ManagerRoomSubmission | null } {
  const propertyId =
    row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
  const prop = getPropertyById(propertyId);
  const sub = prop?.listingSubmission?.v === 1 ? normalizeManagerListingSubmissionV1(prop.listingSubmission) : null;
  if (!sub) return { sub: null, room: null };
  return { sub, room: roomForRow(sub, row, prop?.unitLabel) };
}

/** Shared room lookup for a row. Every caller must pass the same inputs (see the module doc). */
function roomForRow(
  sub: ReturnType<typeof normalizeManagerListingSubmissionV1>,
  row: Pick<DemoApplicantRow, "assignedRoomChoice" | "application" | "manualResidentDetails" | "signedMonthlyRent">,
  unitLabel: string | null | undefined,
): ManagerRoomSubmission | null {
  return (
    resolveSubmissionRoom(sub, {
      roomChoices: [row.assignedRoomChoice, row.application?.roomChoice1],
      unitLabel: unitLabel ?? row.manualResidentDetails?.roomNumber,
      signedMonthlyRent: row.signedMonthlyRent,
    }) ?? null
  );
}

function selectedRoomUtilities(row: Pick<DemoApplicantRow, "assignedRoomChoice" | "application" | "propertyId" | "assignedPropertyId" | "manualResidentDetails" | "manuallyAdded" | "signedMonthlyRent">): {
  raw: string;
  amount: number;
} {
  const override = row.application?.managerUtilitiesOverride?.trim();
  if (override != null && override !== "") return { raw: override, amount: parseMoneyAmount(override) };
  const manualUtils = row.manualResidentDetails?.monthlyUtilities;
  if (manualUtils != null && manualUtils > 0) return { raw: String(manualUtils), amount: manualUtils };
  if (row.manuallyAdded) return { raw: "", amount: 0 };
  const { sub, room } = resolveRowSubmissionRoom(row);
  if (!sub) return { raw: "", amount: 0 };
  // A bundle prices the whole group, so its total outranks any single room's estimate.
  const bundleId = bundleIdForApplication(row.application);
  if (bundleId) {
    const totals = resolveBundleFinancialTotals(sub, bundleId);
    if (totals && totals.monthlyUtilities > 0) {
      return { raw: String(totals.monthlyUtilities), amount: totals.monthlyUtilities };
    }
  }
  const amount = utilitiesBillableMonthlyAmount(sub, room);
  const raw = amount > 0 ? String(amount) : room?.utilitiesEstimate?.trim() || "";
  return { raw, amount };
}

function selectedRoom(row: DemoApplicantRow) {
  return resolveRowSubmissionRoom(row).room;
}

/**
 * True when this resident has a negotiated monthly rent of their own (a manager
 * override or a signed/renewed rent). It already beats the room's listing monthly
 * rent in {@link selectedRoomRentAmount}, so it must also beat the room's daily
 * basis — otherwise a forced regeneration (e.g. a signed lease renewal) would
 * discard the negotiated figure and re-bill the listing's daily rate.
 */
function residentNegotiatedMonthlyRent(row: DemoApplicantRow): number {
  const override = row.application?.managerRentOverride?.trim();
  if (override) {
    const amount = parseMoneyAmount(override);
    if (amount > 0) return amount;
  }
  const signedRent = Number(row.signedMonthlyRent ?? 0);
  if (Number.isFinite(signedRent) && signedRent > 0) return signedRent;
  return 0;
}

/** Short-term nightly rate: manager override / signed rent beat room and listing defaults. */
function selectedRoomRentAmount(row: DemoApplicantRow): number {
  const negotiated = residentNegotiatedMonthlyRent(row);
  if (negotiated > 0) return negotiated;
  if (row.manuallyAdded) return 0;
  // One shared room lookup, so the rent this bills and the room the lease quotes cannot
  // resolve differently. Bundle and entire-home pricing still outrank a single room.
  const { sub, room } = resolveRowSubmissionRoom(row);
  if (!sub) return 0;
  const bundleId = bundleIdForApplication(row.application);
  if (bundleId) {
    const totals = resolveBundleFinancialTotals(sub, bundleId);
    if (totals && totals.monthlyRent > 0) return totals.monthlyRent;
  }
  if (isEntireHomeListing(sub)) {
    const entireHomeRent = entireHomeMonthlyRentAmount(sub);
    if (entireHomeRent > 0) return entireHomeRent;
  }
  return room?.monthlyRent && room.monthlyRent > 0 ? room.monthlyRent : 0;
}

type BundleGroupChargeContext = {
  groupId: string;
  bundleId: string;
  memberIndex: number;
  memberCount: number;
};

function resolveBundleGroupChargeContext(row: DemoApplicantRow): BundleGroupChargeContext | null {
  if (!isBundleGroupApplication(row.application)) return null;
  const groupId = normalizeGroupId(row.application?.groupId);
  const bundleId = bundleIdForApplication(row.application);
  const propertyId = row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
  if (!groupId || !bundleId || !propertyId) return null;

  const inputs: BundleGroupRowInput[] = readManagerApplicationRows()
    .filter((a) => {
      const pid = a.assignedPropertyId?.trim() || a.propertyId?.trim() || a.application?.propertyId?.trim() || "";
      return (
        normalizeGroupId(a.application?.groupId) === groupId &&
        bundleIdForApplication(a.application) === bundleId &&
        pid === propertyId
      );
    })
    .map((a) => ({
      id: a.id,
      name: a.name || a.email || "Applicant",
      email: a.email || "",
      role: a.application?.groupRole ?? null,
      groupId,
      groupSize: a.application?.groupSize ?? "",
      status: a.bucket === "approved" ? "approved" : "submitted",
      bundleId,
      propertyId,
    }));

  const groups = buildBundleApplicationGroups(inputs);
  const group = groups.get(groupId);
  if (!group) return null;
  const memberCount = group.expectedSize ?? group.totalCount;
  if (!(memberCount > 1)) return null;
  return {
    groupId,
    bundleId,
    memberIndex: memberIndexInBundleGroup(group, row.id),
    memberCount,
  };
}

function applyBundleGroupSplit(
  amount: number,
  title: string,
  ctx: BundleGroupChargeContext | null,
): { amount: number; title: string; split?: Pick<HouseholdCharge, "bundleGroupId" | "bundleId" | "splitMemberIndex" | "splitMemberCount" | "splitTotalAmountLabel"> } {
  if (!ctx || !(amount > 0)) return { amount, title };
  const memberAmount = splitMoneyEvenly(amount, ctx.memberCount, ctx.memberIndex);
  const share = splitShareLabel(ctx.memberIndex, ctx.memberCount, moneyLabel(amount));
  return {
    amount: memberAmount,
    title: `${title} (${share})`,
    split: {
      bundleGroupId: ctx.groupId,
      bundleId: ctx.bundleId,
      splitMemberIndex: ctx.memberIndex,
      splitMemberCount: ctx.memberCount,
      splitTotalAmountLabel: moneyLabel(amount),
    },
  };
}

/**
 * Rebuilds the bundle-group split context stored on a recurring profile.
 *
 * Deliberately reads only the profile's own persisted fields rather than
 * re-deriving the group from application rows: the recurring generator runs
 * long after approval, and a member joining or leaving the group later must not
 * silently re-divide an existing resident's rent. Returns null unless a real
 * multi-member split was recorded, so every non-bundle profile takes the
 * untouched path.
 */
function bundleSplitContextFromProfile(profile: RecurringRentProfile): BundleGroupChargeContext | null {
  const groupId = (profile.bundleGroupId ?? "").trim();
  const memberCount = profile.splitMemberCount ?? 0;
  const memberIndex = profile.splitMemberIndex ?? -1;
  if (!groupId || !(memberCount > 1) || memberIndex < 0 || memberIndex >= memberCount) return null;
  return {
    groupId,
    bundleId: (profile.bundleId ?? "").trim(),
    memberIndex,
    memberCount,
  };
}

export function findWorkOrderCharge(workOrderId: string): HouseholdCharge | undefined {
  return readAll().find((c) => c.workOrderId === workOrderId && c.kind === "work_order_charge");
}

export function findPendingWorkOrderCharge(workOrderId: string): HouseholdCharge | undefined {
  const charge = findWorkOrderCharge(workOrderId);
  return charge?.status === "pending" ? charge : undefined;
}

/** Removes pending pass-through lines tied to a work order (e.g. when the manager deletes the work order). */
export function removePendingWorkOrderChargesForWorkOrder(workOrderId: string): void {
  if (!isBrowser() || !workOrderId.trim()) return;
  const rows = readAll();
  const next = rows.filter(
    (r) =>
      !(
        r.workOrderId === workOrderId &&
        r.kind === "work_order_charge" &&
        r.status === "pending"
      ),
  );
  if (next.length !== rows.length) writeAll(next);
}

export function findApplicationFeeCharge(
  residentEmail: string,
  propertyId: string,
  residentUserId?: string | null,
  applicationId?: string | null,
  propertyIdAliases?: readonly string[] | null,
): HouseholdCharge | undefined {
  const e = residentEmail.trim().toLowerCase();
  const props = new Set(
    [propertyId, ...(propertyIdAliases ?? [])].map((p) => String(p ?? "").trim()).filter(Boolean),
  );
  return readAll().find((r) => {
    if (r.kind !== "application_fee") return false;
    const emailMatch = r.residentEmail.trim().toLowerCase() === e;
    const userMatch = Boolean(residentUserId && r.residentUserId === residentUserId);
    if (applicationId?.trim() && r.applicationId === applicationId.trim()) {
      return emailMatch || userMatch;
    }
    if (!emailMatch && !userMatch) return false;
    if (props.size === 0) return false;
    return props.has(r.propertyId);
  });
}

/** Removes a pending application-fee line (e.g. after promo waive) so managers do not see a stray unpaid fee. */
export function removePendingApplicationFeeCharge(residentEmail: string, propertyId: string): void {
  const e = residentEmail.trim().toLowerCase();
  const rows = readAll();
  const next = rows.filter(
    (r) =>
      !(
        r.kind === "application_fee" &&
        r.propertyId === propertyId &&
        r.residentEmail.trim().toLowerCase() === e &&
        r.status === "pending"
      )
  );
  if (next.length !== rows.length) writeAll(next);
}

/**
 * Dollar amount the listing expects for the application fee (0 = none / not required for gate).
 * When there is no manager submission on the property, the demo stack uses $50 to match legacy billing.
 */
export function listingApplicationFeeAmount(propertyId: string): { amount: number; displayLabel: string } {
  if (!propertyId.trim()) {
    return { amount: 0, displayLabel: "—" };
  }
  const prop = getPropertyById(propertyId);
  const sub = prop?.listingSubmission;
  if (!sub) {
    return { amount: 50, displayLabel: "$50" };
  }
  const raw = submissionAmount(sub, "application_fee");
  const amount = parseMoneyAmount(raw);
  const displayLabel = raw.trim() || (amount > 0 ? `$${amount.toFixed(2)}` : "—");
  return { amount, displayLabel };
}

/**
 * Ensures a pending application-fee line exists when the listing requires a fee, so the applicant can pay
 * (e.g. Zelle or Venmo) and the manager can mark it paid before the wizard finalizes and shows an Axis ID.
 */
export function ensurePendingApplicationFeeCharge(input: {
  residentEmail: string;
  residentName: string;
  residentUserId: string | null;
  propertyId: string;
  applicationId?: string | null;
  managerUserId?: string | null;
  /** Match an existing fee created under another id on the row (e.g. `application.propertyId` vs `assignedPropertyId`). */
  propertyIdAliases?: string[] | null;
  /**
   * SERVER-authoritative fee in dollars (from `/api/public/application-fee-preview`,
   * which applies the manager-level fee). When provided it replaces the listing's
   * grandfathered `applicationFee` so the booked charge always equals what the
   * server actually charges — an explicit 0 books nothing at all.
   */
  feeAmountOverride?: number | null;
}): HouseholdCharge | null {
  const email = input.residentEmail.trim();
  if (!email || !email.includes("@")) return null;
  const prop = getPropertyById(input.propertyId);
  const sub = prop?.listingSubmission;
  let raw = sub ? submissionAmount(sub, "application_fee") : "";
  let amt = parseMoneyAmount(raw);
  if (!sub && amt <= 0) {
    raw = "$50";
    amt = 50;
  }
  if (input.feeAmountOverride != null && Number.isFinite(input.feeAmountOverride)) {
    amt = input.feeAmountOverride;
    raw = amt > 0 ? `$${amt.toFixed(2)}` : "";
  }
  if (amt <= 0) return null;

  const existing = findApplicationFeeCharge(
    email,
    input.propertyId,
    input.residentUserId,
    input.applicationId,
    input.propertyIdAliases,
  );
  if (existing) {
    const canonical = input.propertyId.trim();
    if (canonical && existing.propertyId !== canonical) {
      const rows = readAll();
      const i = rows.findIndex((r) => r.id === existing.id);
      if (i !== -1) {
        const next = [...rows];
        next[i] = { ...next[i]!, propertyId: canonical };
        writeAll(next);
        return next[i]!;
      }
    }
    return existing;
  }

  const zelleSnap =
    sub && sub.zellePaymentsEnabled && sub.zelleContact?.trim() ? sub.zelleContact.trim() : undefined;
  const venmoSnap =
    sub && sub.venmoPaymentsEnabled && sub.venmoContact?.trim() ? sub.venmoContact.trim() : undefined;

  const label = raw.trim() || `$${amt.toFixed(2)}`;
  const charge: HouseholdCharge = withPaymentReference({
    id: input.applicationId?.trim()
      ? applicationFeeChargeIdForApplication(input.applicationId.trim())
      : applicationFeeFallbackChargeId(email, input.propertyId),
    createdAt: new Date().toISOString(),
    applicationId: input.applicationId?.trim() || undefined,
    residentEmail: email,
    residentName: input.residentName.trim() || "Applicant",
    residentUserId: input.residentUserId,
    propertyId: input.propertyId,
    propertyLabel: prop?.title ?? (sub ? sub.buildingName : "Listing"),
    managerUserId: input.managerUserId ?? prop?.managerUserId ?? null,
    kind: "application_fee",
    title: chargeTitle("application_fee"),
    amountLabel: label,
    balanceLabel: label.includes("$") ? label : `$${amt.toFixed(2)}`,
    status: "pending",
    zelleContactSnapshot: zelleSnap,
    venmoContactSnapshot: venmoSnap,
    blocksLeaseUntilPaid: false,
  });
  writeAll([...readAll(), charge]);
  return charge;
}

function holdingDepositChargeIdForApplication(applicationId: string): string {
  return `hc_holding_${applicationId}`;
}

function holdingDepositFallbackChargeId(residentEmail: string, propertyId: string): string {
  return `hc_holding_${chargeKeyPart(residentEmail)}_${chargeKeyPart(propertyId)}`;
}

/**
 * @deprecated No longer shown or collected during the application (captain
 * decision, 2026-07 — see `ensurePendingHoldingDepositCharge` above and
 * `docs/agents/resident-payments.md`). Kept only in case a future Payments
 * surface wants the listing's configured holding-deposit amount; no
 * production call site remains.
 */
export function listingHoldingDepositAmount(propertyId: string): { amount: number; displayLabel: string } {
  if (!propertyId.trim()) {
    return { amount: 0, displayLabel: "—" };
  }
  const prop = getPropertyById(propertyId);
  const sub = prop?.listingSubmission;
  if (!sub) {
    return { amount: 0, displayLabel: "—" };
  }
  const raw = normalizeHoldingDepositLabel(sub.holdingDeposit);
  const amount = parseMoneyAmount(raw);
  const displayLabel = raw.trim() || (amount > 0 ? `$${amount.toFixed(2)}` : "—");
  return { amount, displayLabel };
}

export function findHoldingDepositCharge(
  residentEmail: string,
  propertyId: string,
  residentUserId: string | null,
  applicationId?: string | null,
  propertyIdAliases?: string[] | null,
): HouseholdCharge | undefined {
  const email = residentEmail.trim().toLowerCase();
  const ids = new Set([propertyId.trim(), ...(propertyIdAliases ?? []).map((id) => id.trim())].filter(Boolean));
  return readAll().find((charge) => {
    if (charge.kind !== "holding_deposit") return false;
    if (charge.residentEmail.trim().toLowerCase() !== email) return false;
    if (!ids.has(charge.propertyId)) return false;
    if (applicationId?.trim() && charge.applicationId && charge.applicationId !== applicationId.trim()) return false;
    if (residentUserId && charge.residentUserId && charge.residentUserId !== residentUserId) return false;
    return true;
  });
}

/**
 * @deprecated The holding deposit is no longer collected during the
 * application (captain decision, 2026-07: deposits move under Payments,
 * after approval — see `docs/agents/resident-payments.md`). NO callers
 * remain anywhere in src/ or tests/ — every application-submission call site
 * (`recordApplicationCharges`, `recordSubmittedApplicationFeeCharge`) and the
 * rental wizard's submit-time calls have all been removed, so this helper is
 * inert. Do not add new call sites.
 * Ensures a pending holding-deposit line exists when the listing requires one (one-time at application).
 */
export function ensurePendingHoldingDepositCharge(input: {
  residentEmail: string;
  residentName: string;
  residentUserId: string | null;
  propertyId: string;
  applicationId?: string | null;
  managerUserId?: string | null;
  propertyIdAliases?: string[] | null;
}): HouseholdCharge | null {
  const email = input.residentEmail.trim();
  if (!email || !email.includes("@")) return null;
  const prop = getPropertyById(input.propertyId);
  const sub = prop?.listingSubmission;
  if (!sub) return null;
  const raw = normalizeHoldingDepositLabel(sub.holdingDeposit);
  const amt = parseMoneyAmount(raw);
  if (amt <= 0) return null;

  const existing = findHoldingDepositCharge(
    email,
    input.propertyId,
    input.residentUserId,
    input.applicationId,
    input.propertyIdAliases,
  );
  if (existing) return existing;

  const zelleSnap =
    sub && sub.zellePaymentsEnabled && sub.zelleContact?.trim() ? sub.zelleContact.trim() : undefined;
  const venmoSnap =
    sub && sub.venmoPaymentsEnabled && sub.venmoContact?.trim() ? sub.venmoContact.trim() : undefined;

  const label = raw.trim() || `$${amt.toFixed(2)}`;
  const charge: HouseholdCharge = withPaymentReference({
    id: input.applicationId?.trim()
      ? holdingDepositChargeIdForApplication(input.applicationId.trim())
      : holdingDepositFallbackChargeId(email, input.propertyId),
    createdAt: new Date().toISOString(),
    applicationId: input.applicationId?.trim() || undefined,
    residentEmail: email,
    residentName: input.residentName.trim() || "Applicant",
    residentUserId: input.residentUserId,
    propertyId: input.propertyId,
    propertyLabel: prop?.title ?? sub.buildingName,
    managerUserId: input.managerUserId ?? prop?.managerUserId ?? null,
    kind: "holding_deposit",
    title: chargeTitle("holding_deposit"),
    amountLabel: label,
    balanceLabel: label.includes("$") ? label : `$${amt.toFixed(2)}`,
    status: "pending",
    zelleContactSnapshot: zelleSnap,
    venmoContactSnapshot: venmoSnap,
    blocksLeaseUntilPaid: false,
  });
  writeAll([...readAll(), charge]);
  return charge;
}

/**
 * Creates (or re-prices) a MANAGER-ENTERED holding fee for one applicant.
 *
 * Distinct from the deprecated `ensurePendingHoldingDepositCharge` above: that
 * one auto-collected at application time from a per-listing amount, which the
 * captain removed in 2026-07. This is the opposite shape — the manager decides,
 * per applicant, whether to ask for a hold and how much, from the application
 * detail. Nothing is created unless they enter an amount.
 *
 * Re-running with a new amount updates the existing pending line rather than
 * stacking a second hold on the same applicant; a hold the applicant has
 * already PAID is never silently re-priced (the money is in), so that returns
 * the paid charge unchanged and the caller reports it.
 */
export function setApplicantHoldingFee(input: {
  residentEmail: string;
  residentName: string;
  residentUserId: string | null;
  propertyId: string;
  applicationId?: string | null;
  managerUserId?: string | null;
  amount: number;
}): { ok: true; charge: HouseholdCharge; alreadyPaid: boolean } | { ok: false; error: string } {
  const email = input.residentEmail.trim();
  if (!email.includes("@")) return { ok: false, error: "This applicant has no email address on file." };
  if (!input.propertyId.trim()) return { ok: false, error: "This application has no property on it yet." };
  const amt = Number(input.amount);
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, error: "Enter a holding fee amount greater than $0." };
  if (amt > 100_000) return { ok: false, error: "That holding fee looks too large — check the amount." };

  const existing = findHoldingDepositCharge(email, input.propertyId, input.residentUserId, input.applicationId);
  if (existing?.status === "paid") {
    return { ok: true, charge: existing, alreadyPaid: true };
  }

  const prop = getPropertyById(input.propertyId);
  const sub = prop?.listingSubmission;
  const zelleSnap = sub?.zellePaymentsEnabled && sub.zelleContact?.trim() ? sub.zelleContact.trim() : undefined;
  const venmoSnap = sub?.venmoPaymentsEnabled && sub.venmoContact?.trim() ? sub.venmoContact.trim() : undefined;
  const label = moneyAmountLabel(Number(amt.toFixed(2)));

  const charge: HouseholdCharge = withPaymentReference({
    id:
      existing?.id ??
      (input.applicationId?.trim()
        ? holdingDepositChargeIdForApplication(input.applicationId.trim())
        : holdingDepositFallbackChargeId(email, input.propertyId)),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    applicationId: input.applicationId?.trim() || undefined,
    residentEmail: email,
    residentName: input.residentName.trim() || "Applicant",
    residentUserId: input.residentUserId,
    propertyId: input.propertyId,
    propertyLabel: prop?.title ?? sub?.buildingName ?? "",
    managerUserId: input.managerUserId ?? prop?.managerUserId ?? null,
    kind: "holding_deposit",
    title: chargeTitle("holding_deposit"),
    amountLabel: label,
    balanceLabel: label,
    status: "pending",
    zelleContactSnapshot: zelleSnap,
    venmoContactSnapshot: venmoSnap,
    blocksLeaseUntilPaid: false,
  });

  const rest = readAll().filter((c) => c.id !== charge.id);
  writeAll([...rest, charge]);
  return { ok: true, charge, alreadyPaid: false };
}

/** Removes a manager-added holding fee that has NOT been paid. */
export function removeApplicantHoldingFee(input: {
  residentEmail: string;
  propertyId: string;
  residentUserId: string | null;
  applicationId?: string | null;
}): { ok: true } | { ok: false; error: string } {
  const existing = findHoldingDepositCharge(
    input.residentEmail,
    input.propertyId,
    input.residentUserId,
    input.applicationId,
  );
  if (!existing) return { ok: true };
  if (existing.status === "paid") {
    return { ok: false, error: "This holding fee has already been paid — handle a refund with the applicant directly." };
  }
  writeAll(readAll().filter((c) => c.id !== existing.id));
  return { ok: true };
}

function paidHoldingDepositCreditCents(applicationId: string): number {
  const appId = applicationId.trim();
  if (!appId) return 0;
  const charge = readAll().find((c) => c.applicationId === appId && c.kind === "holding_deposit" && c.status === "paid");
  if (!charge) return 0;
  return Math.round(parseMoneyAmount(charge.amountLabel) * 100);
}

/**
 * "The Pioneer" + "12A" -> "The Pioneer · 12A", but never "The Pioneer · 12A · 12A".
 * Callers pass the property name and unit separately, yet some sources already
 * fold the unit into the name, which produced a doubled unit on every surface
 * that echoes the charge (resident Payments, manager Payments, receipts).
 */
export function joinPropertyAndUnitLabel(propertyLabel: string, unit: string): string {
  const label = (propertyLabel ?? "").trim();
  const u = (unit ?? "").trim();
  if (!u) return label;
  if (!label) return u;
  const tail = label.split("·").pop()?.trim().toLowerCase();
  if (tail === u.toLowerCase()) return label;
  return `${label} · ${u}`;
}

/**
 * Bill a resident for work order cost (pass-through). Creates a pending line on manager Payments and resident Payments.
 */
export function recordWorkOrderResidentCharge(input: {
  managerUserId: string;
  workOrderId: string;
  propertyLabel: string;
  unit: string;
  workOrderTitle: string;
  /** Raw amount e.g. "75", "$75", "75.00" */
  amountInput: string;
  residentEmail: string;
  residentName: string;
  /** Actual property id for finances filtering; falls back to work-order pseudo id. */
  propertyId?: string;
  dueDateLabel?: string;
  initialStatus?: "pending" | "paid";
  zelleContactSnapshot?: string | null;
}): HouseholdCharge | null {
  const amt = parseMoneyAmount(input.amountInput);
  if (amt <= 0) return null;
  const email = input.residentEmail.trim().toLowerCase();
  if (!email || !email.includes("@")) return null;

  if (findWorkOrderCharge(input.workOrderId)) {
    return null;
  }

  const isPaid = input.initialStatus === "paid";
  const balance = `$${amt.toFixed(2)}`;
  const now = new Date().toISOString();
  const charge = ensureChargeDueDateForReminders({
    id: `hc_wo_${input.workOrderId}_${Date.now()}`,
    createdAt: now,
    residentEmail: input.residentEmail.trim(),
    residentName: input.residentName.trim() || "Resident",
    residentUserId: null,
    propertyId: input.propertyId?.trim() || `workorder:${input.workOrderId}`,
    propertyLabel: joinPropertyAndUnitLabel(input.propertyLabel, input.unit),
    managerUserId: input.managerUserId,
    kind: "work_order_charge",
    title: `Work order · ${input.workOrderTitle}`,
    amountLabel: balance,
    balanceLabel: isPaid ? "$0.00" : balance,
    status: isPaid ? "paid" : "pending",
    paidAt: isPaid ? now : undefined,
    dueDateLabel: input.dueDateLabel?.trim() || undefined,
    zelleContactSnapshot: input.zelleContactSnapshot ?? undefined,
    blocksLeaseUntilPaid: false,
    workOrderId: input.workOrderId,
  });
  writeAll([...readAll(), charge], true);
  void postHouseholdPayloadAwait({
    action: "replace",
    charges: [charge],
    rentProfiles: readRentProfiles(),
  }).then((ok) => {
    if (ok) emit();
  });
  return charge;
}

function syncAllRecurringRentCharges(): boolean {
  if (!isBrowser()) return false;
  backfillMonthlyUtilitiesOnRentProfiles();
  const profiles = readRentProfiles().filter(
    (p) => p.active && (p.monthlyRent > 0 || (p.dailyRentPrice ?? 0) > 0 || (p.monthlyUtilities ?? 0) > 0),
  );
  if (profiles.length === 0) return false;

  const now = new Date();
  const existing = readAll();
  const newCharges: HouseholdCharge[] = [];

  const hasUpfrontProratedLastCharge = (
    residentEmail: string,
    propertyId: string,
    kind: "prorated_last_month_rent" | "prorated_last_month_utilities",
  ) => {
    const emailLower = residentEmail.trim().toLowerCase();
    return [...existing, ...newCharges].some(
      (c) => c.kind === kind && c.residentEmail.trim().toLowerCase() === emailLower && c.propertyId === propertyId,
    );
  };

  // Build a map of profile id → profile for stale-charge cleanup
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const staleIds = new Set<string>();
  for (const c of existing) {
    if (isStaleRecurringHouseholdCharge(c, profileById, existing)) staleIds.add(c.id);
  }
  const activeExisting = staleIds.size > 0 ? existing.filter((c) => !staleIds.has(c.id)) : existing;

  for (const profile of profiles) {
    const dueDayMode = profile.dueDayMode ?? "first_of_month";
    const profileStartMonth = profile.startMonth?.trim() || currentRentMonth();

    // Parse lease end for last-month proration
    const leaseEndParts = profile.leaseEnd?.trim().split("-").map(Number) ?? [];
    const leaseEndYear = leaseEndParts[0] && Number.isFinite(leaseEndParts[0]) ? leaseEndParts[0] : null;
    const leaseEndMonthNum = leaseEndParts[1] && Number.isFinite(leaseEndParts[1]) ? leaseEndParts[1] : null;
    const leaseEndDay = leaseEndParts[2] && Number.isFinite(leaseEndParts[2]) ? leaseEndParts[2] : null;

    const currentMonth = monthKeyFromDate(now);
    const nextMonth = addMonthsToMonthKey(currentMonth, 1);
    const monthsToGenerate = new Set<string>(monthsBetweenInclusive(profileStartMonth, currentMonth));
    // Look one month ahead so next month's rent is visible early — but NEVER before the
    // profile's own start month. `startMonth` is deliberately the month AFTER move-in
    // (`firstRecurringMonthAfterLeaseStart`) because the move-in month is already billed by the
    // upfront first-month/prorated charges. Adding `nextMonth` unconditionally re-billed that
    // same month for any lease starting in the future, on top of the upfront charge.
    if (nextMonth >= profileStartMonth) monthsToGenerate.add(nextMonth);

    for (const rentMonth of [...monthsToGenerate].sort()) {
      const [candidateYear, candidateMonthNum] = rentMonth.split("-").map(Number);
      if (!candidateYear || !candidateMonthNum) continue;
      const dueDay = effectiveDueDayForMonth(profile.dueDay, dueDayMode, rentMonth);

      // Skip months after lease end
      if (leaseEndYear && leaseEndMonthNum) {
        const leaseEndMonth = `${leaseEndYear}-${String(leaseEndMonthNum).padStart(2, "0")}`;
        if (rentMonth > leaseEndMonth) continue;
      }

      const candidateDate = new Date(candidateYear, candidateMonthNum - 1, dueDay, 12, 0, 0, 0);
      const dueLabel = formatRecurringRentDueLabel(rentMonth, dueDay, dueDayMode);
      const monthLabel = candidateDate.toLocaleString("default", { month: "long", year: "numeric" });

      // Determine if this is a partial last month
      const isLastMonth = leaseEndYear !== null && leaseEndMonthNum !== null && leaseEndDay !== null
        && candidateYear === leaseEndYear && candidateMonthNum === leaseEndMonthNum;
      const daysInCandidateMonth = new Date(candidateYear, candidateMonthNum, 0).getDate();
      const isPartialLastMonth = isLastMonth && leaseEndDay! < daysInCandidateMonth;
      const proratedFactor = isPartialLastMonth ? leaseEndDay! / daysInCandidateMonth : 1;

      // When the last month is partial, recordApprovedApplicationCharges creates upfront prorated_last_month_rent
      // charges so residents can see them from approval time. Skip the recurring-generated version.
      const emailLower = profile.residentEmail.trim().toLowerCase();
      const hasUpfrontLastRent =
        isPartialLastMonth && hasUpfrontProratedLastCharge(profile.residentEmail, profile.propertyId, "prorated_last_month_rent");
      const hasUpfrontLastUtil =
        isPartialLastMonth && hasUpfrontProratedLastCharge(profile.residentEmail, profile.propertyId, "prorated_last_month_utilities");

      // Bundle-group members store the FULL household amounts on the profile, so
      // every amount below is divided the same way the move-in charges were.
      // Null for every ordinary profile, which leaves that path byte-identical.
      const splitCtx = bundleSplitContextFromProfile(profile);

      const profileDailyRate =
        typeof profile.dailyRentPrice === "number" && profile.dailyRentPrice > 0 ? profile.dailyRentPrice : 0;
      if ((profile.monthlyRent > 0 || profileDailyRate > 0) && !hasUpfrontLastRent) {
        const chargeKey = `rent|${emailLower}|${profile.propertyId}|${rentMonth}`;
        const alreadyExists =
          activeExisting.some((c) => chargeBusinessKey(c) === chargeKey) ||
          newCharges.some((c) => chargeBusinessKey(c) === chargeKey);
        if (!alreadyExists) {
          // Daily-priced rooms bill actual days-in-month × daily rate (partial last month
          // bills leaseEndDay × rate); monthly rooms keep the flat monthlyRent × factor.
          const daysBilled = isPartialLastMonth ? leaseEndDay! : daysInCandidateMonth;
          const householdAmount =
            profileDailyRate > 0
              ? Number((daysBilled * profileDailyRate).toFixed(2))
              : Number((profile.monthlyRent * proratedFactor).toFixed(2));
          const rawTitlePrefix =
            profileDailyRate > 0
              ? `${isPartialLastMonth ? "Prorated rent" : "Rent"} (${daysBilled} days × ${formatRoomPriceAmount(profileDailyRate)}/day)`
              : isPartialLastMonth
                ? "Prorated rent"
                : "Rent";
          const rentSplit = applyBundleGroupSplit(householdAmount, rawTitlePrefix, splitCtx);
          const amount = rentSplit.amount;
          const titlePrefix = rentSplit.title;
          newCharges.push({
            ...(rentSplit.split ?? {}),
            id: `hc_rent_${chargeKeyPart(profile.residentEmail)}_${chargeKeyPart(profile.propertyId)}_${rentMonth}`,
            createdAt: new Date().toISOString(),
            residentEmail: profile.residentEmail,
            residentName: profile.residentName,
            residentUserId: profile.residentUserId,
            propertyId: profile.propertyId,
            propertyLabel: profile.propertyLabel,
            managerUserId: profile.managerUserId,
            kind: "rent",
            title: `${titlePrefix} — ${monthLabel}`,
            amountLabel: moneyAmountLabel(amount),
            balanceLabel: moneyAmountLabel(amount),
            status: "pending",
            recurringRentProfileId: profile.id,
            rentMonth,
            dueDay,
            dueDayMode,
            dueDateLabel: isPartialLastMonth
              ? `By ${new Date(leaseEndYear!, leaseEndMonthNum! - 1, leaseEndDay!).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
              : dueLabel,
            blocksLeaseUntilPaid: false,
            zelleContactSnapshot: profile.zelleContact,
            venmoContactSnapshot: profile.venmoContact,
          });
        }
      }

      const utilAmt = profile.monthlyUtilities ?? 0;
      if (utilAmt > 0 && !hasUpfrontLastUtil) {
        const utilKey = `utilities_recurring|${emailLower}|${profile.propertyId}|${rentMonth}`;
        const alreadyUtil =
          activeExisting.some((c) => chargeBusinessKey(c) === utilKey) ||
          newCharges.some((c) => chargeBusinessKey(c) === utilKey);
        if (!alreadyUtil) {
          const utilSplit = applyBundleGroupSplit(
            Number((utilAmt * proratedFactor).toFixed(2)),
            isPartialLastMonth ? "Prorated utilities" : "Utilities",
            splitCtx,
          );
          const amount = utilSplit.amount;
          const titlePrefix = utilSplit.title;
          newCharges.push({
            ...(utilSplit.split ?? {}),
            id: `hc_util_${chargeKeyPart(profile.residentEmail)}_${chargeKeyPart(profile.propertyId)}_${rentMonth}`,
            createdAt: new Date().toISOString(),
            residentEmail: profile.residentEmail,
            residentName: profile.residentName,
            residentUserId: profile.residentUserId,
            propertyId: profile.propertyId,
            propertyLabel: profile.propertyLabel,
            managerUserId: profile.managerUserId,
            kind: "utilities",
            title: `${titlePrefix} — ${monthLabel}`,
            amountLabel: moneyAmountLabel(amount),
            balanceLabel: moneyAmountLabel(amount),
            status: "pending",
            recurringRentProfileId: profile.id,
            rentMonth,
            dueDay,
            dueDayMode,
            dueDateLabel: isPartialLastMonth
              ? `By ${new Date(leaseEndYear!, leaseEndMonthNum! - 1, leaseEndDay!).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
              : dueLabel,
            blocksLeaseUntilPaid: false,
            zelleContactSnapshot: profile.zelleContact,
            venmoContactSnapshot: profile.venmoContact,
          });
        }
      }

      // Monthly custom fees (parking, storage, …) bill their FULL amount each recurring
      // month — a flat monthly service, not prorated. Each fee's own business key
      // (custom_fee|…|feeId|month) makes emission exactly-once per month across repeated
      // syncs; an amount change only affects months not yet emitted.
      for (const fee of profile.monthlyFees ?? []) {
        if (!(fee.amount > 0)) continue;
        const feeKey = `custom_fee|${emailLower}|${profile.propertyId}|${fee.id}|${rentMonth}`;
        const alreadyFee =
          activeExisting.some((c) => chargeBusinessKey(c) === feeKey) ||
          newCharges.some((c) => chargeBusinessKey(c) === feeKey);
        if (alreadyFee) continue;
        const feeSplit = applyBundleGroupSplit(fee.amount, fee.label, splitCtx);
        newCharges.push({
          ...(feeSplit.split ?? {}),
          id: `hc_cf_${chargeKeyPart(fee.id)}_${chargeKeyPart(profile.residentEmail)}_${chargeKeyPart(profile.propertyId)}_${rentMonth}`,
          createdAt: new Date().toISOString(),
          residentEmail: profile.residentEmail,
          residentName: profile.residentName,
          residentUserId: profile.residentUserId,
          propertyId: profile.propertyId,
          propertyLabel: profile.propertyLabel,
          managerUserId: profile.managerUserId,
          kind: "other_cost",
          customFeeId: fee.id,
          title: `${feeSplit.title} — ${monthLabel}`,
          amountLabel: moneyAmountLabel(feeSplit.amount),
          balanceLabel: moneyAmountLabel(feeSplit.amount),
          status: "pending",
          recurringRentProfileId: profile.id,
          rentMonth,
          dueDay,
          dueDayMode,
          dueDateLabel: dueLabel,
          blocksLeaseUntilPaid: false,
          zelleContactSnapshot: profile.zelleContact,
          venmoContactSnapshot: profile.venmoContact,
        });
      }
    }
  }

  // Remove stale pending recurring charges that violate profile boundaries.
  const cleanedExisting = staleIds.size > 0 ? activeExisting : existing;
  if (newCharges.length > 0 || staleIds.size > 0) {
    writeAll([...cleanedExisting, ...newCharges], true);
    emit();
    return true;
  }
  return false;
}

/**
 * Re-runs charge generation for every approved resident so payments align with lease dates.
 * Safe to call repeatedly; idempotent via charge dedupe keys.
 */
export function reconcileApprovedResidentPaymentSchedules(managerUserId: string | null, force = false): boolean {
  if (!isBrowser()) return false;
  const currentRows = readManagerApplicationRows().filter((row) => {
    if (!shouldReconcileResidentPaymentSchedule(row)) return false;
    if (!managerUserId) return true;
    // Match Add payment / Payments UI: include co-managed residents the portal
    // user can see, not only rows whose managerUserId equals the signed-in user.
    // The old ownership-only filter caused Add payment one-offs to be purged
    // (resident visible in picker → charge created → reconcile wiped it).
    return applicationVisibleToPortalUser(row, managerUserId);
  });

  const scope = managerUserId ?? HOUSEHOLD_CHARGE_DEMO_MANAGER_SCOPE;
  const currentResidentEmails = new Set(currentRows.map((row) => row.email!.trim().toLowerCase()));
  const existingCharges = readAll();
  const existingProfiles = readRentProfiles();
  const filteredCharges = existingCharges.filter((charge) => {
    if (charge.managerUserId !== scope) return true;
    // Manager "Add payment" one-offs (hc_mgr_*) must survive even when the
    // resident isn't in the approved-current set (e.g. co-managed / catalog
    // apps, or charges added before approval). The old filter wiped them on
    // every reconciler run — Pending stayed empty.
    if (isManagerAddedOneOffCharge(charge)) return true;
    return currentResidentEmails.has(charge.residentEmail.trim().toLowerCase());
  });
  const filteredProfiles = existingProfiles.filter((profile) => {
    if (profile.managerUserId !== scope) return true;
    return currentResidentEmails.has(profile.residentEmail.trim().toLowerCase());
  });

  let changed = false;
  if (filteredCharges.length !== existingCharges.length) {
    writeAll(filteredCharges, true);
    changed = true;
  }
  if (filteredProfiles.length !== existingProfiles.length) {
    writeRentProfiles(filteredProfiles);
    changed = true;
  }

  for (const row of currentRows) {
    if (recordApprovedApplicationCharges(row, managerUserId, force)) {
      changed = true;
    }
  }
  if (syncAllRecurringRentCharges()) changed = true;
  return changed;
}

export function readRecurringRentProfilesForManager(managerUserId: string | null): RecurringRentProfile[] {
  const scope = managerUserId ?? HOUSEHOLD_CHARGE_DEMO_MANAGER_SCOPE;
  return readRentProfiles().filter((profile) => profile.managerUserId === scope && profile.active);
}

export function upsertRecurringRentProfile(input: {
  residentEmail: string;
  residentName: string;
  residentUserId?: string | null;
  propertyId: string;
  propertyLabel: string;
  roomLabel: string;
  managerUserId: string | null;
  monthlyRent: number;
  /**
   * Headline daily rate when the room is priced by the day. Pass an explicit `0`
   * to CLEAR a previously daily-priced profile (a room switched back to monthly);
   * omit the field entirely to leave whatever the profile already has.
   */
  dailyRentPrice?: number;
  monthlyUtilities?: number;
  /** Monthly custom fees to bill each recurring month. An explicit array (even []) is
   *  authoritative — [] clears prior fees; omitting the field inherits the existing set. */
  monthlyFees?: { id: string; label: string; amount: number }[];
  /** Bundle-group split for the recurring months. See `RecurringRentProfile`.
   *  Authoritative when `splitMemberCount` is supplied (even as undefined by an
   *  explicit caller), so a re-approval out of a group clears a stale split
   *  rather than inheriting it — same contract as `monthlyFees`. */
  bundleGroupId?: string;
  bundleId?: string;
  splitMemberIndex?: number;
  splitMemberCount?: number;
  dueDay?: number;
  dueDayMode?: RentDueDayMode;
  startMonth?: string;
  leaseEnd?: string;
  zelleContact?: string;
  venmoContact?: string;
}): RecurringRentProfile | null {
  if (!isBrowser()) return null;
  const profiles = readRentProfiles();
  const key = `${input.residentEmail.trim().toLowerCase()}|${input.propertyId}`;
  const existing = profiles.find((p) => recurringRentProfileKey(p) === key);
  const monthlyUtilities =
    input.monthlyUtilities !== undefined && Number.isFinite(input.monthlyUtilities)
      ? Math.max(0, Number(input.monthlyUtilities))
      : (existing?.monthlyUtilities ?? 0);
  const monthlyFees = (input.monthlyFees ?? existing?.monthlyFees ?? [])
    .map((f) => ({ id: f.id, label: f.label, amount: Math.max(0, Number(f.amount) || 0) }))
    .filter((f) => f.amount > 0);
  const profile: RecurringRentProfile = {
    id: existing?.id ?? `rrp_${chargeKeyPart(input.residentEmail)}_${chargeKeyPart(input.propertyId)}`,
    residentEmail: input.residentEmail,
    residentName: input.residentName,
    residentUserId: input.residentUserId ?? null,
    propertyId: input.propertyId,
    propertyLabel: input.propertyLabel,
    roomLabel: input.roomLabel,
    managerUserId: input.managerUserId,
    monthlyRent: input.monthlyRent,
    // An explicit number is authoritative — including 0, which clears a stale daily
    // rate so a room switched back to monthly stops billing per day. Only an omitted
    // field inherits the existing value.
    dailyRentPrice:
      input.dailyRentPrice !== undefined && Number.isFinite(input.dailyRentPrice)
        ? (input.dailyRentPrice > 0 ? Number(input.dailyRentPrice) : undefined)
        : existing?.dailyRentPrice,
    monthlyUtilities,
    monthlyFees,
    // `recordApprovedApplicationCharges` always passes all four (undefined when
    // the applicant is not in a bundle group), so re-approving a resident out of
    // a group clears the split instead of leaving them on a stale divisor.
    bundleGroupId: input.bundleGroupId,
    bundleId: input.bundleId,
    splitMemberIndex: input.splitMemberIndex,
    splitMemberCount: input.splitMemberCount,
    dueDay: Math.min(28, Math.max(1, input.dueDay ?? 1)),
    dueDayMode: input.dueDayMode ?? existing?.dueDayMode ?? "first_of_month",
    startMonth: input.startMonth ?? currentRentMonth(),
    leaseEnd: input.leaseEnd?.trim() || undefined,
    active: true,
    updatedAt: new Date().toISOString(),
    zelleContact: input.zelleContact,
    venmoContact: input.venmoContact,
  };
  const next = profiles.some((p) => recurringRentProfileKey(p) === key)
    ? profiles.map((p) => (recurringRentProfileKey(p) === key ? profile : p))
    : [...profiles, profile];
  writeRentProfiles(next);
  return profile;
}

/**
 * When a manager changes a resident's room or rent amount, update all unpaid
 * recurring rent charges so the balance the resident sees stays accurate.
 */
export function updatePendingRentAmountForResident(
  email: string,
  propertyId: string,
  newAmount: number,
  managerUserId: string | null,
): void {
  if (!isBrowser()) return;
  const e = email.trim().toLowerCase();
  const rows = readAll();
  let changed = false;
  const next = rows.map((r) => {
    if (
      r.kind === "rent" &&
      r.status === "pending" &&
      r.residentEmail.trim().toLowerCase() === e &&
      r.propertyId === propertyId &&
      (r.managerUserId === managerUserId || r.managerUserId === HOUSEHOLD_CHARGE_DEMO_MANAGER_SCOPE)
    ) {
      changed = true;
      return { ...r, amountLabel: `$${newAmount}`, balanceLabel: `$${newAmount}` };
    }
    return r;
  });
  if (changed) writeAll(next);
}

/** Link charges created with email-only to the signed-in resident account. */
export function linkHouseholdChargesToResidentUser(email: string, userId: string) {
  const e = email.trim().toLowerCase();
  if (!e || !userId) return;
  const rows = readAll();
  let changed = false;
  const next = rows.map((r) => {
    if (r.residentEmail.trim().toLowerCase() === e && r.residentUserId !== userId) {
      changed = true;
      return { ...r, residentUserId: userId };
    }
    return r;
  });
  if (changed) writeAll(next);

  const profiles = readRentProfiles();
  let profileChanged = false;
  const nextProfiles = profiles.map((profile) => {
    if (profile.residentEmail.trim().toLowerCase() === e && profile.residentUserId !== userId) {
      profileChanged = true;
      return { ...profile, residentUserId: userId };
    }
    return profile;
  });
  if (profileChanged) writeRentProfiles(nextProfiles);
}

export function readChargesForResident(email: string, userId: string | null): HouseholdCharge[] {
  const e = email.trim().toLowerCase();
  const profiles = readRentProfiles();
  const profileById = new Map(profiles.map((p) => [p.id, p]));

  const scoped = dedupeCharges(readAll()).filter((r) => {
    if (userId && r.residentUserId === userId) return true;
    return Boolean(e && r.residentEmail.trim().toLowerCase() === e);
  });

  return scoped
    .filter((charge) => shouldDisplayChargeInPayments(charge))
    .filter((charge) => charge.status === "paid" || !isStaleRecurringHouseholdCharge(charge, profileById, scoped));
}

/**
 * Whether the signed-in manager may view or mutate this charge (or legacy rows with no manager id).
 * Does not allow cross-manager access when `charge.managerUserId` is set to another id.
 */
export function chargeVisibleToManager(charge: HouseholdCharge, managerUserId: string | null): boolean {
  if (managerUserId == null || managerUserId === "") return true;
  const scope = managerUserId ?? HOUSEHOLD_CHARGE_DEMO_MANAGER_SCOPE;
  if (charge.managerUserId === scope) return true;
  if (charge.managerUserId == null || charge.managerUserId === "") return true;
  return false;
}

/** Charges for one resident email scoped to the manager viewing the Residents / Payments drill-down. */
export function readChargesForManagerResident(email: string, managerUserId: string | null): HouseholdCharge[] {
  const e = email.trim().toLowerCase();
  if (!e) return [];
  const all = dedupeCharges(readAll());
  const profileById = new Map(readRentProfiles().map((p) => [p.id, p]));
  const scoped = all
    .filter((r) => r.residentEmail.trim().toLowerCase() === e)
    .filter((r) => chargeVisibleToManager(r, managerUserId));
  return scoped
    .filter((charge) => shouldDisplayChargeInPayments(charge))
    .filter((charge) => charge.status === "paid" || !isStaleRecurringHouseholdCharge(charge, profileById, scoped));
}

export function readChargesForManager(
  managerUserId: string | null,
  opts?: {
    /** Linked-property ids an accepted co-manager may see (payments module) —
     *  computed by the caller via collectLinkedPropertyIdsForModule so this
     *  module stays dependency-free. */
    linkedPropertyIds?: Set<string>;
  },
): HouseholdCharge[] {
  const scope = managerUserId ?? HOUSEHOLD_CHARGE_DEMO_MANAGER_SCOPE;
  const linked = opts?.linkedPropertyIds;
  const all = dedupeCharges(readAll());
  const profileById = new Map(readRentProfiles().map((p) => [p.id, p]));
  return all
    .filter(
      (r) =>
        r.managerUserId === scope ||
        Boolean(linked?.size && r.propertyId && linked.has(r.propertyId)),
    )
    .filter((charge) => shouldDisplayChargeInPayments(charge))
    .filter((charge) => charge.status === "paid" || !isStaleRecurringHouseholdCharge(charge, profileById, all));
}

export function deleteHouseholdCharge(chargeId: string, managerUserId: string | null): boolean {
  if (!isBrowser()) return false;
  const rows = readAll();
  const idx = rows.findIndex((r) => r.id === chargeId && chargeVisibleToManager(r, managerUserId));
  if (idx === -1) return false;
  deleteChargeRowFromServer(chargeId);
  writeAll(rows.filter((_, i) => i !== idx));
  return true;
}

export function cancelHouseholdChargeReminder(
  chargeId: string,
  slot: "7d" | "5d" | "3d" | "12h" | "overdue_daily",
  managerUserId: string | null,
): boolean {
  if (!isBrowser()) return false;
  const rows = readAll();
  const i = rows.findIndex((r) => r.id === chargeId && chargeVisibleToManager(r, managerUserId));
  if (i === -1) return false;
  const existing = rows[i]!.cancelledReminders ?? [];
  if (existing.includes(slot)) return true;
  const next = [...rows];
  next[i] = { ...next[i]!, cancelledReminders: [...existing, slot] };
  writeAll(next);
  return true;
}

export function uncancelHouseholdChargeReminder(
  chargeId: string,
  slot: "7d" | "5d" | "3d" | "12h" | "overdue_daily",
  managerUserId: string | null,
): boolean {
  if (!isBrowser()) return false;
  const rows = readAll();
  const i = rows.findIndex((r) => r.id === chargeId && chargeVisibleToManager(r, managerUserId));
  if (i === -1) return false;
  const existing = rows[i]!.cancelledReminders ?? [];
  if (!existing.includes(slot)) return true;
  const next = [...rows];
  next[i] = { ...next[i]!, cancelledReminders: existing.filter((s) => s !== slot) };
  writeAll(next);
  return true;
}

export function markHouseholdChargePaid(chargeId: string, managerUserId: string | null): boolean {
  const rows = readAll();
  const i = rows.findIndex((r) => r.id === chargeId && chargeVisibleToManager(r, managerUserId));
  if (i === -1) return false;
  if (rows[i]!.status === "paid") return true;
  const now = new Date().toISOString();
  const next = [...rows];
  const updated = { ...next[i]!, status: "paid" as const, paidAt: now, balanceLabel: "$0.00" };
  next[i] = updated;
  writeAll(next);
  // Re-emit after server sync so schedule/inbox views reload with paid status applied.
  void postHouseholdPayloadAwait({
    action: "replace",
    charges: [updated],
    rentProfiles: readRentProfiles(),
  }).then((ok) => {
    if (ok) emit();
    void import("@/lib/service-requests-storage").then(({ syncServiceRequestPaidFromCharge }) => {
      syncServiceRequestPaidFromCharge(chargeId);
    });
  });
  return true;
}

export function markHouseholdChargePending(chargeId: string, managerUserId: string | null): boolean {
  const rows = readAll();
  const i = rows.findIndex((r) => r.id === chargeId && chargeVisibleToManager(r, managerUserId));
  if (i === -1) return false;
  if (rows[i]!.status === "pending") return true;
  const next = [...rows];
  // Clear dueDateLabel so parseDueDateLabelToDate returns null → isHouseholdChargeOverdue is false
  // → the charge lands in the Pending bucket, not Overdue, regardless of the original due date.
  const updated = {
    ...next[i]!,
    status: "pending" as const,
    paidAt: undefined,
    balanceLabel: next[i]!.amountLabel,
    dueDateLabel: undefined,
    cancelledReminders: undefined,
  };
  next[i] = updated;
  writeAll(next);
  // Reverting a paid charge is an explicit, deliberate action. Route it through
  // the dedicated `unmarkPaid` server action — the full-list "replace" mirror can
  // no longer downgrade a paid charge (paid is sticky server-side), so this is the
  // only path that persists the revert.
  void postHouseholdPayloadAwait({
    action: "unmarkPaid",
    id: chargeId,
  }).then((ok) => {
    if (ok) emit();
  });
  return true;
}

/** Merge server-returned charge rows into the browser session store after a resident payment action. */
export function applyHouseholdChargePatches(updates: HouseholdCharge[]): void {
  if (!isBrowser() || updates.length === 0) return;
  hydrateHouseholdStateFromSession();
  const byId = new Map(updates.map((c) => [c.id, c]));
  const next = readAll().map((c) => byId.get(c.id) ?? c);
  writeAll(next);
  emit();
}

/** Resident confirms they sent Zelle/Venmo for pending charges; charge stays pending until manager marks paid. */
export async function reportResidentManualPayment(
  chargeIds: string[],
  channel: "zelle" | "venmo",
): Promise<{ ok: true; charges: HouseholdCharge[] } | { ok: false; error: string }> {
  if (!isBrowser() || isDemoModeActive()) {
    return { ok: false, error: "Manual payment reporting is unavailable in demo mode." };
  }
  const ids = [...new Set(chargeIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return { ok: false, error: "No charges selected." };

  const res = await fetch("/api/portal/resident-report-manual-payment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ chargeIds: ids, channel }),
  });
  const payload = (await res.json().catch(() => ({}))) as { charges?: HouseholdCharge[]; error?: string };
  if (!res.ok) {
    return { ok: false, error: typeof payload.error === "string" ? payload.error : "Could not report payment." };
  }

  const updates = Array.isArray(payload.charges) ? payload.charges : [];
  if (updates.length > 0) {
    applyHouseholdChargePatches(updates);
  }
  return { ok: true, charges: updates };
}

/**
 * Marks the pending application-fee line paid after the applicant completes card payment (Stripe) in the apply flow.
 * Demo: simulates an immediate successful charge so submit can proceed without a manager action.
 */
export function markApplicationFeePaidAfterStripe(residentEmail: string, propertyId: string, residentUserId: string | null): boolean {
  const charge = findApplicationFeeCharge(residentEmail, propertyId, residentUserId);
  if (!charge || charge.kind !== "application_fee") return false;
  if (charge.status === "paid") return true;
  const rows = readAll();
  const i = rows.findIndex((r) => r.id === charge.id);
  if (i === -1) return false;
  const now = new Date().toISOString();
  const next = [...rows];
  next[i] = { ...next[i]!, status: "paid", paidAt: now, balanceLabel: "$0.00" };
  writeAll(next);
  return true;
}

/**
 * Sibling of `markApplicationFeePaidAfterStripe` for the holding-deposit leg
 * of a combined at-application charge. Legacy-only: combined fee+deposit
 * collection was removed (nothing creates such a charge anymore — see
 * `ensurePendingHoldingDepositCharge` above), so this is a no-op (returns
 * true) unless a pre-removal deposit charge row exists. Marking one paid is
 * what makes `paidHoldingDepositCreditCents` credit it toward the security
 * deposit at approval, exactly like a deposit paid manually pre-PR139.
 */
export function markHoldingDepositPaidAfterStripe(residentEmail: string, propertyId: string, residentUserId: string | null): boolean {
  const charge = findHoldingDepositCharge(residentEmail, propertyId, residentUserId);
  if (!charge) return true;
  if (charge.status === "paid") return true;
  const rows = readAll();
  const i = rows.findIndex((r) => r.id === charge.id);
  if (i === -1) return false;
  const now = new Date().toISOString();
  const next = [...rows];
  next[i] = { ...next[i]!, status: "paid", paidAt: now, balanceLabel: "$0.00" };
  writeAll(next);
  return true;
}

/**
 * Called when an applicant completes the rental wizard (step 12).
 * Creates/tracks the application fee only. Lease/payment lines are created once the application is approved.
 */
export function recordApplicationCharges(
  input: {
    residentEmail: string;
    residentName: string;
    residentUserId: string | null;
    propertyId: string;
    applicationId?: string | null;
    managerUserId?: string | null;
  },
  opts?: {
    skipApplicationFee?: boolean;
    /** Server-authoritative fee in dollars — see `ensurePendingApplicationFeeCharge.feeAmountOverride`. */
    applicationFeeAmount?: number | null;
  }
): void {
  const existingAppFee = findApplicationFeeCharge(
    input.residentEmail,
    input.propertyId,
    input.residentUserId,
  );

  const serverAmount =
    opts?.applicationFeeAmount != null && Number.isFinite(opts.applicationFeeAmount)
      ? opts.applicationFeeAmount
      : null;

  const prop = getPropertyById(input.propertyId);
  const sub = prop?.listingSubmission;
  if (!sub) {
    if (opts?.skipApplicationFee || existingAppFee) return;
    if (serverAmount != null) {
      // The server told us the effective fee — book exactly that (nothing for 0)
      // instead of the legacy $50 fallback.
      ensurePendingApplicationFeeCharge({ ...input, feeAmountOverride: serverAmount });
      return;
    }
    /* still record a generic application fee line using defaults */
    const fallback: HouseholdCharge = {
      id: input.residentEmail.trim() && input.propertyId.trim()
        ? applicationFeeFallbackChargeId(input.residentEmail.trim(), input.propertyId.trim())
        : `hc_app_${Date.now()}`,
      createdAt: new Date().toISOString(),
      residentEmail: input.residentEmail.trim(),
      residentName: input.residentName.trim(),
      residentUserId: input.residentUserId,
      propertyId: input.propertyId,
      propertyLabel: prop?.title ?? "Listing",
      managerUserId: input.managerUserId ?? prop?.managerUserId ?? null,
      kind: "application_fee",
      title: chargeTitle("application_fee"),
      amountLabel: "$50",
      balanceLabel: "$50.00",
      status: "pending",
      blocksLeaseUntilPaid: false,
    };
    writeAll([...readAll(), fallback]);
    return;
  }

  if (opts?.skipApplicationFee || existingAppFee) {
    return;
  }
  ensurePendingApplicationFeeCharge({ ...input, feeAmountOverride: serverAmount });
}

export function recordSubmittedApplicationFeeCharge(row: DemoApplicantRow, managerUserId: string | null): boolean {
  if (!isBrowser()) return false;
  if (row.manuallyAdded) return false;
  const residentEmail = row.email?.trim();
  if (!residentEmail || !residentEmail.includes("@")) return false;
  const pidAssigned = row.assignedPropertyId?.trim() || "";
  const pidRow = row.propertyId?.trim() || "";
  const pidApp = row.application?.propertyId?.trim() || "";
  const ordered = [pidAssigned, pidRow, pidApp].filter(Boolean);
  const uniquePids = [...new Set(ordered)];
  const propertyId = uniquePids[0] || "";
  const propertyIdAliases = uniquePids.slice(1);
  if (!propertyId) return false;
  const beforeIds = new Set(readAll().map((charge) => charge.id));
  const charge = ensurePendingApplicationFeeCharge({
    residentEmail,
    residentName: row.name || row.application?.fullLegalName || "Applicant",
    residentUserId: null,
    propertyId,
    applicationId: row.id,
    managerUserId: managerUserId ?? row.managerUserId ?? null,
    propertyIdAliases,
  });
  return Boolean(charge && !beforeIds.has(charge.id));
}

/** Genuinely-custom fee rows (the "+ Add custom fee" rows) — preset-backed rows bill through
 *  their own legacy fields and are excluded here. */
function genuinelyCustomFees(sub: ManagerListingSubmissionV1 | null | undefined): ManagerCustomFeeRow[] {
  return (sub?.customFees ?? []).filter((fee) => {
    const presetId = (fee as { presetId?: string }).presetId;
    return !presetId || presetId === "custom";
  });
}

/** Custom fees the manager set to bill once (frequency "one-time"). */
function oneTimeCustomFees(sub: ManagerListingSubmissionV1 | null | undefined): ManagerCustomFeeRow[] {
  return genuinelyCustomFees(sub).filter((fee) => fee.frequency === "one-time");
}

type ApprovedChargeDraft = {
  kind: HouseholdChargeKind;
  amount: number;
  title: string;
  dueDateLabel: string;
};

function patchPendingApprovedChargeAmount(applicationId: string, draft: ApprovedChargeDraft): boolean {
  if (!(draft.amount > 0)) return false;
  const aliasIds = new Set(approvedChargeIdAliases(applicationId, draft.kind));
  const rows = readAll();
  const idx = rows.findIndex(
    (charge) =>
      charge.status === "pending" &&
      charge.kind === draft.kind &&
      (aliasIds.has(charge.id) ||
        (charge.applicationId === applicationId && charge.kind === draft.kind)),
  );
  if (idx === -1) return false;
  const label = moneyAmountLabel(Number(draft.amount.toFixed(2)));
  const current = rows[idx]!;
  const canonicalId = approvedChargeId(applicationId, draft.kind);
  if (
    current.id === canonicalId &&
    current.amountLabel === label &&
    current.title === draft.title &&
    current.dueDateLabel === draft.dueDateLabel
  ) {
    return false;
  }
  const next = [...rows];
  next[idx] = {
    ...current,
    id: canonicalId,
    applicationId,
    amountLabel: label,
    balanceLabel: label,
    title: draft.title,
    dueDateLabel: draft.dueDateLabel,
  };
  writeAll(next);
  return true;
}

function buildApprovedStandardChargeDrafts(
  row: DemoApplicantRow,
  sub: ReturnType<typeof normalizeManagerListingSubmissionV1>,
  opts: {
    allowListingDefaults: boolean;
    applicationId: string;
    leaseStart?: string;
    leaseEnd?: string;
    moveInDue: string;
  },
): ApprovedChargeDraft[] {
  const savedAmount = (raw: string | undefined, fallback: string | undefined): number => {
    const value = raw?.trim();
    if (value != null && value !== "") return parseMoneyAmount(value);
    return parseMoneyAmount(fallback ?? "");
  };
  const drafts: ApprovedChargeDraft[] = [];
  const pushDraft = (kind: HouseholdChargeKind, amount: number, title: string, dueDateLabel = opts.moveInDue) => {
    if (!(amount > 0)) return;
    const split = applyBundleGroupSplit(amount, title, resolveBundleGroupChargeContext(row));
    if (!(split.amount > 0)) return;
    drafts.push({
      kind,
      amount: Number(split.amount.toFixed(2)),
      title: split.title,
      dueDateLabel,
    });
  };

  // Resolved through resolveRowSubmissionRoom, NOT roomForRow with a hand-picked label.
  // `selectedRoomRentAmount` and `selectedRoomUtilities` below go through that same
  // function, and it passes the PROPERTY's unitLabel. Passing anything else here made this
  // one function price rent off one room and prorate off another.
  const room = resolveRowSubmissionRoom(row).room;
  const entireHome = isEntireHomeListing(sub);
  const prorateMethod =
    entireHome && sub.entireHomeProrateMethod === "daily_rate"
      ? "daily_rate"
      : room?.prorateMethod === "daily_rate"
        ? "daily_rate"
        : "auto";
  const dailyRentRate = entireHome ? sub.entireHomeDailyRentRate : room?.dailyRentRate;
  const dailyUtilitiesRate = entireHome ? sub.entireHomeDailyUtilitiesRate : room?.dailyUtilitiesRate;
  const dailyBasisRate =
    residentNegotiatedMonthlyRent(row) > 0 ? undefined : roomDailyRentPrice(room);
  const endsInsideFirstMonth =
    (dailyBasisRate ?? 0) > 0 && intraMonthStaySpan(opts.leaseStart, opts.leaseEnd) !== null;

  const rentAmount = selectedRoomRentAmount(row);
  if (rentAmount > 0 || (dailyBasisRate && dailyBasisRate > 0)) {
    const rentCharge = firstMonthRentChargeForLeaseStart(
      rentAmount,
      opts.leaseStart,
      prorateMethod,
      dailyRentRate,
      dailyBasisRate,
      opts.leaseEnd,
    );
    if (rentCharge) pushDraft(rentCharge.kind, rentCharge.amount, rentCharge.title);
  }

  const utilities = selectedRoomUtilities(row);
  if (utilities.amount > 0) {
    const proration = leaseFirstPeriodProration(opts.leaseStart, opts.leaseEnd, endsInsideFirstMonth);
    let utilAmount: number;
    let utilTitle: string;
    if (proration.prorated && prorateMethod === "daily_rate" && dailyUtilitiesRate && dailyUtilitiesRate > 0) {
      utilAmount = Number((proration.billableDays * dailyUtilitiesRate).toFixed(2));
      utilTitle = `Prorated utilities (${proration.billableDays} days × ${formatRoomPriceAmount(dailyUtilitiesRate)}/day)`;
    } else {
      utilAmount = proration.prorated ? utilities.amount * proration.factor : utilities.amount;
      utilTitle = proration.prorated ? `Prorated utilities (${proration.label})` : "Utilities";
    }
    pushDraft(
      proration.prorated ? "prorated_utilities" : "utilities",
      utilAmount,
      utilTitle,
    );
  }

  const lastMonthRentCharge =
    !endsInsideFirstMonth && (rentAmount > 0 || (dailyBasisRate && dailyBasisRate > 0))
      ? lastMonthChargeForLeaseEnd(rentAmount, opts.leaseEnd, "rent", prorateMethod, dailyRentRate, dailyBasisRate)
      : null;
  if (lastMonthRentCharge) {
    pushDraft(
      lastMonthRentCharge.kind,
      lastMonthRentCharge.amount,
      lastMonthRentCharge.title,
      lastMonthRentCharge.dueDateLabel ?? opts.moveInDue,
    );
  }

  const lastMonthUtilitiesCharge =
    !endsInsideFirstMonth && utilities.amount > 0
      ? lastMonthChargeForLeaseEnd(utilities.amount, opts.leaseEnd, "utilities", prorateMethod, dailyUtilitiesRate)
      : null;
  if (lastMonthUtilitiesCharge) {
    pushDraft(
      lastMonthUtilitiesCharge.kind,
      lastMonthUtilitiesCharge.amount,
      lastMonthUtilitiesCharge.title,
      lastMonthUtilitiesCharge.dueDateLabel ?? opts.moveInDue,
    );
  }

  // Room-first precedence, identical to recordApprovedApplicationCharges: a room's own
  // deposit wins over the shared listing amount, so a live re-sync never patches a per-room
  // deposit charge back down to the listing value. The two layers must not disagree.
  const roomSecurityDeposit = room?.securityDeposit?.trim() ? room.securityDeposit : undefined;
  const securityDeposit = savedAmount(
    row.application?.managerSecurityDepositOverride,
    row.manualResidentDetails?.securityDeposit != null
      ? String(row.manualResidentDetails.securityDeposit)
      : opts.allowListingDefaults
        ? (roomSecurityDeposit ??
          String(listingPresetFeeAmount(sub, "security_deposit") || parseMoneyAmount(sub.securityDeposit ?? "")))
        : undefined,
  );
  const holdingCredit = paidHoldingDepositCreditCents(opts.applicationId) / 100;
  const netSecurityDeposit = Math.max(0, securityDeposit - holdingCredit);
  const securityTitle =
    holdingCredit > 0 && netSecurityDeposit > 0
      ? `${chargeTitle("security_deposit")} ($${holdingCredit.toFixed(2)} holding deposit credited)`
      : holdingCredit > 0 && netSecurityDeposit <= 0
        ? `${chargeTitle("security_deposit")} (fully covered by holding deposit)`
        : chargeTitle("security_deposit");
  if (netSecurityDeposit > 0) {
    pushDraft(
      "security_deposit",
      netSecurityDeposit,
      securityTitle,
      row.manuallyAdded ? opts.moveInDue : "Before lease signing",
    );
  }

  const roomMoveInFee = room?.moveInFee?.trim() ? room.moveInFee : undefined;
  const moveInFee = savedAmount(
    row.application?.managerMoveInFeeOverride,
    row.manualResidentDetails?.moveInFee != null
      ? String(row.manualResidentDetails.moveInFee)
      : opts.allowListingDefaults
        ? (roomMoveInFee ??
          String(listingPresetFeeAmount(sub, "move_in_fee") || parseMoneyAmount(sub.moveInFee ?? "")))
        : undefined,
  );
  pushDraft("move_in_fee", moveInFee, chargeTitle("move_in_fee"));

  const otherCostAmount = parseMoneyAmount(row.application?.managerOtherCostAmount ?? "");
  if (otherCostAmount > 0) {
    const otherCostTitle = row.application?.managerOtherCostLabel?.trim() || chargeTitle("other_cost");
    pushDraft("other_cost", otherCostAmount, otherCostTitle);
  }

  return drafts;
}

function syncPendingApprovedChargesFromListing(
  row: DemoApplicantRow,
  applicationId: string,
  sub: ReturnType<typeof normalizeManagerListingSubmissionV1>,
  allowListingDefaults: boolean,
  leaseStart: string | undefined,
  leaseEnd: string | undefined,
  moveInDue: string,
): boolean {
  const drafts =
    row.application?.rentalType === "short_term"
      ? (() => {
          const savedAmount = (raw: string | undefined, fallback: string | undefined): number => {
            const value = raw?.trim();
            if (value != null && value !== "") return parseMoneyAmount(value);
            return parseMoneyAmount(fallback ?? "");
          };
          const out: ApprovedChargeDraft[] = [];
          // Same room-first resolution the CREATION branch and the lease document use. This
          // path patches the amounts of an already-created pending charge on every Payments
          // mount, so reading listing-level fields here quietly rewrote a room-priced stay
          // back down to the listing's nightly rate minutes after it was billed correctly.
          const stayRoom = resolveRowSubmissionRoom(row).room;
          const nightlyRate =
            resolveStayPricing({
              room: stayRoom,
              submission: sub,
              application: {
                rentalType: row.application?.rentalType,
                leaseStart,
                leaseEnd,
                managerRentOverride: row.application?.managerRentOverride,
                managerSecurityDepositOverride: row.application?.managerSecurityDepositOverride,
                signedMonthlyRent: row.signedMonthlyRent,
              },
            }).dailyRate ?? 0;
          const nights = shortTermStayNightCount(leaseStart, leaseEnd);
          if (nightlyRate > 0 && nights) {
            out.push({
              kind: "stay_total",
              amount: shortTermStayTotalAmount(nightlyRate, nights),
              title: shortTermStayChargeTitle(nights, nightlyRate),
              dueDateLabel: "Before check-in",
            });
          }
          const shortDeposit = savedAmount(
            row.application?.managerSecurityDepositOverride,
            row.manualResidentDetails?.securityDeposit != null
              ? String(row.manualResidentDetails.securityDeposit)
              : allowListingDefaults
                ? (stayRoom?.shortTermDeposit ?? "").trim() ||
                  String(
                    listingPresetFeeAmount(sub, "short_term_deposit") || parseMoneyAmount(sub.shortTermDeposit ?? ""),
                  )
                : undefined,
          );
          if (shortDeposit > 0) {
            out.push({
              kind: "security_deposit",
              amount: shortDeposit,
              title: chargeTitle("security_deposit"),
              dueDateLabel: "Before check-in",
            });
          }
          const shortMoveIn = savedAmount(
            row.application?.managerMoveInFeeOverride,
            row.manualResidentDetails?.moveInFee != null
              ? String(row.manualResidentDetails.moveInFee)
              : allowListingDefaults
                ? (stayRoom?.shortTermMoveInFee ?? "").trim() ||
                  String(
                    listingPresetFeeAmount(sub, "short_term_move_in") || parseMoneyAmount(sub.shortTermMoveInFee ?? ""),
                  )
                : undefined,
          );
          if (shortMoveIn > 0) {
            out.push({
              kind: "move_in_fee",
              amount: shortMoveIn,
              title: chargeTitle("move_in_fee"),
              dueDateLabel: "Before check-in",
            });
          }
          const otherCostAmount = parseMoneyAmount(row.application?.managerOtherCostAmount ?? "");
          if (otherCostAmount > 0) {
            out.push({
              kind: "other_cost",
              amount: otherCostAmount,
              title: row.application?.managerOtherCostLabel?.trim() || chargeTitle("other_cost"),
              dueDateLabel: "Before check-in",
            });
          }
          return out;
        })()
      : buildApprovedStandardChargeDrafts(row, sub, {
          allowListingDefaults,
          applicationId,
          leaseStart,
          leaseEnd,
          moveInDue,
        });

  let changed = false;
  for (const draft of drafts) {
    if (patchPendingApprovedChargeAmount(applicationId, draft)) changed = true;
  }
  return changed;
}

/** Monthly custom fees (default cadence) resolved to a stable {id,label,amount} for the
 *  recurring rent profile — only positive amounts bill. */
function monthlyCustomFees(sub: ManagerListingSubmissionV1 | null | undefined): { id: string; label: string; amount: number }[] {
  return genuinelyCustomFees(sub)
    .filter((fee) => fee.frequency !== "one-time")
    .map((fee) => ({ id: fee.id, label: fee.label?.trim() || "Custom fee", amount: parseMoneyAmount(fee.amount ?? "") }))
    .filter((fee) => fee.amount > 0);
}

export function recordApprovedApplicationCharges(row: DemoApplicantRow, managerUserId: string | null, force = false): boolean {
  if (!isBrowser()) return false;
  const residentEmail = row.email?.trim();
  if (!residentEmail || !residentEmail.includes("@")) return false;
  const applicationId = row.id.trim();
  if (!applicationId) return false;
  const propertyId = row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
  if (!propertyId) return false;

  const prop = getPropertyById(propertyId);
  const sub =
    prop?.listingSubmission?.v === 1
      ? normalizeManagerListingSubmissionV1(prop.listingSubmission as ManagerListingSubmissionV1)
      : null;

  // The resident's browser doesn't have the manager's listing catalog, so getPropertyById()
  // returns null there. Without the listing we can't determine proration method or daily rates,
  // and any charges we'd generate would use the wrong "auto" (fractional) method. Always bail
  // out here and let the server-synced amounts — computed correctly in the manager's browser
  // where the listing IS available — be the sole source of truth.
  if (!prop) return false;

  const allowListingDefaults = !row.manuallyAdded;
  const residentName = row.name?.trim() || row.application?.fullLegalName?.trim() || "Resident";
  const propertyLabel = prop?.title ?? row.property ?? "Listing";
  const effectiveManagerUserId = managerUserId ?? row.managerUserId ?? prop?.managerUserId ?? null;
  const zelleSnap = sub?.zellePaymentsEnabled && sub.zelleContact?.trim() ? sub.zelleContact.trim() : undefined;
  const venmoSnap = sub?.venmoPaymentsEnabled && sub.venmoContact?.trim() ? sub.venmoContact.trim() : undefined;
  const { leaseStart, leaseEnd } = resolveLeaseDatesForBilling(row);
  const moveInDue = dueLabelForLeaseStart(leaseStart);
  const savedAmount = (raw: string | undefined, fallback: string | undefined): number => {
    const value = raw?.trim();
    if (value != null && value !== "") return parseMoneyAmount(value);
    return parseMoneyAmount(fallback ?? "");
  };
  const before = readAll();
  if (!row.manuallyAdded) {
    recordSubmittedApplicationFeeCharge(row, effectiveManagerUserId);
  }
  // When not forced, skip wipe+regeneration if pending charges already exist for this resident.
  // This preserves manager-edited amounts and prevents auto-reconcile from overwriting manual changes.
  // Pass force=true (via the "Regenerate" button) to refresh from current listing terms.
  const emailLowerForFilter = residentEmail.trim().toLowerCase();
  if (!force) {
    let synced = false;
    if (sub) {
      synced = syncPendingApprovedChargesFromListing(
        row,
        applicationId,
        sub,
        allowListingDefaults,
        leaseStart,
        leaseEnd,
        moveInDue,
      );
    }
    const hasExisting = readAll().some(
      (c) =>
        (c.applicationId === applicationId && c.kind !== "application_fee" && c.status === "pending") ||
        ((c.kind === "rent" || c.kind === "utilities") &&
          c.status === "pending" &&
          c.residentEmail.trim().toLowerCase() === emailLowerForFilter &&
          c.propertyId === propertyId),
    );
    if (hasExisting) {
      if (!sub) return synced;
      if (row.application?.rentalType === "short_term") return synced;
      const drafts = buildApprovedStandardChargeDrafts(row, sub, {
        allowListingDefaults,
        applicationId,
        leaseStart,
        leaseEnd,
        moveInDue,
      });
      const pendingForApp = readAll().filter(
        (c) => c.applicationId === applicationId && c.status === "pending" && c.kind !== "application_fee",
      );
      const expectedKinds = new Set(drafts.map((draft) => draft.kind));
      const staleKind = pendingForApp.some((charge) => !expectedKinds.has(charge.kind));
      const draftMismatch = drafts.some((draft) => {
        if (!(draft.amount > 0)) return false;
        const aliasIds = new Set(approvedChargeIdAliases(applicationId, draft.kind));
        const match = pendingForApp.find(
          (charge) =>
            charge.kind === draft.kind &&
            (aliasIds.has(charge.id) || charge.applicationId === applicationId),
        );
        if (!match) return true;
        const label = moneyAmountLabel(Number(draft.amount.toFixed(2)));
        return match.amountLabel !== label || match.title !== draft.title;
      });
      if (!staleKind && !draftMismatch) return synced;
    }
  }
  // Preserve paid charges — only wipe pending ones so they can be regenerated with correct amounts.
  // Also wipe pending recurring rent/utilities for this resident+property so updated amounts are used.
  const rows = readAll().filter((charge) => {
    if (charge.applicationId === applicationId && charge.kind !== "application_fee" && charge.status === "pending") return false;
    if (
      (charge.kind === "rent" || charge.kind === "utilities") &&
      charge.status === "pending" &&
      charge.residentEmail.trim().toLowerCase() === emailLowerForFilter &&
      charge.propertyId === propertyId
    ) return false;
    return true;
  });
  const existingKeys = new Set(rows.map((charge) => chargeBusinessKey(charge)));
  const created: HouseholdCharge[] = [];
  const bundleGroupCtx = resolveBundleGroupChargeContext(row);

  const pushCharge = (
    kind: HouseholdChargeKind,
    amount: number,
    title: string,
    blocksLeaseUntilPaid: boolean,
    dueDateLabel = moveInDue,
    customFeeId?: string,
  ) => {
    if (!(amount > 0)) return;
    const split = applyBundleGroupSplit(amount, title, bundleGroupCtx);
    const finalAmount = split.amount;
    if (!(finalAmount > 0)) return;
    const label = moneyAmountLabel(Number(finalAmount.toFixed(2)));
    const charge: HouseholdCharge = withPaymentReference({
      // A custom fee needs its OWN id per fee — approvedChargeId keys only on (app, kind),
      // so several custom fees would otherwise share one id and collapse to one row.
      id: customFeeId ? `${approvedChargeId(applicationId, kind)}_cf_${chargeKeyPart(customFeeId)}` : approvedChargeId(applicationId, kind),
      createdAt: new Date().toISOString(),
      applicationId,
      residentEmail,
      residentName,
      residentUserId: null,
      propertyId,
      propertyLabel,
      managerUserId: effectiveManagerUserId,
      kind,
      title: split.title,
      amountLabel: label,
      balanceLabel: label,
      status: "pending",
      zelleContactSnapshot: zelleSnap,
      venmoContactSnapshot: venmoSnap,
      blocksLeaseUntilPaid,
      dueDateLabel,
      ...(customFeeId ? { customFeeId } : {}),
      ...split.split,
    });
    const key = chargeBusinessKey(charge);
    if (existingKeys.has(key)) return;
    existingKeys.add(key);
    created.push(charge);
  };

  // Resolve room for proration through the SHARED chain the lease document also uses, so the
  // same application can never be priced off two different rooms. Uses the sub already
  // resolved above to avoid a second property lookup and to catch stale room IDs in
  // assignedRoomChoice.
  // Resolved BEFORE the short-term branch: that branch prices the stay from the room the
  // applicant selected, so it cannot be resolved after the branch returns.
  const room = sub ? roomForRow(sub, row, prop?.unitLabel) : selectedRoom(row);

  const isShortTermStay = row.application?.rentalType === "short_term";

  if (isShortTermStay) {
    // The room the applicant selected is the authority for the nightly rate: its own
    // short-term rate first (the per-rent-row short-term set), then its daily basis, then the
    // listing's shortTermDailyCost. That precedence lives in resolveStayPricing, the same
    // resolver the lease document reads, so the stay total charged here always matches the
    // figure the agreement states. A stay is still ALL-IN: this branch bills no utilities line.
    const nightlyRate =
      resolveStayPricing({
        room,
        submission: sub,
        application: {
          rentalType: row.application?.rentalType,
          leaseStart,
          leaseEnd,
          managerRentOverride: row.application?.managerRentOverride,
          managerSecurityDepositOverride: row.application?.managerSecurityDepositOverride,
          signedMonthlyRent: row.signedMonthlyRent,
        },
      }).dailyRate ?? 0;
    const nights = shortTermStayNightCount(leaseStart, leaseEnd);
    if (nightlyRate > 0 && nights) {
      pushCharge(
        "stay_total",
        shortTermStayTotalAmount(nightlyRate, nights),
        shortTermStayChargeTitle(nights, nightlyRate),
        true,
        "Before check-in",
      );
    }

    const shortDeposit = savedAmount(
      row.application?.managerSecurityDepositOverride,
      row.manualResidentDetails?.securityDeposit != null
        ? String(row.manualResidentDetails.securityDeposit)
        : allowListingDefaults
          ? // per-room short-term deposit wins; else the listing's short-term deposit (unified fee → legacy)
            (room?.shortTermDeposit ?? "").trim() ||
            (sub ? String(listingPresetFeeAmount(sub, "short_term_deposit") || parseMoneyAmount(sub.shortTermDeposit ?? "")) : "")
          : undefined,
    );
    if (shortDeposit > 0) {
      pushCharge("security_deposit", shortDeposit, chargeTitle("security_deposit"), true, "Before check-in");
    }

    const shortMoveIn = savedAmount(
      row.application?.managerMoveInFeeOverride,
      row.manualResidentDetails?.moveInFee != null
        ? String(row.manualResidentDetails.moveInFee)
        : allowListingDefaults
          ? // per-room short-term move-in wins; else the listing's short-term move-in
            (room?.shortTermMoveInFee ?? "").trim() ||
            (sub ? String(listingPresetFeeAmount(sub, "short_term_move_in") || parseMoneyAmount(sub.shortTermMoveInFee ?? "")) : "")
          : undefined,
    );
    pushCharge("move_in_fee", shortMoveIn, chargeTitle("move_in_fee"), false, "Before check-in");

    const otherCostAmount = parseMoneyAmount(row.application?.managerOtherCostAmount ?? "");
    if (otherCostAmount > 0) {
      const otherCostTitle = row.application?.managerOtherCostLabel?.trim() || chargeTitle("other_cost");
      pushCharge("other_cost", otherCostAmount, otherCostTitle, false, "Before check-in");
    }

    // Custom fees with a short-term amount bill ONCE before check-in, on top of the all-in
    // stay total (they are explicit manager-added charges, unlike utilities which fold into
    // the rate). A fee set only on the long-term side (no shortTermAmount) never bills here.
    if (allowListingDefaults) {
      for (const fee of genuinelyCustomFees(sub)) {
        const amt = parseMoneyAmount(fee.shortTermAmount ?? "");
        if (amt > 0)
          pushCharge("other_cost", amt, fee.label?.trim() || chargeTitle("other_cost"), false, "Before check-in", fee.id);
      }
    }

    const next = dedupeCharges([...rows, ...created]);
    const changed = chargesChanged(before, next);
    if (changed) writeAll(next);
    return changed;
  }

  // `room` is already resolved once above, through the shared chain the lease document uses.
  // Entire-home listings still take their whole-unit proration settings here.
  // A MISSING per-day utilities rate stays undefined and reads as zero on purpose — a
  // listing briefly folded (rent baked-in, no util rate) bills the same total, never a
  // double-charge; do NOT derive a utilities figure from the rate.
  const entireHome = Boolean(sub && isEntireHomeListing(sub));
  const prorateMethod =
    entireHome && sub?.entireHomeProrateMethod === "daily_rate"
      ? "daily_rate"
      : room?.prorateMethod === "daily_rate"
        ? "daily_rate"
        : "auto";
  const dailyRentRate = entireHome ? sub?.entireHomeDailyRentRate : room?.dailyRentRate;
  const dailyUtilitiesRate = entireHome ? sub?.entireHomeDailyUtilitiesRate : room?.dailyUtilitiesRate;
  // When the room is priced by the day, rent (not utilities) bills per-day every period —
  // unless this resident has their own negotiated monthly rent, which wins exactly as it
  // does over the room's listing monthly rent.
  const dailyBasisRate =
    residentNegotiatedMonthlyRent(row) > 0 ? undefined : roomDailyRentPrice(room);

  // A DAILY-priced lease that starts and ends in one calendar month is billed once, by the
  // first-period charges below; its last-month charges would re-bill the same days. Monthly
  // rooms are left on their legacy two-charge path so their billing is unchanged.
  const endsInsideFirstMonth =
    (dailyBasisRate ?? 0) > 0 && intraMonthStaySpan(leaseStart, leaseEnd) !== null;

  const rentAmount = selectedRoomRentAmount(row);
  if (rentAmount > 0 || (dailyBasisRate && dailyBasisRate > 0)) {
    const rentCharge = firstMonthRentChargeForLeaseStart(rentAmount, leaseStart, prorateMethod, dailyRentRate, dailyBasisRate, leaseEnd);
    if (rentCharge) pushCharge(rentCharge.kind, rentCharge.amount, rentCharge.title, true, moveInDue);
  }

  const utilities = selectedRoomUtilities(row);
  if (utilities.amount > 0) {
    const proration = leaseFirstPeriodProration(leaseStart, leaseEnd, endsInsideFirstMonth);
    if (proration.prorated && prorateMethod === "daily_rate") {
      // A daily-rate month bills utilities ONLY from the explicit per-day utilities rate.
      // A missing rate reads as ZERO (do NOT fall back to the monthly estimate): a folded
      // listing has utilities baked into its daily rent, so billing the estimate here would
      // double-charge. dev has no daily-rate listings, so this affects nothing today.
      if (dailyUtilitiesRate && dailyUtilitiesRate > 0) {
        pushCharge(
          "prorated_utilities",
          Number((proration.billableDays * dailyUtilitiesRate).toFixed(2)),
          `Prorated utilities (${proration.billableDays} days × ${formatRoomPriceAmount(dailyUtilitiesRate)}/day)`,
          false,
          moveInDue,
        );
      }
    } else {
      const utilAmount = proration.prorated ? utilities.amount * proration.factor : utilities.amount;
      const utilTitle = proration.prorated ? `Prorated utilities (${proration.label})` : "Utilities";
      pushCharge(proration.prorated ? "prorated_utilities" : "utilities", utilAmount, utilTitle, false, moveInDue);
    }
  }

  const lastMonthRentCharge = !endsInsideFirstMonth && (rentAmount > 0 || (dailyBasisRate && dailyBasisRate > 0))
    ? lastMonthChargeForLeaseEnd(rentAmount, leaseEnd, "rent", prorateMethod, dailyRentRate, dailyBasisRate)
    : null;
  if (lastMonthRentCharge) {
    pushCharge(
      lastMonthRentCharge.kind,
      lastMonthRentCharge.amount,
      lastMonthRentCharge.title,
      false,
      lastMonthRentCharge.dueDateLabel,
    );
  }
  // Last-month utilities: a daily-rate month bills per-day utilities ONLY when an explicit
  // per-day rate is set; a missing rate reads as zero (folded-listing case — no monthly
  // fallback, or a folded listing would double-charge). Auto proration bills the monthly
  // estimate as before.
  const dailyUtilInRange = prorateMethod !== "daily_rate" || Boolean(dailyUtilitiesRate && dailyUtilitiesRate > 0);
  const lastMonthUtilitiesCharge = !endsInsideFirstMonth && utilities.amount > 0 && dailyUtilInRange
    ? lastMonthChargeForLeaseEnd(utilities.amount, leaseEnd, "utilities", prorateMethod, dailyUtilitiesRate)
    : null;
  if (lastMonthUtilitiesCharge) {
    pushCharge(
      lastMonthUtilitiesCharge.kind,
      lastMonthUtilitiesCharge.amount,
      lastMonthUtilitiesCharge.title,
      false,
      lastMonthUtilitiesCharge.dueDateLabel,
    );
  }

  // Per-room deposit override: when the resolved room carries its own securityDeposit it
  // wins over the listing-level shared deposit — the same room-first precedence rent uses.
  // A room with no per-room deposit falls back to sub.securityDeposit, so listings that
  // never set one bill exactly as before. Manager override / manual detail still win above.
  const roomSecurityDeposit = room?.securityDeposit?.trim() ? room.securityDeposit : undefined;
  const securityDeposit = savedAmount(
    row.application?.managerSecurityDepositOverride,
    row.manualResidentDetails?.securityDeposit != null
      ? String(row.manualResidentDetails.securityDeposit)
      : allowListingDefaults && sub
        ? // per-room deposit wins; else the listing's deposit (unified fee row → legacy field)
          (roomSecurityDeposit ??
            String(listingPresetFeeAmount(sub, "security_deposit") || parseMoneyAmount(sub.securityDeposit ?? "")))
        : undefined,
  );
  const holdingCredit = paidHoldingDepositCreditCents(applicationId) / 100;
  const netSecurityDeposit = Math.max(0, securityDeposit - holdingCredit);
  const securityTitle =
    holdingCredit > 0 && netSecurityDeposit > 0
      ? `${chargeTitle("security_deposit")} ($${holdingCredit.toFixed(2)} holding deposit credited)`
      : holdingCredit > 0 && netSecurityDeposit <= 0
        ? `${chargeTitle("security_deposit")} (fully covered by holding deposit)`
        : chargeTitle("security_deposit");
  if (netSecurityDeposit > 0) {
    pushCharge(
      "security_deposit",
      netSecurityDeposit,
      securityTitle,
      !row.manuallyAdded,
      row.manuallyAdded ? moveInDue : "Before lease signing",
    );
  }

  // Per-room move-in fee wins over the shared listing move-in fee (same room-first
  // precedence as the deposit), so a room with its own move-in and a property with a
  // shared one never both bill for the same move-in.
  const roomMoveInFee = room?.moveInFee?.trim() ? room.moveInFee : undefined;
  const moveInFee = savedAmount(
    row.application?.managerMoveInFeeOverride,
    row.manualResidentDetails?.moveInFee != null
      ? String(row.manualResidentDetails.moveInFee)
      : allowListingDefaults && sub
        ? // per-room move-in wins; else the listing's move-in (unified fee row → legacy field)
          (roomMoveInFee ??
            String(listingPresetFeeAmount(sub, "move_in_fee") || parseMoneyAmount(sub.moveInFee ?? "")))
        : undefined,
  );
  pushCharge("move_in_fee", moveInFee, chargeTitle("move_in_fee"), false, "Before move-in");

  const otherCostAmount = parseMoneyAmount(row.application?.managerOtherCostAmount ?? "");
  if (otherCostAmount > 0) {
    const otherCostTitle = row.application?.managerOtherCostLabel?.trim() || chargeTitle("other_cost");
    pushCharge("other_cost", otherCostAmount, otherCostTitle, false, "Before move-in");
  }

  // One-time custom fees bill ONCE at move-in. Only genuinely-custom rows are billed here
  // (preset-backed rows bill through their own legacy fields); monthly custom fees bill
  // through the recurring profile below, not here.
  if (allowListingDefaults) {
    for (const fee of oneTimeCustomFees(sub)) {
      const amt = parseMoneyAmount(fee.amount ?? "");
      if (amt > 0)
        pushCharge("other_cost", amt, fee.label?.trim() || chargeTitle("other_cost"), false, "Before move-in", fee.id);
    }
  }

  const next = dedupeCharges([...rows, ...created]);
  const changed = chargesChanged(before, next);
  if (changed) writeAll(next);

  // Set up recurring monthly rent (+ utilities + monthly custom fees) starting the month
  // after move-in. The move-in month itself is covered by the upfront first-month/prorated
  // charges above; monthly custom fees begin with the first full recurring month (they are a
  // flat monthly service, not prorated, and are not charged for the partial move-in month).
  const monthlyFeeSet = monthlyCustomFees(sub);
  let computedStartMonth: string | undefined;
  if (leaseStart && (rentAmount > 0 || utilities.amount > 0 || (dailyBasisRate && dailyBasisRate > 0) || monthlyFeeSet.length > 0)) {
    const [leaseYearRaw, leaseMonthRaw] = leaseStart.split("-").map(Number);
    if (leaseYearRaw && leaseMonthRaw) {
      computedStartMonth = firstRecurringMonthAfterLeaseStart(leaseStart);
      const roomLabel =
        row.manualResidentDetails?.roomNumber?.trim() ||
        row.assignedRoomChoice?.trim() ||
        row.application?.roomChoice1?.trim() ||
        "Room";
      const dueDayMode = rentDueDayModeFromSubmission(sub);
      upsertRecurringRentProfile({
        residentEmail,
        residentName,
        propertyId,
        propertyLabel,
        roomLabel,
        managerUserId: effectiveManagerUserId,
        monthlyRent: rentAmount,
        // Always explicit: 0 when the room is monthly, so re-approving a room that was
        // switched daily -> monthly clears the old daily rate instead of inheriting it.
        dailyRentPrice: dailyBasisRate && dailyBasisRate > 0 ? dailyBasisRate : 0,
        monthlyUtilities: utilities.amount > 0 ? Number(utilities.amount.toFixed(2)) : 0,
        // Always explicit (even []) so removing every monthly fee clears the stored set on
        // re-approval rather than inheriting stale fees.
        monthlyFees: monthlyFeeSet,
        // Carry the bundle-group split onto the profile so the RECURRING months
        // divide the household total exactly as the move-in charges above do.
        // `monthlyRent`/`monthlyUtilities`/`monthlyFees` are stored full-value
        // (`selectedRoomRentAmount` returns the bundle total) and the generator
        // applies the split at bill time. Always explicit — a re-approval that
        // leaves the group clears a stale split rather than inheriting it,
        // matching how `dailyRentPrice` and `monthlyFees` behave here.
        bundleGroupId: bundleGroupCtx?.groupId,
        bundleId: bundleGroupCtx?.bundleId,
        splitMemberIndex: bundleGroupCtx?.memberIndex,
        splitMemberCount: bundleGroupCtx?.memberCount,
        dueDay: resolveRentDueDayForMonth(dueDayMode, computedStartMonth),
        dueDayMode,
        startMonth: computedStartMonth,
        leaseEnd,
        zelleContact: zelleSnap,
        venmoContact: venmoSnap,
      });
    }
  }

  // Delete pending full-month recurring rent/utilities charges for months before the first full month.
  // Those months are already covered by the prorated first-month charges created above.
  if (computedStartMonth) {
    const emailLower = residentEmail.trim().toLowerCase();
    const allNow = readAll();
    const staleIds = new Set(
      allNow
        .filter(
          (c) =>
            c.residentEmail.trim().toLowerCase() === emailLower &&
            c.propertyId === propertyId &&
            c.status === "pending" &&
            (c.kind === "rent" || c.kind === "utilities") &&
            c.rentMonth != null &&
            c.rentMonth < computedStartMonth!,
        )
        .map((c) => c.id),
    );
    if (staleIds.size > 0) writeAll(allNow.filter((c) => !staleIds.has(c.id)));
  }

  // Always re-sync recurring charges so wiped monthly entries are recreated with current amounts.
  syncAllRecurringRentCharges();

  return changed;
}

export function removeApprovedApplicationCharges(applicationId: string, managerUserId: string | null): boolean {
  if (!isBrowser()) return false;
  const appId = applicationId.trim();
  if (!appId) return false;
  const scope = managerUserId ?? HOUSEHOLD_CHARGE_DEMO_MANAGER_SCOPE;
  const rows = readAll();
  const next = rows.filter(
    (charge) => !(charge.applicationId === appId && charge.managerUserId === scope && charge.kind !== "application_fee"),
  );
  if (next.length === rows.length) return false;
  writeAll(next);
  return true;
}

export function removeAllApplicationCharges(applicationId: string, managerUserId: string | null): boolean {
  if (!isBrowser()) return false;
  const appId = applicationId.trim();
  if (!appId) return false;
  const scope = managerUserId ?? HOUSEHOLD_CHARGE_DEMO_MANAGER_SCOPE;
  const rows = readAll();
  const next = rows.filter((charge) => !(charge.applicationId === appId && charge.managerUserId === scope));
  if (next.length === rows.length) return false;
  writeAll(next);
  return true;
}

export function removeResidentHouseholdPaymentData(residentEmail: string): boolean {
  if (!isBrowser()) return false;
  const email = residentEmail.trim().toLowerCase();
  if (!email) return false;

  const charges = readAll();
  const profiles = readRentProfiles();

  const nextCharges = charges.filter((charge) => charge.residentEmail.trim().toLowerCase() !== email);
  const nextProfiles = profiles.filter((profile) => profile.residentEmail.trim().toLowerCase() !== email);

  const chargesChanged = nextCharges.length !== charges.length;
  const profilesChanged = nextProfiles.length !== profiles.length;

  if (!chargesChanged && !profilesChanged) return false;

  if (chargesChanged) {
    writeAll(nextCharges, true);
  }
  if (profilesChanged) {
    writeRentProfiles(nextProfiles);
  }
  if (chargesChanged && !profilesChanged) {
    emit();
  }

  return true;
}

/**
 * Legacy helper kept for compatibility with older flows. New approval code calls
 * recordApprovedApplicationCharges instead.
 */
export function recordLegacyApplicationSigningCharges(
  input: {
    residentEmail: string;
    residentName: string;
    residentUserId: string | null;
    propertyId: string;
  },
  opts?: { skipApplicationFee?: boolean }
): void {
  const existingAppFee = findApplicationFeeCharge(
    input.residentEmail,
    input.propertyId,
    input.residentUserId
  );

  const prop = getPropertyById(input.propertyId);
  const sub = prop?.listingSubmission;
  if (!sub) return;
  const zelleSnap =
    sub.zellePaymentsEnabled && sub.zelleContact?.trim() ? sub.zelleContact.trim() : undefined;
  const created: HouseholdCharge[] = [];
  const idBase = `hc_${Date.now()}`;

  const pushLine = (kind: HouseholdChargeKind, blocksLease: boolean) => {
    if (kind === "application_fee") {
      if (opts?.skipApplicationFee) return;
      if (existingAppFee) return;
    }
    const raw = submissionAmount(sub, kind);
    const amt = parseMoneyAmount(raw);
    if (amt <= 0) return;
    const label = raw.trim() || `$${amt.toFixed(2)}`;
    created.push({
      id: `${idBase}_${kind}`,
      createdAt: new Date().toISOString(),
      residentEmail: input.residentEmail.trim(),
      residentName: input.residentName.trim(),
      residentUserId: input.residentUserId,
      propertyId: input.propertyId,
      propertyLabel: prop?.title ?? sub.buildingName,
      managerUserId: prop?.managerUserId ?? null,
      kind,
      title: chargeTitle(kind),
      amountLabel: label,
      balanceLabel: label.includes("$") ? label : `$${amt.toFixed(2)}`,
      status: "pending",
      zelleContactSnapshot: zelleSnap,
      blocksLeaseUntilPaid: blocksLease,
    });
  };

  pushLine("application_fee", false);
  pushLine("security_deposit", true);
  pushLine("move_in_fee", false);
  pushLine("payment_at_signing", true);

  if (created.length === 0) return;
  writeAll([...readAll(), ...created]);
}

/**
 * Manager-editable override of a charge's amount, title, and due date.
 * Only updates if the charge belongs to this manager and is still pending.
 */
export function updateHouseholdChargeAmount(
  chargeId: string,
  newAmount: number,
  managerUserId: string | null,
  newTitle?: string,
  newDueDateLabel?: string,
): boolean {
  if (!isBrowser() || !Number.isFinite(newAmount) || newAmount < 0) return false;
  const rows = readAll();
  const i = rows.findIndex((r) => r.id === chargeId && chargeVisibleToManager(r, managerUserId));
  if (i === -1) return false;
  const label = `$${newAmount.toFixed(2)}`;
  const next = [...rows];
  const updated: HouseholdCharge = {
    ...next[i]!,
    amountLabel: label,
    balanceLabel: next[i]!.status === "paid" ? "$0.00" : label,
    ...(newTitle?.trim() ? { title: newTitle.trim() } : {}),
    ...(newDueDateLabel?.trim() ? { dueDateLabel: newDueDateLabel.trim() } : {}),
  };
  next[i] = updated;
  writeAll(next);
  void postHouseholdPayloadAwait({
    action: "replace",
    charges: [updated],
    rentProfiles: readRentProfiles(),
  }).then((ok) => {
    if (ok) emit();
  });
  return true;
}

/**
 * Computes the upgrade charges when a resident converts from short-term to long-term.
 * Returns a breakdown of what is owed — callers display this; use recordShortToLongTermConversionCharges to persist.
 */
export function shortToLongTermUpgradeBreakdown(
  propertyId: string,
  isMonthToMonth: boolean,
): {
  applicationFee: { amount: number; waived: boolean; label: string };
  moveInFee: { amount: number; delta: number; label: string };
  securityDeposit: { amount: number; delta: number; label: string };
  monthToMonthSurcharge: { amount: number; label: string };
  totalDue: number;
} | null {
  const prop = getPropertyById(propertyId);
  const sub = prop?.listingSubmission?.v === 1 ? normalizeManagerListingSubmissionV1(prop.listingSubmission) : null;
  if (!sub) return null;

  const appFeeAmount = parseMoneyAmount(sub.applicationFee);
  const longTermDeposit = parseMoneyAmount(sub.securityDeposit);
  const longTermMoveIn = parseMoneyAmount(sub.moveInFee);
  const shortTermDeposit = parseMoneyAmount(sub.shortTermDeposit ?? "");
  const shortTermMoveIn = parseMoneyAmount(sub.shortTermMoveInFee ?? "");
  const mtmSurcharge = parseMoneyAmount(sub.monthToMonthSurcharge ?? "");

  const depositDelta = Math.max(0, longTermDeposit - shortTermDeposit);
  const moveInDelta = Math.max(0, longTermMoveIn - shortTermMoveIn);
  const mtm = isMonthToMonth ? mtmSurcharge : 0;

  const totalDue = depositDelta + moveInDelta + mtm;

  return {
    applicationFee: { amount: appFeeAmount, waived: true, label: appFeeAmount > 0 ? `$${appFeeAmount.toFixed(2)} (waived — already paid)` : "Waived" },
    moveInFee: { amount: longTermMoveIn, delta: moveInDelta, label: moveInDelta > 0 ? `$${moveInDelta.toFixed(2)} balance` : "Fully paid" },
    securityDeposit: { amount: longTermDeposit, delta: depositDelta, label: depositDelta > 0 ? `$${depositDelta.toFixed(2)} balance` : "Fully paid" },
    monthToMonthSurcharge: { amount: mtm, label: mtm > 0 ? `$${mtm.toFixed(2)}/mo added to rent` : "" },
    totalDue,
  };
}

/**
 * Creates the delta charges when a resident upgrades from short-term to long-term.
 * Marks application fee as waived. Only creates new delta lines — idempotent per applicationId.
 */
export function recordShortToLongTermConversionCharges(
  row: DemoApplicantRow,
  managerUserId: string | null,
  isMonthToMonth: boolean,
): boolean {
  if (!isBrowser()) return false;
  const residentEmail = row.email?.trim();
  if (!residentEmail || !residentEmail.includes("@")) return false;
  const applicationId = row.id.trim();
  if (!applicationId) return false;
  const propertyId = row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
  if (!propertyId) return false;

  const prop = getPropertyById(propertyId);
  const sub = prop?.listingSubmission?.v === 1 ? normalizeManagerListingSubmissionV1(prop.listingSubmission) : null;
  if (!sub) return false;

  const propertyLabel = prop?.title ?? row.property ?? "Listing";
  const zelleSnap = sub.zellePaymentsEnabled && sub.zelleContact?.trim() ? sub.zelleContact.trim() : undefined;
  const effectiveManagerUserId = managerUserId ?? row.managerUserId ?? prop?.managerUserId ?? null;
  const residentName = row.name?.trim() || row.application?.fullLegalName?.trim() || "Resident";

  const breakdown = shortToLongTermUpgradeBreakdown(propertyId, isMonthToMonth);
  if (!breakdown) return false;

  const rows = readAll();
  const created: HouseholdCharge[] = [];

  // Mark application fee paid/waived
  const appFeeId = applicationFeeChargeIdForApplication(applicationId);
  const appFeeIdx = rows.findIndex((r) => r.id === appFeeId || (r.kind === "application_fee" && r.applicationId === applicationId));
  if (appFeeIdx !== -1 && rows[appFeeIdx]!.status !== "paid") {
    rows[appFeeIdx] = { ...rows[appFeeIdx]!, status: "paid", paidAt: new Date().toISOString(), balanceLabel: "$0.00", title: "Application fee (waived — already paid short-term)" };
  }

  const makeId = (suffix: string) => `hc_upgrade_${chargeKeyPart(applicationId)}_${suffix}`;

  if (breakdown.moveInFee.delta > 0 && !rows.some((r) => r.id === makeId("movein"))) {
    const label = `$${breakdown.moveInFee.delta.toFixed(2)}`;
    created.push({
      id: makeId("movein"),
      createdAt: new Date().toISOString(),
      applicationId,
      residentEmail,
      residentName,
      residentUserId: null,
      propertyId,
      propertyLabel,
      managerUserId: effectiveManagerUserId,
      kind: "move_in_fee",
      title: `Move-in fee balance (upgrade to long-term)`,
      amountLabel: label,
      balanceLabel: label,
      status: "pending",
      zelleContactSnapshot: zelleSnap,
      blocksLeaseUntilPaid: true,
      dueDateLabel: "Before new lease signing",
    });
  }

  if (breakdown.securityDeposit.delta > 0 && !rows.some((r) => r.id === makeId("deposit"))) {
    const label = `$${breakdown.securityDeposit.delta.toFixed(2)}`;
    created.push({
      id: makeId("deposit"),
      createdAt: new Date().toISOString(),
      applicationId,
      residentEmail,
      residentName,
      residentUserId: null,
      propertyId,
      propertyLabel,
      managerUserId: effectiveManagerUserId,
      kind: "security_deposit",
      title: `Security deposit balance (upgrade to long-term)`,
      amountLabel: label,
      balanceLabel: label,
      status: "pending",
      zelleContactSnapshot: zelleSnap,
      blocksLeaseUntilPaid: true,
      dueDateLabel: "Before new lease signing",
    });
  }

  if (created.length === 0 && appFeeIdx === -1) return false;
  writeAll([...rows, ...created]);
  return true;
}

/** Reserved for seeding sample charges; does not inject data. */
export function seedDemoHouseholdChargesIfEmpty(_managerUserId: string): void {
  void _managerUserId;
  /* no-op */
}

/** Manager-created charge (fine, fee, custom) against a specific resident. */
export function createManagerCharge(input: {
  residentEmail: string;
  residentName: string;
  propertyId: string;
  propertyLabel: string;
  managerUserId: string | null;
  title: string;
  amount: number;
  applicationId?: string;
  blocksLeaseUntilPaid?: boolean;
  dueDateLabel?: string;
  initialStatus?: "pending" | "paid";
}): HouseholdCharge | null {
  const email = input.residentEmail.trim();
  if (!email || !Number.isFinite(input.amount) || input.amount <= 0) return null;
  if (!input.managerUserId?.trim() && !isDemoModeActive()) return null;
  const isPaid = input.initialStatus === "paid";
  const balance = `$${input.amount.toFixed(2)}`;
  const prop = getPropertyById(input.propertyId);
  const sub =
    prop?.listingSubmission?.v === 1 ? normalizeManagerListingSubmissionV1(prop.listingSubmission) : null;
  const paymentSnapshots = paymentSnapshotsFromListing(sub);
  const managerUserId = input.managerUserId?.trim() || HOUSEHOLD_CHARGE_DEMO_MANAGER_SCOPE;
  const charge = ensureChargeDueDateForReminders({
    id: `hc_mgr_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    applicationId: input.applicationId?.trim() || undefined,
    residentEmail: email,
    residentName: input.residentName.trim() || "Resident",
    residentUserId: null,
    propertyId: input.propertyId,
    propertyLabel: input.propertyLabel,
    managerUserId,
    kind: "other_cost",
    title: input.title.trim() || "Manager charge",
    amountLabel: balance,
    balanceLabel: isPaid ? "$0.00" : balance,
    status: isPaid ? "paid" : "pending",
    paidAt: isPaid ? new Date().toISOString() : undefined,
    dueDateLabel: input.dueDateLabel?.trim() || undefined,
    blocksLeaseUntilPaid: input.blocksLeaseUntilPaid ?? false,
    ...paymentSnapshots,
  });
  // Emit immediately so Pending updates even before the server upsert finishes.
  writeAll([...readAll(), charge], false);
  void postHouseholdPayloadAwait({
    action: "replace",
    charges: [charge],
    rentProfiles: readRentProfiles(),
  });
  return charge;
}

/**
 * Creates recurring rent profiles for approved residents who don't already have one.
 * Writes + emits only if at least one profile is new; otherwise returns false without side effects.
 * Safe to call on every render cycle — acts as a no-op once all profiles exist.
 */
export function autoSeedRecurringRentProfiles(
  residents: Array<{
    email: string;
    name: string;
    propertyId: string;
    propertyLabel: string | undefined;
    roomLabel: string | undefined;
    managerUserId: string | null;
    monthlyRent: number;
    dueDay?: number;
  }>,
): boolean {
  if (!isBrowser() || residents.length === 0) return false;
  const existing = readRentProfiles();
  const existingKeys = new Set(
    existing.filter((p) => p.active).map((p) => `${p.residentEmail.trim().toLowerCase()}|${p.propertyId}`),
  );

  const toAdd: RecurringRentProfile[] = [];
  for (const r of residents) {
    const email = r.email.trim().toLowerCase();
    if (!email || !Number.isFinite(r.monthlyRent) || r.monthlyRent <= 0) continue;
    const key = `${email}|${r.propertyId}`;
    if (existingKeys.has(key)) continue;
    toAdd.push({
      id: `rent_profile_${crypto.randomUUID()}`,
      residentEmail: r.email.trim(),
      residentName: r.name.trim() || "Resident",
      residentUserId: null,
      propertyId: r.propertyId,
      propertyLabel: (r.propertyLabel ?? "").trim() || "Property",
      roomLabel: (r.roomLabel ?? "").trim() || "Room",
      managerUserId: r.managerUserId,
      monthlyRent: Number(r.monthlyRent.toFixed(2)),
      dueDay: Math.min(28, Math.max(1, Math.round(r.dueDay ?? 1))),
      startMonth: currentRentMonth(),
      active: true,
      updatedAt: new Date().toISOString(),
    });
  }

  if (toAdd.length === 0) return false;
  writeRentProfiles([...existing, ...toAdd]);
  return true;
}

export function residentLeaseBlockedReasons(email: string, userId: string | null): string[] {
  void email;
  void userId;
  return [];
}

/**
 * The ONE Pending / Overdue / Paid decision for a manager-facing charge.
 *
 * Every manager surface that counts charges must go through this — the
 * dashboard "Payments" group used to bucket on `status === "pending"` alone,
 * which silently dropped clearing ACH ("processing") rows the Payments page
 * counts under Pending. Two money counters reading the same store disagreed.
 *
 * `ManagerPaymentBucket` has exactly three values, so every one of the seven
 * `HouseholdCharge` statuses has to land in one of them. The bucket answers
 * "is this money the manager still has to chase", so the split is:
 *
 *  - `paid`, `cancelled`, `refunded` → **paid**. Settled: nothing is owed.
 *    `cancelled` / `refunded` are not "paid" in the accounting sense, but they
 *    are not actionable either, and leaving them in Pending/Overdue would have
 *    the dashboard's "Needs attention → Payments" list dun a resident for money
 *    that was voided or already returned. The GL is the accounting record; this
 *    helper is only the collections view.
 *  - `processing` → **pending**, never overdue. The ACH debit is clearing
 *    (3–5 business days) — the resident has paid; the bank is settling.
 *  - `pending`, `partially_paid`, `failed` → **pending**, or **overdue** once
 *    past due. `failed` stays owed on purpose: the payment ATTEMPT failed, the
 *    charge did not go away.
 */
export function householdChargeManagerBucket(c: HouseholdCharge): ManagerPaymentBucket {
  if (c.status === "paid" || c.status === "cancelled" || c.status === "refunded") return "paid";
  const overdue = c.status !== "processing" && isHouseholdChargeOverdue(c, startOfTodayLocal());
  return overdue ? "overdue" : "pending";
}

function managerChargeStatusLabel(c: HouseholdCharge, bucket: ManagerPaymentBucket): string {
  if (c.status === "cancelled") return "Cancelled";
  if (c.status === "refunded") return "Refunded";
  if (bucket === "paid") return "Paid";
  return bucket === "overdue" ? "Overdue" : "Pending";
}

export function householdChargeToLedgerRow(c: HouseholdCharge): DemoManagerPaymentLedgerRow {
  const bucket = householdChargeManagerBucket(c);
  const settled = bucket === "paid";
  // If the stored label looks like a raw internal ID (pending property not yet resolved at charge-creation
  // time), try to resolve the human-readable title now via getPropertyById which now includes pending props.
  let propertyName = c.propertyLabel;
  if (/^(pend-|mgr-)/.test(propertyName)) {
    const resolved = getPropertyById(c.propertyId)?.title;
    if (resolved) propertyName = resolved;
  }
  return {
    id: c.id,
    householdChargeId: c.id,
    propertyId: c.propertyId,
    propertyName,
    roomNumber: "—",
    chargeKind: c.kind,
    residentName: c.residentName,
    residentEmail: c.residentEmail,
    chargeTitle: c.title,
    lineAmount: c.amountLabel,
    amountPaid: c.status === "paid" ? c.amountLabel : "$0.00",
    balanceDue: settled ? "$0.00" : c.balanceLabel,
    dueDate: chargeDueLabel(c),
    dueDateSortMs: householdChargeDueDate(c)?.getTime() ?? null,
    bucket,
    statusLabel: managerChargeStatusLabel(c, bucket),
    cancelledReminders: c.cancelledReminders,
    manualPaymentChannel: c.manualPaymentChannel,
    manualPaymentReportedAt: c.manualPaymentReportedAt,
    paymentReference: c.paymentReference ?? generatePaymentReference(c.id),
    zelleContactSnapshot: c.zelleContactSnapshot,
    venmoContactSnapshot: c.venmoContactSnapshot,
    residentChargeMessages: c.residentChargeMessages,
    notes:
      c.kind === "rent"
        ? `Recurring tenant rent. Current cycle: ${c.rentMonth ?? currentRentMonth()}. Due ${formatRecurringRentDueLabel(c.rentMonth ?? currentRentMonth(), c.dueDay ?? 1, c.dueDayMode)}.`
        : c.kind === "application_fee"
        ? c.status === "paid"
          ? "Application fee recorded as paid."
          : "Application fee pending — mark as paid after you receive the manual payment."
        : c.kind === "holding_deposit"
          ? c.status === "paid"
            ? "Holding deposit recorded as paid — credited toward security deposit on approval."
            : "Holding deposit pending — secures the application and credits toward security deposit when paid."
        : c.kind === "work_order_charge"
          ? "Work order pass-through — resident is billed this amount; mark as paid when you receive payment."
          : c.manualPaymentReportedAt && c.manualPaymentChannel
            ? `Resident reported ${c.manualPaymentChannel === "zelle" ? "Zelle" : "Venmo"} payment. Reference: ${c.paymentReference ?? generatePaymentReference(c.id)}.`
          : c.zelleContactSnapshot
            ? `Zelle contact on listing: ${c.zelleContactSnapshot}${c.paymentReference ? ` · Reference: ${c.paymentReference}` : ""}`
            : c.venmoContactSnapshot
              ? `Venmo contact on listing: ${c.venmoContactSnapshot}${c.paymentReference ? ` · Reference: ${c.paymentReference}` : ""}`
            : c.paymentReference
              ? `Payment reference: ${c.paymentReference}`
            : "Awaiting payment.",
  };
}

/**
 * Removes stale legacy application-fee rows that no longer map to a current application.
 * Current application fees are rebuilt as one canonical row per application by the Payments page.
 */
export function pruneObsoleteManagerCharges(
  managerUserId: string | null,
  applicationRows: DemoApplicantRow[],
): boolean {
  if (!isBrowser()) return false;
  const scope = managerUserId ?? HOUSEHOLD_CHARGE_DEMO_MANAGER_SCOPE;
  const rows = readAll();
  const activeApplicationIds = new Set(applicationRows.map((row) => row.id.trim()).filter(Boolean));
  const activeFallbackKeys = new Set(
    applicationRows.map((row) => {
      const email = row.email?.trim().toLowerCase() || "";
      const propertyId = row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
      return email && propertyId ? `${email}|${propertyId}` : "";
    }).filter(Boolean),
  );
  const obsolete = rows.filter((charge) => {
    if (charge.managerUserId !== scope || charge.kind !== "application_fee") return false;
    if (charge.applicationId?.trim()) return !activeApplicationIds.has(charge.applicationId.trim());
    const fallbackKey = `${charge.residentEmail.trim().toLowerCase()}|${charge.propertyId}`;
    return !activeFallbackKeys.has(fallbackKey);
  });
  if (obsolete.length === 0) return false;
  for (const charge of obsolete) {
    deleteChargeRowFromServer(charge.id);
  }
  writeAll(
    rows.filter((charge) => !(charge.managerUserId === scope && charge.kind === "application_fee" && charge.status === "paid")),
  );
  return true;
}
