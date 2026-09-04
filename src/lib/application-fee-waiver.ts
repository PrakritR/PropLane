import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Manager-owned codes that waive the rental application fee entirely (no
 * Stripe charge of any amount, including $0). See `docs/agents/resident-payments.md`
 * for the money-path rules this sits next to.
 *
 * Design decisions (stated here so they are not re-derived elsewhere):
 * - Scoped to ONE manager. A code is looked up by `(manager_user_id, code)` —
 *   never by code alone — so the same text ("FREE100") can exist for two
 *   different managers without colliding, and one manager's code can never
 *   waive a fee on another manager's property.
 * - Reusable by default (`maxUses: null`), because the common case is a
 *   marketing code or a standing policy ("military discount"), not a single
 *   one-off grant. A manager may cap it to `maxUses` uses (1 = single-use) or
 *   set an expiry; both are optional.
 * - No client-side-only check: `redeemApplicationFeeWaiverCode` is the ONLY
 *   way a code is consumed, and it runs entirely server-side against the
 *   service-role client, calling the atomic `redeem_application_fee_waiver_code`
 *   Postgres function so a usage cap can never be raced past.
 */

export type ApplicationFeeWaiverCodeStatus = "active" | "revoked";

export type ApplicationFeeWaiverCode = {
  id: string;
  managerUserId: string;
  code: string;
  label: string | null;
  status: ApplicationFeeWaiverCodeStatus;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
};

export type ApplicationFeeWaiverRedemption = {
  id: string;
  codeId: string;
  propertyId: string;
  residentEmail: string;
  applicationId: string | null;
  redeemedAt: string;
};

type WaiverCodeRow = {
  id: string;
  manager_user_id: string;
  code: string;
  label: string | null;
  status: string;
  max_uses: number | null;
  used_count: number;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
};

type RedemptionRow = {
  id: string;
  code_id: string;
  property_id: string;
  resident_email: string;
  application_id: string | null;
  redeemed_at: string;
};

