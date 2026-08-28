import type { SupabaseClient } from "@supabase/supabase-js";

import { sanitizePaymentContactInput } from "@/lib/listing-form-inputs";
import { normalizeServiceFeeChoice, type ServiceFeePayer } from "@/lib/payment-policy";

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

export function normalizeManagerManualPaymentSettings(raw: unknown): ManagerManualPaymentSettings {
  const row = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const zelleContact = sanitizePaymentContactInput(String(row.zelleContact ?? "")).trim();
  const venmoContact = sanitizePaymentContactInput(String(row.venmoContact ?? "")).trim();
  // Allowed only when a contact is present — keep the contact when the method is
  // toggled off so re-enabling does not force the manager to re-link.
  const zellePaymentsEnabled = row.zellePaymentsEnabled === true && zelleContact.length > 0;
  const venmoPaymentsEnabled = row.venmoPaymentsEnabled === true && venmoContact.length > 0;
  const paymentInboxTokenRaw = String(row.paymentInboxToken ?? "").trim();
  const paymentInboxToken = /^[a-zA-Z0-9_-]{8,24}$/.test(paymentInboxTokenRaw) ? paymentInboxTokenRaw : undefined;
  return {
    axisPaymentsEnabled: row.axisPaymentsEnabled !== false,
    zellePaymentsEnabled,
    zelleContact,
    venmoPaymentsEnabled,
    venmoContact,
    ...(paymentInboxToken ? { paymentInboxToken } : {}),
    receiptAutoMarkEnabled: row.receiptAutoMarkEnabled === false ? false : true,
    serviceFeePayer: normalizeServiceFeeChoice(row.serviceFeePayer),
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

export async function saveManagerManualPaymentSettings(
  db: SupabaseClient,
  managerUserId: string,
  settings: ManagerManualPaymentSettings,
): Promise<ManagerManualPaymentSettings> {
  // The staff override is deliberately NOT taken from the caller: this function is what the
  // manager's own settings route writes through, so honouring an inbound value would let a
  // manager hand their processing fees to PropLane by adding one field to their save.
  const stored = await loadManagerManualPaymentSettings(db, managerUserId).catch(() => null);
  const normalized: ManagerManualPaymentSettings = normalizeManagerManualPaymentSettings(settings);
  // Drop whatever the caller supplied BEFORE restoring what is stored. Spreading the stored value
  // over the caller's is not enough: when staff have set nothing there is nothing to spread, and
  // the caller's own value would survive — which is precisely the hole this guards.
  delete normalized.adminServiceFeeOverride;
  if (stored?.adminServiceFeeOverride) normalized.adminServiceFeeOverride = stored.adminServiceFeeOverride;
  const mode = await resolveStorageMode(db);

  if (mode === "column") {
    const { error } = await db.from("manager_automation_settings").upsert(
      {
        manager_user_id: managerUserId,
        manual_payments: normalized,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "manager_user_id" },
    );
    if (error) throw error;
    return normalized;
  }

  const { data: existing } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  const rowData =
    existing?.row_data && typeof existing.row_data === "object" && !Array.isArray(existing.row_data)
      ? { ...(existing.row_data as Record<string, unknown>) }
      : {};
  rowData.manualPayments = normalized;
  const { error } = await db.from("manager_automation_settings").upsert(
    {
      manager_user_id: managerUserId,
      row_data: rowData,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "manager_user_id" },
  );
  if (error) throw error;
  return normalized;
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
  const current = await loadManagerManualPaymentSettings(db, managerUserId);
  const next: ManagerManualPaymentSettings = { ...current };
  if (override == null) delete next.adminServiceFeeOverride;
  else next.adminServiceFeeOverride = normalizeServiceFeeChoice(override);
  const mode = await resolveStorageMode(db);

  if (mode === "column") {
    const { error } = await db.from("manager_automation_settings").upsert(
      { manager_user_id: managerUserId, manual_payments: next, updated_at: new Date().toISOString() },
      { onConflict: "manager_user_id" },
    );
    if (error) throw error;
    return next;
  }

  const { data: existing } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  const rowData = (existing?.row_data && typeof existing.row_data === "object" ? existing.row_data : {}) as Record<
    string,
    unknown
  >;
  const { error } = await db.from("manager_automation_settings").upsert(
    {
      manager_user_id: managerUserId,
      row_data: { ...rowData, manualPayments: next },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "manager_user_id" },
  );
  if (error) throw error;
  return next;
}
