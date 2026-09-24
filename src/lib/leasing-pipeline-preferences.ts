/**
 * Workspace / house leasing pipeline: application ↔ lease order, when each is
 * required, workspace default templates, and the optional lease signing fee.
 *
 * PLAN-0924-1254. Lives on `manager_automation_settings.row_data.leasingPipeline`
 * (portfolio) and `leasingPipelineByPropertyId` (house override), same
 * no-migration pattern as `applicationAutomation`.
 *
 * Decide defaults (captain "approved — build" without override):
 * - order scope: workspace default + optional house override
 * - listing application fee: ignored; Application system fee is the source of truth
 * - lease signing fee: each signer pays
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type PipelineOrder = "application_then_lease" | "lease_then_application";

export type LeasingPipelinePreferences = {
  pipelineOrder: PipelineOrder;
  requireApplication: boolean;
  requireLease: boolean;
  /** Cents; `0` = free (no Stripe gate). Null = not configured (treat as 0). */
  leaseSigningFeeCents: number | null;
  /** Workspace default application form template id (property template catalog). */
  defaultApplicationTemplateId: string | null;
  /** Workspace default lease template id. */
  defaultLeaseTemplateId: string | null;
};

export const DEFAULT_LEASING_PIPELINE: LeasingPipelinePreferences = {
  pipelineOrder: "application_then_lease",
  requireApplication: true,
  requireLease: true,
  leaseSigningFeeCents: null,
  defaultApplicationTemplateId: null,
  defaultLeaseTemplateId: null,
};

export const MIN_LEASE_SIGNING_FEE_CENTS = 100;
export const MAX_LEASE_SIGNING_FEE_CENTS = 100_000;

const ROW_DATA_KEY = "leasingPipeline";
const ROW_DATA_BY_PROPERTY_KEY = "leasingPipelineByPropertyId";

function normalizePipelineOrder(raw: unknown): PipelineOrder {
  return raw === "lease_then_application" ? "lease_then_application" : "application_then_lease";
}

function normalizeOptionalId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return id || null;
}

function normalizeLeaseSigningFeeCents(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const cents = Math.round(raw);
  if (cents === 0) return 0;
  if (cents < MIN_LEASE_SIGNING_FEE_CENTS) return null;
  if (cents > MAX_LEASE_SIGNING_FEE_CENTS) return MAX_LEASE_SIGNING_FEE_CENTS;
  return cents;
}

export function normalizeLeasingPipelinePreferences(raw: unknown): LeasingPipelinePreferences {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    pipelineOrder: normalizePipelineOrder(row.pipelineOrder),
    requireApplication: row.requireApplication === false ? false : true,
    requireLease: row.requireLease === false ? false : true,
    leaseSigningFeeCents: normalizeLeaseSigningFeeCents(row.leaseSigningFeeCents),
    defaultApplicationTemplateId: normalizeOptionalId(row.defaultApplicationTemplateId),
    defaultLeaseTemplateId: normalizeOptionalId(row.defaultLeaseTemplateId),
  };
}

export type LeaseSigningFeeValidation =
  | { ok: true; leaseSigningFeeCents: number | null }
  | { ok: false; error: string };

export function validateLeaseSigningFeeCents(raw: unknown): LeaseSigningFeeValidation {
  if (raw == null) return { ok: true, leaseSigningFeeCents: null };
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { ok: false, error: "Enter a valid lease signing fee." };
  }
  const cents = Math.round(raw);
  if (cents < 0) return { ok: false, error: "The lease signing fee cannot be negative." };
  if (cents === 0) return { ok: true, leaseSigningFeeCents: 0 };
  if (cents < MIN_LEASE_SIGNING_FEE_CENTS) {
    return { ok: false, error: "The lease signing fee must be at least $1 — or $0 for free signing." };
  }
  if (cents > MAX_LEASE_SIGNING_FEE_CENTS) {
    return { ok: false, error: "The lease signing fee cannot exceed $1,000." };
  }
  return { ok: true, leaseSigningFeeCents: cents };
}

export type LeasingPipelineState = {
  portfolio: LeasingPipelinePreferences;
  byPropertyId: Record<string, LeasingPipelinePreferences>;
};