function rowToCode(row: WaiverCodeRow): ApplicationFeeWaiverCode {
  return {
    id: row.id,
    managerUserId: row.manager_user_id,
    code: row.code,
    label: row.label,
    status: row.status === "revoked" ? "revoked" : "active",
    maxUses: row.max_uses,
    usedCount: row.used_count,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

function rowToRedemption(row: RedemptionRow): ApplicationFeeWaiverRedemption {
  return {
    id: row.id,
    codeId: row.code_id,
    propertyId: row.property_id,
    residentEmail: row.resident_email,
    applicationId: row.application_id,
    redeemedAt: row.redeemed_at,
  };
}

/** Uppercased, trimmed form every lookup and the uniqueness constraint key off. */
export function normalizeWaiverCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

const WAIVER_CODE_PATTERN = /^[A-Z0-9-]{4,32}$/;

export function isValidWaiverCodeFormat(raw: string): boolean {
  return WAIVER_CODE_PATTERN.test(normalizeWaiverCode(raw));
}

const WAIVER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

function randomWaiverCode(): string {
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += WAIVER_CODE_ALPHABET[Math.floor(Math.random() * WAIVER_CODE_ALPHABET.length)];
  }
  return out;
}

export type CreateWaiverCodeInput = {
  /** Custom code text; auto-generated when omitted. */
  code?: string;
  label?: string;
  /** null/omitted = unlimited (reusable) uses. */
  maxUses?: number | null;
  /** ISO timestamp; omitted = never expires. */
  expiresAt?: string | null;
};

export type CreateWaiverCodeResult =
  | { ok: true; code: ApplicationFeeWaiverCode }
  | { ok: false; error: string };

export async function createApplicationFeeWaiverCode(
  db: SupabaseClient,
  managerUserId: string,
  input: CreateWaiverCodeInput,
): Promise<CreateWaiverCodeResult> {
  const managerId = managerUserId.trim();
  if (!managerId) return { ok: false, error: "managerUserId is required." };

  const label = input.label?.trim().slice(0, 200) || null;

  let maxUses: number | null = null;
  if (input.maxUses != null) {
    const n = Math.round(Number(input.maxUses));
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "maxUses must be a positive integer." };
    maxUses = n;
  }

  let expiresAt: string | null = null;
  if (input.expiresAt) {
    const ms = Date.parse(input.expiresAt);
    if (!Number.isFinite(ms)) return { ok: false, error: "expiresAt is not a valid date." };
    if (ms <= Date.now()) return { ok: false, error: "expiresAt must be in the future." };
    expiresAt = new Date(ms).toISOString();
  }

  const rawCode = input.code?.trim() || randomWaiverCode();
  if (!isValidWaiverCodeFormat(rawCode)) {
    return { ok: false, error: "Codes must be 4-32 letters, numbers, or hyphens." };
  }
  const normalized = normalizeWaiverCode(rawCode);

  const { data, error } = await db
    .from("manager_application_fee_waiver_codes")
    .insert({
      manager_user_id: managerId,
      code: normalized,
      code_normalized: normalized,
      label,
      max_uses: maxUses,
      expires_at: expiresAt,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") return { ok: false, error: "You already have a code with that text." };
    return { ok: false, error: error.message };
  }
  return { ok: true, code: rowToCode(data as WaiverCodeRow) };
}

export async function listApplicationFeeWaiverCodes(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ApplicationFeeWaiverCode[]> {
  const { data, error } = await db
    .from("manager_application_fee_waiver_codes")
    .select("*")
    .eq("manager_user_id", managerUserId.trim())
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as WaiverCodeRow[] | null ?? []).map(rowToCode);
}

export async function listApplicationFeeWaiverRedemptions(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ApplicationFeeWaiverRedemption[]> {
  const { data, error } = await db
    .from("application_fee_waiver_redemptions")
    .select("*")
    .eq("manager_user_id", managerUserId.trim())
    .order("redeemed_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data as RedemptionRow[] | null ?? []).map(rowToRedemption);
}

export type RevokeWaiverCodeResult = { ok: true } | { ok: false; error: string };

/** Scoped to the manager, so a manager can only ever revoke their OWN code. */
export async function revokeApplicationFeeWaiverCode(
  db: SupabaseClient,
  managerUserId: string,
  codeId: string,
): Promise<RevokeWaiverCodeResult> {
  const { data, error } = await db
    .from("manager_application_fee_waiver_codes")
    .update({ status: "revoked", revoked_at: new Date().toISOString() })
    .eq("id", codeId.trim())
    .eq("manager_user_id", managerUserId.trim())
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "Code not found." };
  return { ok: true };
}

export type WaiverRedeemFailureReason = "NOT_FOUND" | "REVOKED" | "EXPIRED" | "EXHAUSTED";

export type WaiverRedeemResult =
  | { ok: true; codeId: string }
  | { ok: false; reason: WaiverRedeemFailureReason; error: string };

const WAIVER_REDEEM_FAILURE_MESSAGES: Record<WaiverRedeemFailureReason, string> = {
  NOT_FOUND: "That code isn't valid for this listing.",
  REVOKED: "That code has been revoked.",
  EXPIRED: "That code has expired.",
  EXHAUSTED: "That code has already been used the maximum number of times.",
};

async function classifyWaiverRedeemFailure(
  db: SupabaseClient,
  managerUserId: string,
  normalizedCode: string,
): Promise<{ reason: WaiverRedeemFailureReason; error: string }> {
  const { data } = await db
    .from("manager_application_fee_waiver_codes")
    .select("status, expires_at, max_uses, used_count")
    .eq("manager_user_id", managerUserId)
    .eq("code_normalized", normalizedCode)
    .maybeSingle();
  const row = data as Pick<WaiverCodeRow, "status" | "expires_at" | "max_uses" | "used_count"> | null;
  if (!row) return { reason: "NOT_FOUND", error: WAIVER_REDEEM_FAILURE_MESSAGES.NOT_FOUND };
  if (row.status === "revoked") return { reason: "REVOKED", error: WAIVER_REDEEM_FAILURE_MESSAGES.REVOKED };
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    return { reason: "EXPIRED", error: WAIVER_REDEEM_FAILURE_MESSAGES.EXPIRED };
  }
  if (row.max_uses != null && row.used_count >= row.max_uses) {
    return { reason: "EXHAUSTED", error: WAIVER_REDEEM_FAILURE_MESSAGES.EXHAUSTED };
  }
  // Lost a race with a concurrent redemption between the lookup and the RPC.
  return { reason: "EXHAUSTED", error: WAIVER_REDEEM_FAILURE_MESSAGES.EXHAUSTED };
}

/**
 * Validates AND atomically redeems a waiver code for one application, in a
 * single server-side call. Scoped to `managerUserId` (the property's REAL
 * owner, resolved by the caller the same way the checkout route resolves it —
 * never trust a client-supplied manager id) so a code can never be redeemed
 * against a different manager's property. Never partially applies: either
 * the whole redemption lands (usage incremented + audit row inserted) or
 * nothing happens at all.
 */
export async function redeemApplicationFeeWaiverCode(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    propertyId: string;
    residentEmail: string;
    applicationId?: string | null;
    code: string;
  },
): Promise<WaiverRedeemResult> {
  const managerUserId = input.managerUserId.trim();
  const propertyId = input.propertyId.trim();
  const residentEmail = input.residentEmail.trim().toLowerCase();
  const normalizedCode = normalizeWaiverCode(input.code);
  if (!managerUserId || !propertyId || !residentEmail.includes("@") || !normalizedCode) {
    return { ok: false, reason: "NOT_FOUND", error: WAIVER_REDEEM_FAILURE_MESSAGES.NOT_FOUND };
  }

  const { data: codeRow, error: lookupError } = await db
    .from("manager_application_fee_waiver_codes")
    .select("id")
    .eq("manager_user_id", managerUserId)
    .eq("code_normalized", normalizedCode)
    .maybeSingle();
  if (lookupError) {
    return { ok: false, reason: "NOT_FOUND", error: WAIVER_REDEEM_FAILURE_MESSAGES.NOT_FOUND };
  }
  if (!codeRow) {
    return { ok: false, reason: "NOT_FOUND", error: WAIVER_REDEEM_FAILURE_MESSAGES.NOT_FOUND };
  }

  const { data: redeemed, error: redeemError } = await db.rpc("redeem_application_fee_waiver_code", {
    p_code_id: (codeRow as { id: string }).id,
    p_manager_user_id: managerUserId,
    p_property_id: propertyId,
    p_resident_email: residentEmail,
    p_application_id: input.applicationId?.trim() || null,
  });
  if (redeemError) {
    // Never echo raw database errors to the (public, unauthenticated) waiver
    // route — log server-side and answer with the generic invalid-code message.
    console.error("[application-fee-waiver] redeem RPC failed:", redeemError.message);
    return { ok: false, reason: "NOT_FOUND", error: WAIVER_REDEEM_FAILURE_MESSAGES.NOT_FOUND };
  }
  const rows = (redeemed as { id: string }[] | null) ?? [];
  if (rows.length === 0 || !rows[0]?.id) {
    const failure = await classifyWaiverRedeemFailure(db, managerUserId, normalizedCode);
    return { ok: false, ...failure };
  }
  return { ok: true, codeId: rows[0].id };
}

