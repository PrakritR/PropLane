import type { SupabaseClient } from "@supabase/supabase-js";

import { sanitizePaymentContactInput } from "@/lib/listing-form-inputs";
import {
  listingPaymentWaiverCodeMatches,
  normalizeListingPaymentWaiverCode,
  normalizeServiceFeeChoice,
  type ServiceFeePayer,
} from "@/lib/payment-policy";

export type ManagerManualPaymentSettings = {
  /**
   * Allow residents/applicants to pay via Stripe ACH (bank). Defaults on —
   * managers turn it off from Payment setup when they only want Zelle/Venmo.
   */
  axisPaymentsEnabled: boolean;
  zellePaymentsEnabled: boolean;
  zelleContact: string;
  venmoPaymentsEnabled: boolean;
  venmoContact: string;
  /** Secret token for payments+<token>@ inbound receipt matching. */
  paymentInboxToken?: string;
  /** When false, receipt emails are ignored even if forwarded to the inbox. */
  receiptAutoMarkEnabled?: boolean;
  /**
   * Who pays the online payment service fee on resident charges. Consulted on
   * Pro and Business (Free forces resident) — see `resolveServiceFeePayer`.
   * Defaults to `resident` so upgrading to Pro never silently starts charging
   * the manager.
   */
  serviceFeePayer: ServiceFeePayer;
  /**
   * The promo code that unlocked `serviceFeePayer: "proplane"`.
   *
   * PropLane absorbing Stripe's cost is PropLane spending its own money, so a manager
   * turns it on by entering the code — the same rule the listing wizard already applies
   * per listing (`persistListingServiceFeePayer`). Stored so a later save carries the
   * grant with it instead of re-asking.
   */
  serviceFeeWaiverCode?: string;
  /**
   * PropLane staff's override of who pays the service fee for this manager — the only place
   * `proplane` (PropLane absorbing Stripe's cost, so neither party is charged) can be selected.
   *
   * Stored beside the manager's own settings but NOT owned by them: `saveManagerManualPaymentSettings`
   * always preserves the stored value and discards whatever the caller supplied, because that
   * function is reached from the manager's own settings route. Without that, a manager could stop
   * paying fees by including one field in their own save. Staff write it through
   * `saveAdminServiceFeeOverride`.
   */
  adminServiceFeeOverride?: ServiceFeePayer | null;
};

export type ManagerManualPaymentSettingsView = ManagerManualPaymentSettings & {
  paymentInboxAddress?: string;
};

export const DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS: ManagerManualPaymentSettings = {
  axisPaymentsEnabled: true,
  zellePaymentsEnabled: false,
  zelleContact: "",
  venmoPaymentsEnabled: false,
  venmoContact: "",
  receiptAutoMarkEnabled: true,
  serviceFeePayer: "resident",
};

export const MANAGER_MANUAL_PAYMENT_SETTINGS_EVENT = "axis:manager-manual-payment-settings";

/** Zelle enrollments are an email address or a phone number; do not accept a
 * handle-shaped value here because residents would be sent to an unverifiable
 * destination. Phone is deliberately the first/common path in the UI. */
export function isValidZelleContact(value: string): boolean {
  const contact = sanitizePaymentContactInput(value).trim();
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
  const phoneDigits = contact.replace(/\D/g, "");
  return email || (phoneDigits.length >= 10 && phoneDigits.length <= 15);
}

type ServiceFeeSelection = { serviceFeePayer: ServiceFeePayer; serviceFeeWaiverCode?: string };

/**
 * Which fee-payer a save is allowed to keep.
 *
 * Selecting `proplane` — PropLane, not the manager and not the resident, bearing Stripe's
 * cost — needs a promo grant, because it spends PropLane's own money: a valid typed code,
 * or a grant already on the account (`manager_purchases.promo_code`, or staff approval).
 * Two cases are deliberately different:
 *
 * - A NEW selection with no grant falls back to `resident`, exactly like
 *   {@link persistListingServiceFeePayer} does per listing.
 * - A save that merely CARRIES FORWARD an account already on `proplane` keeps it, so an
 *   unrelated save (toggling Stripe off, say) can never quietly move Stripe's cost back
 *   onto that manager's residents.
 */
