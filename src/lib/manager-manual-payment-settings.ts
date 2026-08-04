import type { SupabaseClient } from "@supabase/supabase-js";

import { sanitizePaymentContactInput } from "@/lib/listing-form-inputs";
import { normalizeProServiceFeeChoice, type ProServiceFeeChoice } from "@/lib/payment-policy";

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
   * The Pro manager's choice for who pays the online payment service fee on
   * resident charges. Only consulted on the Pro plan (Free forces resident,
   * Business forces PropLane) — see `resolveServiceFeePayer`. Defaults to
   * `resident` so upgrading to Pro never silently starts charging the manager.
   */
  serviceFeePayer: ProServiceFeeChoice;
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
    serviceFeePayer: normalizeProServiceFeeChoice(row.serviceFeePayer),
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
  const normalized = normalizeManagerManualPaymentSettings(settings);
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