/**
 * Read-only preview (does NOT redeem) so the UI can show "code applied,
 * nothing due" before the applicant commits. The real guard against
 * exceeding a usage cap is always the atomic redeem above — this is
 * best-effort feedback only.
 */
export async function previewApplicationFeeWaiverCode(
  db: SupabaseClient,
  managerUserId: string,
  code: string,
): Promise<{ ok: true } | { ok: false; reason: WaiverRedeemFailureReason; error: string }> {
  const normalized = normalizeWaiverCode(code);
  if (!normalized) return { ok: false, reason: "NOT_FOUND", error: WAIVER_REDEEM_FAILURE_MESSAGES.NOT_FOUND };
  const { data } = await db
    .from("manager_application_fee_waiver_codes")
    .select("status, expires_at, max_uses, used_count")
    .eq("manager_user_id", managerUserId.trim())
    .eq("code_normalized", normalized)
    .maybeSingle();
  const row = data as Pick<WaiverCodeRow, "status" | "expires_at" | "max_uses" | "used_count"> | null;
  if (!row) return { ok: false, reason: "NOT_FOUND", error: WAIVER_REDEEM_FAILURE_MESSAGES.NOT_FOUND };
  if (row.status === "revoked") return { ok: false, reason: "REVOKED", error: WAIVER_REDEEM_FAILURE_MESSAGES.REVOKED };
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    return { ok: false, reason: "EXPIRED", error: WAIVER_REDEEM_FAILURE_MESSAGES.EXPIRED };
  }
  if (row.max_uses != null && row.used_count >= row.max_uses) {
    return { ok: false, reason: "EXHAUSTED", error: WAIVER_REDEEM_FAILURE_MESSAGES.EXHAUSTED };
  }
  return { ok: true };
}

/**
 * The single "primary" active code for the simplified Application settings UI.
 * When multiple actives exist (legacy multi-code Manage UI), prefer the oldest
 * so a standing code is not silently swapped for a newer one-off.
 */