export function resolveSavedServiceFeeSelection(
  incoming: ServiceFeeSelection,
  stored: ServiceFeeSelection | null,
  accountWaiverGranted = false,
): ServiceFeeSelection {
  if (incoming.serviceFeePayer !== "proplane") return { serviceFeePayer: incoming.serviceFeePayer };
  if (listingPaymentWaiverCodeMatches(incoming.serviceFeeWaiverCode)) {
    return {
      serviceFeePayer: "proplane",
      serviceFeeWaiverCode: normalizeListingPaymentWaiverCode(incoming.serviceFeeWaiverCode ?? ""),
    };
  }
  if (accountWaiverGranted) {
    return { serviceFeePayer: "proplane" };
  }
  if (stored?.serviceFeePayer === "proplane") {
    return {
      serviceFeePayer: "proplane",
      ...(stored.serviceFeeWaiverCode ? { serviceFeeWaiverCode: stored.serviceFeeWaiverCode } : {}),
    };
  }
  return { serviceFeePayer: "resident" };
}

export function normalizeManagerManualPaymentSettings(raw: unknown): ManagerManualPaymentSettings {
  const row = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const zelleContact = sanitizePaymentContactInput(String(row.zelleContact ?? "")).trim();
  const venmoContact = sanitizePaymentContactInput(String(row.venmoContact ?? "")).trim();
  const paymentInboxTokenRaw = String(row.paymentInboxToken ?? "").trim();
  const paymentInboxToken = /^[a-zA-Z0-9_-]{8,24}$/.test(paymentInboxTokenRaw) ? paymentInboxTokenRaw : undefined;
  return {
    axisPaymentsEnabled: row.axisPaymentsEnabled !== false,
    zellePaymentsEnabled: false,
    zelleContact: "",
    venmoPaymentsEnabled: false,
    venmoContact: "",
    ...(paymentInboxToken ? { paymentInboxToken } : {}),
    receiptAutoMarkEnabled: row.receiptAutoMarkEnabled === false ? false : true,
    serviceFeePayer: normalizeServiceFeeChoice(row.serviceFeePayer),
    // Kept only while it is actually a valid code; a garbage value is not evidence of a
    // grant. The payer itself is NOT downgraded here — this function is also the READ
    // path, and an account already absorbing fees must not silently flip who pays them.
    ...(listingPaymentWaiverCodeMatches(row.serviceFeeWaiverCode as string | null | undefined)
      ? { serviceFeeWaiverCode: normalizeListingPaymentWaiverCode(String(row.serviceFeeWaiverCode ?? "")) }
      : {}),
    // Absent means staff have not intervened, which is different from staff choosing `resident`.
    // The key is OMITTED rather than set to null in that case, so an untouched manager's settings
    // are byte-identical to what they were before this field existed.
    ...(row.adminServiceFeeOverride == null
      ? {}
      : { adminServiceFeeOverride: normalizeServiceFeeChoice(row.adminServiceFeeOverride) }),
  };
}

/** Browser-safe projection — same shape; contacts only when enabled. */
export function managerManualPaymentSettingsPublic(
  settings: ManagerManualPaymentSettings,
  extras?: Pick<ManagerManualPaymentSettingsView, "paymentInboxAddress">,
): ManagerManualPaymentSettingsView {
  return {
    ...normalizeManagerManualPaymentSettings(settings),
    ...(extras?.paymentInboxAddress ? { paymentInboxAddress: extras.paymentInboxAddress } : {}),
  };
}

type StorageMode = "column" | "row_data";

let cachedStorageMode: StorageMode | null = null;

function isMissingManualPaymentsColumnMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("manual_payments") && normalized.includes("does not exist");
}

async function resolveStorageMode(db: SupabaseClient): Promise<StorageMode> {
  if (cachedStorageMode) return cachedStorageMode;
  const { error } = await db.from("manager_automation_settings").select("manual_payments").limit(1);
  if (!error) {
    cachedStorageMode = "column";
    return cachedStorageMode;
  }
  if (isMissingManualPaymentsColumnMessage(error.message)) {
    cachedStorageMode = "row_data";
    return cachedStorageMode;
  }
  throw error;
}

