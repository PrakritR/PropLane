/**
 * Workspace / house leasing pipeline: application ↔ lease order, when each is
 * required, workspace default templates, and the optional lease signing fee.
 *
 * PLAN-0924-1254. Lives on `manager_automation_settings.row_data.leasingPipeline`
 * (portfolio) and `leasingPipelineByPropertyId` (house override), same
 * no-migration pattern as `applicationAutomation`.
 *
 * Decide defaults (captain "approved — build" without override):
 * - order scope: WORKSPACE ONLY (C2-CP7, captain Oct 3). A house override may still carry the
 *   other fields (fee, default templates, requirements) but its `pipelineOrder` is ignored:
 *   `resolveLeasingPipelineForProperty` always answers with the workspace order.
 * - listing application fee: ignored; Application system fee is the source of truth
 * - lease signing fee: each signer pays
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * One signing order for every workspace (captain, Oct 3 2026): application first, then lease, then
 * the move-in form. `lease_then_application` stays in the union only so an old stored value still
 * parses; `normalizePipelineOrder` never returns it, so nothing downstream can be lease-first.
 */
export type PipelineOrder = "application_then_lease" | "lease_then_application";

/** Workspace setting: may a prospect book a tour before they have applied for that property? */
export type ApplicationBeforeTour = "not_needed" | "required";

/** Workspace default for a shared room's lease when the room itself says "Property default" (C2-CP8). */
export type SharedRoomLeaseDefault = "individual" | "joint";

export type LeasingPipelinePreferences = {
  /** Workspace-wide; one value for every property, application and lease (C2-CP7). Default application first. */
  pipelineOrder: PipelineOrder;
  /** Workspace-wide: do roommates in a shared room each sign their own lease, or one joint lease? */
  sharedRoomLease: SharedRoomLeaseDefault;
  /** Workspace-wide: "required" = a prospect applies for the property before they can book a tour of it. */
  applicationBeforeTour: ApplicationBeforeTour;
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
  sharedRoomLease: "individual",
  applicationBeforeTour: "not_needed",
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

/** Always application first: a stored `lease_then_application` is ignored (captain, Oct 3 2026). */
function normalizePipelineOrder(_raw: unknown): PipelineOrder {
  return "application_then_lease";
}

function normalizeApplicationBeforeTour(raw: unknown): ApplicationBeforeTour {
  return raw === "required" ? "required" : "not_needed";
}

function normalizeSharedRoomLease(raw: unknown): SharedRoomLeaseDefault {
  return raw === "joint" ? "joint" : "individual";
}

/**
 * The lease shape of a shared room: the room's own choice, else the workspace default.
 * "Property default" (or no choice) is the only value that reads the workspace setting.
 */
export function effectiveSharedRoomLeaseKind(
  roomKind: "property_default" | "individual" | "joint" | null | undefined,
  prefs: Pick<LeasingPipelinePreferences, "sharedRoomLease">,
): SharedRoomLeaseDefault {
  if (roomKind === "joint" || roomKind === "individual") return roomKind;
  return prefs.sharedRoomLease;
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
    sharedRoomLease: normalizeSharedRoomLease(row.sharedRoomLease),
    applicationBeforeTour: normalizeApplicationBeforeTour(row.applicationBeforeTour),
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

/**
 * Property override wins for the per-house fields (fee, default templates, requirements); else
 * the workspace/portfolio default. The signing order, the shared-room lease default and
 * "Application before a tour" are workspace-wide, so they ALWAYS come from the workspace row, whatever an old override stored.
 */
export function resolveLeasingPipelineForProperty(
  state: LeasingPipelineState,
  propertyId: string | null | undefined,
): LeasingPipelinePreferences {
  const id = propertyId?.trim() ?? "";
  const override = id ? state.byPropertyId[id] : undefined;
  const base = override ? { ...override } : { ...state.portfolio };
  return {
    ...base,
    // Application first, always: whatever a hand-built or legacy state carries.
    pipelineOrder: "application_then_lease",
    sharedRoomLease: state.portfolio.sharedRoomLease,
    applicationBeforeTour: state.portfolio.applicationBeforeTour,
  };
}

/**
 * Effective signing fee in cents for a lease (0 = no Stripe gate).
 * Null stored → 0 (unset means free until the manager sets an amount).
 */
export function effectiveLeaseSigningFeeCents(prefs: LeasingPipelinePreferences): number {
  return prefs.leaseSigningFeeCents ?? 0;
}

/** The minimal derived label a public/anonymous surface may see (PLAN-0927). Application first is the only order. */
export type SigningOrder = "application_first";

/**
 * Every prospect-facing surface is application first (captain, Oct 3 2026). Kept as a function so
 * the public projection and the manager's own Preview still ask the one place, and the stored
 * `pipelineOrder` of an older workspace can never reach a prospect.
 */
export function signingOrderForPipeline(_prefs: LeasingPipelinePreferences): SigningOrder {
  return "application_first";
}

/** The two fields a prospect-facing surface derives from the pipeline preference — never the preference row itself. */
export type PublicSigningContext = {
  signingOrder: SigningOrder;
  leaseSigningFeeCents: number;
};

/**
 * The one place the pair is derived. The public projection
 * (`resolvePublicSigningContext`) and the manager's own Preview both call this.
 */
export function signingContextForPipeline(prefs: LeasingPipelinePreferences): PublicSigningContext {
  return {
    signingOrder: signingOrderForPipeline(prefs),
    leaseSigningFeeCents: effectiveLeaseSigningFeeCents(prefs),
  };
}

/** Lease never unlocks ahead of an approved application. */
export function leaseUnlocksWithoutApplicationApproval(_prefs: LeasingPipelinePreferences): boolean {
  return false;
}

/** Whether send-for-signature still requires an approved linked application (unless applications are off). */
export function leaseSendRequiresApprovedApplication(prefs: LeasingPipelinePreferences): boolean {
  return prefs.requireApplication;
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

/**
 * Batch-load leasing-pipeline state for several managers in one query. The
 * public listing catalog resolves a signing order per listing and must not
 * issue one `manager_automation_settings` query per manager. A manager with
 * no row (never saved) is simply absent from the map — callers resolve that
 * with `resolveLeasingPipelineForProperty` against `DEFAULT_LEASING_PIPELINE`,
 * same fallback as the single-manager loader above.
 */
export async function loadLeasingPipelineStatesByManagerId(
  db: SupabaseClient,
  managerUserIds: readonly string[],
): Promise<Map<string, LeasingPipelineState>> {
  const ids = [...new Set(managerUserIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  const out = new Map<string, LeasingPipelineState>();
  if (ids.length === 0) return out;
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("manager_user_id, row_data")
    .in("manager_user_id", ids);
  if (error) throw error;
  for (const row of data ?? []) {
    const managerUserId = row.manager_user_id;
    if (!managerUserId) continue;
    const raw = row.row_data;
    const rowData = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    out.set(String(managerUserId), {
      portfolio: normalizeLeasingPipelinePreferences(rowData[ROW_DATA_KEY]),
      byPropertyId: normalizeLeasingPipelineByPropertyId(rowData[ROW_DATA_BY_PROPERTY_KEY]),
    });
  }
  return out;
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