export function pickPrimaryApplicationFeeWaiverCode(
  codes: ApplicationFeeWaiverCode[],
): ApplicationFeeWaiverCode | null {
  const active = codes.filter((c) => c.status === "active");
  if (active.length === 0) return null;
  return [...active].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0] ?? null;
}

export type SetPrimaryWaiverCodeResult =
  | { ok: true; code: ApplicationFeeWaiverCode | null }
  | { ok: false; error: string };

export const LISTING_WAIVER_LABEL_PREFIX = "listing:";

export function listingWaiverLabel(propertyId: string): string {
  return `${LISTING_WAIVER_LABEL_PREFIX}${propertyId.trim()}`;
}

/**
 * Upsert the waiver code tied to one listing/property. Uses the code `label` column
 * (`listing:<propertyId>`) so multiple properties can each have their own active code
 * without revoking the manager's other listings.
 */
export async function upsertPropertyApplicationFeeWaiverCode(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string,
  rawCode: string | null | undefined,
): Promise<SetPrimaryWaiverCodeResult> {
  const pid = propertyId.trim();
  if (!pid) return { ok: false, error: "propertyId is required." };
  const label = listingWaiverLabel(pid);
  const existing = await listApplicationFeeWaiverCodes(db, managerUserId);
  const tagged = existing.filter((c) => c.label === label);
  const trimmed = (rawCode ?? "").trim();

  if (!trimmed) {
    for (const c of tagged.filter((row) => row.status === "active")) {
      const revoked = await revokeApplicationFeeWaiverCode(db, managerUserId, c.id);
      if (!revoked.ok) return { ok: false, error: revoked.error };
    }
    return { ok: true, code: null };
  }

  if (!isValidWaiverCodeFormat(trimmed)) {
    return { ok: false, error: "Codes must be 4-32 letters, numbers, or hyphens." };
  }
  const normalized = normalizeWaiverCode(trimmed);
  const matching =
    tagged.find((c) => c.code === normalized && c.status === "active") ??
    existing.find((c) => c.code === normalized && c.status === "active") ??
    null;

  for (const c of tagged.filter((row) => row.status === "active" && row.id !== matching?.id)) {
    const revoked = await revokeApplicationFeeWaiverCode(db, managerUserId, c.id);
    if (!revoked.ok) return { ok: false, error: revoked.error };
  }

  if (matching) {
    if (matching.label !== label) {
      const { error } = await db
        .from("manager_application_fee_waiver_codes")
        .update({ label })
        .eq("id", matching.id)
        .eq("manager_user_id", managerUserId.trim());
      if (error) return { ok: false, error: error.message };
      return { ok: true, code: { ...matching, label } };
    }
    return { ok: true, code: matching };
  }

  const created = await createApplicationFeeWaiverCode(db, managerUserId, {
    code: normalized,
    label,
    maxUses: null,
  });
  if (!created.ok) return { ok: false, error: created.error };
  return { ok: true, code: created.code };
}

/**
 * Collapse the manager's waiver codes to at most one unlimited primary code.
 * Compatible with the multi-code table: extras are revoked, not deleted.
 * Empty/`null` clears every active code.
 */
export async function setPrimaryApplicationFeeWaiverCode(
  db: SupabaseClient,
  managerUserId: string,
  rawCode: string | null | undefined,
): Promise<SetPrimaryWaiverCodeResult> {
  const trimmed = (rawCode ?? "").trim();
  const existing = await listApplicationFeeWaiverCodes(db, managerUserId);
  const active = existing.filter((c) => c.status === "active");

  if (!trimmed) {
    for (const c of active) {
      const revoked = await revokeApplicationFeeWaiverCode(db, managerUserId, c.id);
      if (!revoked.ok) return { ok: false, error: revoked.error };
    }
    return { ok: true, code: null };
  }

  if (!isValidWaiverCodeFormat(trimmed)) {
    return { ok: false, error: "Codes must be 4-32 letters, numbers, or hyphens." };
  }
  const normalized = normalizeWaiverCode(trimmed);
  const matching = active.find((c) => c.code === normalized) ?? null;

  for (const c of active) {
    if (matching && c.id === matching.id) continue;
    const revoked = await revokeApplicationFeeWaiverCode(db, managerUserId, c.id);
    if (!revoked.ok) return { ok: false, error: revoked.error };
  }

  if (matching) return { ok: true, code: matching };

  const created = await createApplicationFeeWaiverCode(db, managerUserId, {
    code: normalized,
    maxUses: null,
  });
  if (!created.ok) return { ok: false, error: created.error };
  return { ok: true, code: created.code };
}