export async function loadManagerManualPaymentSettings(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerManualPaymentSettings> {
  const mode = await resolveStorageMode(db);
  // A conditional select string is a union of literals the typed client's
  // parser rejects — branch so each `.select()` gets a single literal.
  if (mode === "column") {
    const { data, error } = await db
      .from("manager_automation_settings")
      .select("manual_payments, row_data")
      .eq("manager_user_id", managerUserId)
      .maybeSingle();
    if (error) throw error;
    return normalizeManagerManualPaymentSettings(data?.manual_payments);
  }
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error) throw error;
  return normalizeManagerManualPaymentSettings(
    (data?.row_data as Record<string, unknown> | null)?.manualPayments,
  );
}

/**
 * The manager's own settings save. The staff override is deliberately NOT taken from the
 * caller — this is what the manager's settings route writes through, so honouring an
 * inbound value would let a manager hand their processing fees to PropLane by adding one
 * field to their save; the `save_manager_payment_preferences` RPC restores the stored one.
 *
 * `opts.accountWaiverGranted` is the caller's server-side answer to "does a promo grant or
 * staff approval already back this account". Together with a valid typed code it decides
 * whether a `proplane` selection survives ({@link resolveSavedServiceFeeSelection}); the
 * same answer is handed to the RPC as `p_coverage_granted`, which otherwise downgrades a
 * `proplane` it cannot see a grant for.
 */
export async function saveManagerManualPaymentSettings(
  db: SupabaseClient,
  managerUserId: string,
  settings: ManagerManualPaymentSettings,
  opts?: { accountWaiverGranted?: boolean },
): Promise<ManagerManualPaymentSettings> {
  const stored = await loadManagerManualPaymentSettings(db, managerUserId).catch(() => null);
  const normalized = normalizeManagerManualPaymentSettings(settings);
  delete normalized.adminServiceFeeOverride;
  const accountWaiverGranted = opts?.accountWaiverGranted === true;
  // A failed read is not evidence of a new selection. Without the stored value a legacy
  // account already absorbing fees is indistinguishable from a code-less new choice, and
  // resolving to `resident` would silently move Stripe's cost onto that manager's residents
  // while the route answered 200. The caller's 500 is the honest answer.
  if (
    stored === null &&
    normalized.serviceFeePayer === "proplane" &&
    !listingPaymentWaiverCodeMatches(normalized.serviceFeeWaiverCode) &&
    !accountWaiverGranted
  ) {
    throw new Error("Could not read stored payment settings; refusing to change who pays the service fee.");
  }
  const feeSelection = resolveSavedServiceFeeSelection(normalized, stored, accountWaiverGranted);
  normalized.serviceFeePayer = feeSelection.serviceFeePayer;
  if (feeSelection.serviceFeeWaiverCode) normalized.serviceFeeWaiverCode = feeSelection.serviceFeeWaiverCode;
  else delete normalized.serviceFeeWaiverCode;
  const coverageGranted = feeSelection.serviceFeePayer === "proplane";
  const { data, error } = await db.rpc("save_manager_payment_preferences", {
    p_owner: managerUserId,
    p_settings: normalized,
    p_coverage_granted: coverageGranted,
  });
  if (error || !data) throw new Error("Could not save payment settings. Try again.");
  return normalizeManagerManualPaymentSettings(data);
}

/**
 * Set (or clear) PropLane staff's fee-payer override for one manager.
 *
 * Separate from `saveManagerManualPaymentSettings` on purpose — that one is reached from the
 * manager's own settings route and deliberately cannot write this field. Callers of THIS function
 * must have already authorized the caller as staff; it does no authorization of its own, exactly
 * like every other service-role writer here.
 *
 * Passing null clears the override, returning the manager to the plan-and-choice rule. That is
 * different from setting it to `resident`, which pins the answer regardless of what the manager
 * later chooses.
 */
export async function saveAdminServiceFeeOverride(
  db: SupabaseClient,
  managerUserId: string,
  override: ServiceFeePayer | null,
): Promise<ManagerManualPaymentSettings> {
  const { data, error } = await db.rpc("set_staff_payment_fee_override", { p_owner: managerUserId, p_override: override });
  if (error || !data) throw new Error("Could not save staff payment coverage. Try again.");
  return normalizeManagerManualPaymentSettings(data);
}
