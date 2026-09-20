import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeServiceFeeChoice, type ServiceFeePayer } from "@/lib/payment-policy";

/**
 * Payment setup, answered once per workspace.
 *
 * The modal used to ask which PROPERTIES a processing-fee choice applied to, so
 * a manager could pick three of nine houses and leave the other six on whatever
 * they had, with nothing on screen saying so. The choice now belongs to the
 * workspace those houses are already grouped into.
 *
 * Scope, not a grant: every read here is keyed by `owner_user_id` as well as the
 * workspace id, so a workspace id from a request body can never reach another
 * account's settings. Authorization itself is unchanged and still lives in the
 * route.
 */
export type WorkspacePaymentSettings = {
  serviceFeePayer: ServiceFeePayer | null;
  serviceFeeWaiverCode?: string;
  /**
   * Whether residents on this workspace may enroll in autopay at all — the
   * gate `GET/PUT /api/resident/autopay` refuses against. `undefined`/absent
   * means the default, On.
   */
  autopayEnabled?: boolean;
  /**
   * Whether a declined autopay run may retry once, three days later. Absent
   * means the default, On (retry once).
   */
  autopayRetryEnabled?: boolean;
};

function readSettings(raw: unknown): WorkspacePaymentSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { serviceFeePayer: null };
  const record = raw as Record<string, unknown>;
  const payer = record.serviceFeePayer;
  const code = typeof record.serviceFeeWaiverCode === "string" ? record.serviceFeeWaiverCode.trim() : "";
  return {
    serviceFeePayer:
      payer === "resident" || payer === "manager" || payer === "proplane"
        ? normalizeServiceFeeChoice(payer)
        : null,
    serviceFeeWaiverCode: code || undefined,
    autopayEnabled: typeof record.autopayEnabled === "boolean" ? record.autopayEnabled : undefined,
    autopayRetryEnabled: typeof record.autopayRetryEnabled === "boolean" ? record.autopayRetryEnabled : undefined,
  };
}

/** Whether residents on this workspace's payment setup may enroll in autopay. Default On. */
export function workspaceAutopayEnabled(settings: WorkspacePaymentSettings): boolean {
  return settings.autopayEnabled !== false;
}

/** Whether a declined autopay run may retry once, three days later. Default On. */
export function workspaceAutopayRetryEnabled(settings: WorkspacePaymentSettings): boolean {
  return settings.autopayRetryEnabled !== false;
}

/** Every workspace this owner holds, with the payment setup each one carries. */
export async function loadWorkspacePaymentSettings(
  db: SupabaseClient,
  ownerUserId: string,
): Promise<Record<string, WorkspacePaymentSettings>> {
  const { data, error } = await db
    .from("portal_workspaces")
    .select("id,payment_settings")
    .eq("owner_user_id", ownerUserId);
  if (error) throw error;
  const out: Record<string, WorkspacePaymentSettings> = {};
  for (const row of data ?? []) out[String(row.id)] = readSettings(row.payment_settings);
  return out;
}

/**
 * The workspace a property belongs to, for the resolver's workspace rung.
 *
 * `manager_property_records.workspace_id` is filled for every record by a
 * database trigger, so this is a lookup rather than a guess.
 */
export async function loadWorkspaceIdForProperty(
  db: SupabaseClient,
  ownerUserId: string,
  propertyId: string,
): Promise<string | null> {
  const id = propertyId.trim();
  if (!id) return null;
  const { data, error } = await db
    .from("manager_property_records")
    .select("workspace_id")
    .eq("manager_user_id", ownerUserId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  const workspaceId = data?.workspace_id;
  return typeof workspaceId === "string" && workspaceId ? workspaceId : null;
}

/**
 * The payment setup that applies to one property through its workspace — the
 * choice AND the coverage code it was applied with.
 *
 * The code matters at checkout: PropLane pays is applied per workspace by a
 * code at the moment it is chosen (captain, 2026-09-14), so the workspace's
 * own code is one of the things that lets `proplane` actually be `proplane`,
 * next to the account grant and a listing's own code. Without it a workspace
 * answered by code on an account with no grant would quietly bill the resident.
 */
export async function loadWorkspacePaymentSettingsForProperty(
  db: SupabaseClient,
  ownerUserId: string,
  propertyId: string | null | undefined,
): Promise<WorkspacePaymentSettings> {
  if (!propertyId) return { serviceFeePayer: null };
  const workspaceId = await loadWorkspaceIdForProperty(db, ownerUserId, propertyId);
  if (!workspaceId) return { serviceFeePayer: null };
  const { data, error } = await db
    .from("portal_workspaces")
    .select("payment_settings")
    .eq("owner_user_id", ownerUserId)
    .eq("id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  return readSettings(data?.payment_settings);
}

/** The processing-fee choice that applies to one property through its workspace. */
export async function loadWorkspaceServiceFeePayerForProperty(
  db: SupabaseClient,
  ownerUserId: string,
  propertyId: string | null | undefined,
): Promise<ServiceFeePayer | null> {
  return (await loadWorkspacePaymentSettingsForProperty(db, ownerUserId, propertyId)).serviceFeePayer;
}

/**
 * Write one workspace's payment setup.
 *
 * Scoped by owner as well as id: a workspace id the caller does not own matches
 * no row and writes nothing, rather than raising and revealing that it exists.
 */
export async function saveWorkspacePaymentSettings(
  db: SupabaseClient,
  ownerUserId: string,
  workspaceId: string,
  /**
   * A partial patch, merged onto whatever the workspace already has —
   * `serviceFeePayer` omitted (vs. explicitly `null`) leaves the stored
   * choice untouched, which is what lets a caller save the autopay toggles
   * alone without accidentally clearing the fee-payer choice, and vice versa.
   */
  next: Partial<WorkspacePaymentSettings>,
): Promise<{ saved: boolean }> {
  const id = workspaceId.trim();
  if (!id) return { saved: false };
  // Read-modify-write: this function is called with a partial patch (only the
  // fields the caller is changing), so a fee-payer-only save must not blank
  // out the autopay toggles already on the row, and vice versa.
  const { data: existingRow, error: existingErr } = await db
    .from("portal_workspaces")
    .select("payment_settings")
    .eq("owner_user_id", ownerUserId)
    .eq("id", id)
    .maybeSingle();
  if (existingErr) throw existingErr;
  const existing = readSettings(existingRow?.payment_settings);
  const merged: WorkspacePaymentSettings = { ...existing, ...next };
  const payload =
    merged.serviceFeePayer === null &&
    merged.autopayEnabled === undefined &&
    merged.autopayRetryEnabled === undefined
      ? null
      : {
          ...(merged.serviceFeePayer ? { serviceFeePayer: merged.serviceFeePayer } : {}),
          ...(merged.serviceFeeWaiverCode ? { serviceFeeWaiverCode: merged.serviceFeeWaiverCode } : {}),
          ...(merged.autopayEnabled !== undefined ? { autopayEnabled: merged.autopayEnabled } : {}),
          ...(merged.autopayRetryEnabled !== undefined ? { autopayRetryEnabled: merged.autopayRetryEnabled } : {}),
        };
  const { data, error } = await db
    .from("portal_workspaces")
    .update({ payment_settings: payload })
    .eq("owner_user_id", ownerUserId)
    .eq("id", id)
    .select("id");
  if (error) throw error;
  return { saved: (data ?? []).length > 0 };
}