export function normalizeLeasingPipelineByPropertyId(
  raw: unknown,
): Record<string, LeasingPipelinePreferences> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, LeasingPipelinePreferences> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = key.trim();
    if (!id) continue;
    out[id] = normalizeLeasingPipelinePreferences(value);
  }
  return out;
}

/** Property override wins; else workspace/portfolio default. */
export function resolveLeasingPipelineForProperty(
  state: LeasingPipelineState,
  propertyId: string | null | undefined,
): LeasingPipelinePreferences {
  const id = propertyId?.trim() ?? "";
  if (id && state.byPropertyId[id]) return state.byPropertyId[id];
  return state.portfolio;
}

/**
 * Effective signing fee in cents for a lease (0 = no Stripe gate).
 * Null stored → 0 (unset means free until the manager sets an amount).
 */
export function effectiveLeaseSigningFeeCents(prefs: LeasingPipelinePreferences): number {
  return prefs.leaseSigningFeeCents ?? 0;
}

/**
 * Whether the resident lease section unlocks without an approved application.
 * Lease-first workspaces unlock lease when a lease is required; application-first
 * keeps today's approve → lease unlock.
 */
export function leaseUnlocksWithoutApplicationApproval(prefs: LeasingPipelinePreferences): boolean {
  if (!prefs.requireLease) return false;
  return prefs.pipelineOrder === "lease_then_application";
}

/**
 * Whether send-for-signature still requires an approved linked application.
 * Lease-first (or application not required) skips that gate.
 */
export function leaseSendRequiresApprovedApplication(prefs: LeasingPipelinePreferences): boolean {
  if (!prefs.requireApplication) return false;
  return prefs.pipelineOrder === "application_then_lease";
}

async function readAutomationRowData(
  db: SupabaseClient,
  managerUserId: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error) throw error;
  const raw = data?.row_data;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {};
}

export async function loadLeasingPipelineState(
  db: SupabaseClient,
  managerUserId: string,
): Promise<LeasingPipelineState> {
  const rowData = await readAutomationRowData(db, managerUserId);
  return {
    portfolio: normalizeLeasingPipelinePreferences(rowData[ROW_DATA_KEY]),
    byPropertyId: normalizeLeasingPipelineByPropertyId(rowData[ROW_DATA_BY_PROPERTY_KEY]),
  };
}

export async function loadLeasingPipeline(
  db: SupabaseClient,
  managerUserId: string,
): Promise<LeasingPipelinePreferences> {
  const state = await loadLeasingPipelineState(db, managerUserId);
  return state.portfolio;
}

export async function saveLeasingPipeline(
  db: SupabaseClient,
  managerUserId: string,
  prefs: unknown,
): Promise<LeasingPipelinePreferences> {
  const normalized = normalizeLeasingPipelinePreferences(prefs);
  const rowData = await readAutomationRowData(db, managerUserId);
  rowData[ROW_DATA_KEY] = normalized;
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

export async function saveLeasingPipelineForProperty(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string,
  prefs: unknown,
): Promise<LeasingPipelinePreferences> {
  const id = propertyId.trim();
  if (!id) throw new Error("propertyId is required.");
  const normalized = normalizeLeasingPipelinePreferences(prefs);
  const rowData = await readAutomationRowData(db, managerUserId);
  const byPropertyId = normalizeLeasingPipelineByPropertyId(rowData[ROW_DATA_BY_PROPERTY_KEY]);
  byPropertyId[id] = normalized;
  rowData[ROW_DATA_BY_PROPERTY_KEY] = byPropertyId;
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

export async function clearLeasingPipelineForProperty(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string,
): Promise<void> {
  const id = propertyId.trim();
  if (!id) throw new Error("propertyId is required.");
  const rowData = await readAutomationRowData(db, managerUserId);
  const byPropertyId = normalizeLeasingPipelineByPropertyId(rowData[ROW_DATA_BY_PROPERTY_KEY]);
  delete byPropertyId[id];
  rowData[ROW_DATA_BY_PROPERTY_KEY] = byPropertyId;
  const { error } = await db.from("manager_automation_settings").upsert(
    {
      manager_user_id: managerUserId,
      row_data: rowData,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "manager_user_id" },
  );
  if (error) throw error;
}
