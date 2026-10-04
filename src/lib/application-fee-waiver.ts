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

/** Which fee a code waives. Rows written before the lease fee existed read as `application`. */
export type WaiverCodeAppliesTo = "application" | "lease" | "both";

/** The fee a redemption is being spent on. */
export type WaiverFeeKind = "application" | "lease";

export const WAIVER_CODE_APPLIES_TO_VALUES: readonly WaiverCodeAppliesTo[] = ["application", "lease", "both"];

export function normalizeWaiverAppliesTo(raw: unknown): WaiverCodeAppliesTo {
  return raw === "lease" || raw === "both" ? raw : "application";
}

/** Does a code with this `appliesTo` waive this fee? The one answer the TypeScript side and the SQL redeem functions agree on. */
export function waiverCodeAppliesToFee(appliesTo: unknown, fee: WaiverFeeKind): boolean {
  const value = normalizeWaiverAppliesTo(appliesTo);
  return value === "both" || value === fee;
}

/**
 * Does a code apply on `propertyId`? A non-empty `propertyIds` list decides; otherwise the legacy single
 * `propertyId`; otherwise (neither set) every property the manager owns. Mirrors the SQL function
 * `waiver_code_covers_property`, which is what actually arbitrates a redemption.
 */
export function waiverCodeCoversProperty(
  code: { propertyId?: string | null; propertyIds?: readonly string[] | null },
  propertyId: string,
): boolean {
  const target = propertyId.trim();
  const list = code.propertyIds ?? [];
  if (list.length > 0) return list.includes(target);
  if (code.propertyId) return code.propertyId === target;
  return true;
}

export type ApplicationFeeWaiverCode = {
  id: string;
  managerUserId: string;
  code: string;
  label: string | null;
  /** Listing this code waives on. `null` = every property this manager owns (legacy). */
  propertyId: string | null;
  /** Properties this code is limited to. Empty = no list (the legacy `propertyId`, else every property). */
  propertyIds: string[];
  /** Which fee the code waives. */
  appliesTo: WaiverCodeAppliesTo;
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
  /** What the use was spent on. */
  kind: WaiverFeeKind;
  /** The lease a lease-fee redemption waived. */
  leaseId: string | null;
  redeemedAt: string;
};

type WaiverCodeRow = {
  id: string;
  manager_user_id: string;
  code: string;
  label: string | null;
  property_id: string | null;
  property_ids?: string[] | null;
  applies_to?: string | null;
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
  kind?: string | null;
  lease_id?: string | null;
  redeemed_at: string;
};

function rowToCode(row: WaiverCodeRow): ApplicationFeeWaiverCode {
  return {
    id: row.id,
    managerUserId: row.manager_user_id,
    code: row.code,
    label: row.label,
    propertyId: row.property_id ?? null,
    propertyIds: Array.isArray(row.property_ids) ? row.property_ids.filter((id) => typeof id === "string" && id) : [],
    appliesTo: normalizeWaiverAppliesTo(row.applies_to),
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
    kind: row.kind === "lease" ? "lease" : "application",
    leaseId: row.lease_id ?? null,
    redeemedAt: row.redeemed_at,
  };
}

/** Uppercased, trimmed form every lookup and the uniqueness constraint key off. */
export function normalizeWaiverCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

/**
 * Do two typed-in code fields mean the SAME code? Normalization decides, because
 * the uniqueness constraint keys off `code_normalized`: "spring" and " SPRING "
 * are one code, and a caller comparing raw text would read a re-cased field as
 * an edit. An absent field and an empty one are both "no code".
 */
export function sameApplicationFeeWaiverCodeText(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return normalizeWaiverCode(a ?? "") === normalizeWaiverCode(b ?? "");
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

const MAX_LIMITED_PROPERTIES = 500;

function parseAppliesToInput(raw: unknown): { ok: true; value: WaiverCodeAppliesTo } | { ok: false; error: string } {
  if (raw == null || raw === "") return { ok: true, value: "application" };
  if (raw === "application" || raw === "lease" || raw === "both") return { ok: true, value: raw };
  return { ok: false, error: "appliesTo must be application, lease or both." };
}

function parsePropertyIdsInput(raw: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (raw == null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "propertyIds must be a list." };
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return { ok: false, error: "propertyIds must be a list of property ids." };
    const id = entry.trim();
    if (!id) continue;
    if (id.length > 200) return { ok: false, error: "A property id is too long." };
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > MAX_LIMITED_PROPERTIES) return { ok: false, error: "Too many properties on one code." };
  return { ok: true, value: out };
}

export type CreateWaiverCodeInput = {
  /** Custom code text; auto-generated when omitted. */
  code?: string;
  label?: string;
  /** Listing this code waives on; omitted = portfolio-wide (legacy shape). */
  propertyId?: string | null;
  /** Limit the code to these properties. Omitted/empty = no limit (workspace-wide). */
  propertyIds?: readonly string[] | null;
  /** Which fee the code waives. Omitted = the application fee (the original behaviour). */
  appliesTo?: WaiverCodeAppliesTo | null;
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
  const propertyId = input.propertyId?.trim() || null;

  const appliesToResult = parseAppliesToInput(input.appliesTo);
  if (!appliesToResult.ok) return appliesToResult;
  const propertyIdsResult = parsePropertyIdsInput(input.propertyIds);
  if (!propertyIdsResult.ok) return propertyIdsResult;

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
      property_id: propertyId,
      property_ids: propertyIdsResult.value.length > 0 ? propertyIdsResult.value : null,
      applies_to: appliesToResult.value,
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

/**
 * A property limit may only name properties the manager owns. Without this a code could carry another
 * manager's property id; the redeem would still be scoped to the code's own manager, so it could never
 * waive anything, but the manager's screen would show a limit that means nothing.
 */
export async function assertPropertiesOwnedByManager(
  db: SupabaseClient,
  managerUserId: string,
  propertyIds: readonly string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ids = [...new Set(propertyIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return { ok: true };
  const { data, error } = await db
    .from("manager_property_records")
    .select("id")
    .eq("manager_user_id", managerUserId.trim())
    .in("id", ids);
  if (error) return { ok: false, error: "Could not check those properties just now. Try again." };
  const owned = new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
  if (ids.some((id) => !owned.has(id))) return { ok: false, error: "Pick properties from your own portfolio." };
  return { ok: true };
}

export type UpdateWaiverCodeInput = {
  appliesTo?: WaiverCodeAppliesTo;
  /** Replace the property limit. Empty list = workspace-wide. */
  propertyIds?: readonly string[];
  /** null = unlimited. */
  maxUses?: number | null;
  /** null = never expires. */
  expiresAt?: string | null;
  label?: string | null;
};

export type UpdateWaiverCodeResult =
  | { ok: true; code: ApplicationFeeWaiverCode }
  | { ok: false; error: string; status: number };

/**
 * Edit an ACTIVE code the manager owns: what it applies to, which properties it is limited to, its use cap,
 * its expiry and its label. The code text never changes (it is what applicants already hold), and a revoked
 * code is never revived. The cap cannot drop below the uses already spent, so an edit can never make the
 * counter exceed the cap that the atomic redeem enforces.
 */
export async function updateApplicationFeeWaiverCode(
  db: SupabaseClient,
  managerUserId: string,
  codeId: string,
  input: UpdateWaiverCodeInput,
): Promise<UpdateWaiverCodeResult> {
  const managerId = managerUserId.trim();
  const { data: existing, error: loadError } = await db
    .from("manager_application_fee_waiver_codes")
    .select("*")
    .eq("id", codeId.trim())
    .eq("manager_user_id", managerId)
    .maybeSingle();
  if (loadError) return { ok: false, error: loadError.message, status: 500 };
  if (!existing) return { ok: false, error: "Code not found.", status: 404 };
  const current = rowToCode(existing as WaiverCodeRow);
  if (current.status !== "active") {
    return { ok: false, error: "A revoked code cannot be edited.", status: 409 };
  }

  const patch: Record<string, unknown> = {};

  if (input.appliesTo !== undefined) {
    const parsed = parseAppliesToInput(input.appliesTo);
    if (!parsed.ok) return { ...parsed, status: 400 };
    patch.applies_to = parsed.value;
  }
  if (input.propertyIds !== undefined) {
    const parsed = parsePropertyIdsInput(input.propertyIds);
    if (!parsed.ok) return { ...parsed, status: 400 };
    patch.property_ids = parsed.value.length > 0 ? parsed.value : null;
    // The list replaces the legacy single property: leaving it would keep limiting a code the manager just opened up.
    patch.property_id = null;
    if (input.label === undefined && (current.label ?? "").startsWith(LISTING_WAIVER_LABEL_PREFIX)) patch.label = null;
  }
  if (input.maxUses !== undefined) {
    if (input.maxUses === null) {
      patch.max_uses = null;
    } else {
      const n = Math.round(Number(input.maxUses));
      if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "maxUses must be a positive integer.", status: 400 };
      if (n < current.usedCount) {
        return { ok: false, error: `This code was already used ${current.usedCount} times. The limit cannot be lower.`, status: 400 };
      }
      patch.max_uses = n;
    }
  }
  if (input.expiresAt !== undefined) {
    if (input.expiresAt === null || input.expiresAt === "") {
      patch.expires_at = null;
    } else {
      const ms = Date.parse(input.expiresAt);
      if (!Number.isFinite(ms)) return { ok: false, error: "expiresAt is not a valid date.", status: 400 };
      if (ms <= Date.now()) return { ok: false, error: "expiresAt must be in the future.", status: 400 };
      patch.expires_at = new Date(ms).toISOString();
    }
  }
  if (input.label !== undefined) {
    patch.label = input.label?.trim().slice(0, 200) || null;
  }

  if (Object.keys(patch).length === 0) return { ok: true, code: current };

  const { data, error } = await db
    .from("manager_application_fee_waiver_codes")
    .update(patch)
    .eq("id", current.id)
    .eq("manager_user_id", managerId)
    .eq("status", "active")
    .select("*")
    .maybeSingle();
  if (error) return { ok: false, error: error.message, status: 500 };
  if (!data) return { ok: false, error: "Code not found.", status: 404 };
  return { ok: true, code: rowToCode(data as WaiverCodeRow) };
}

/**
 * `UNAVAILABLE` is OUR failure, not the applicant's: the code lookup itself
 * could not run (schema drift, a database outage, a dropped connection). It
 * exists because reporting that as `NOT_FOUND` told applicants their manager's
 * perfectly good code was invalid — which is exactly how a missing
 * `property_id` column read to everyone using the product, on both sides, for a
 * full day. A refusal we cannot substantiate must never be phrased as a verdict
 * on the code.
 */
export type WaiverRedeemFailureReason =
  | "NOT_FOUND"
  | "REVOKED"
  | "EXPIRED"
  | "EXHAUSTED"
  | "UNAVAILABLE";

export type WaiverRedeemResult =
  | { ok: true; codeId: string }
  | { ok: false; reason: WaiverRedeemFailureReason; error: string };

const WAIVER_REDEEM_FAILURE_MESSAGES: Record<WaiverRedeemFailureReason, string> = {
  NOT_FOUND: "That code isn't valid for this listing.",
  REVOKED: "That code has been revoked.",
  EXPIRED: "That code has expired.",
  EXHAUSTED: "That code has already been used the maximum number of times.",
  UNAVAILABLE: "We couldn't check that code just now. Please try again in a moment.",
};

/**
 * The code row that applies to ONE property for ONE fee, out of every row this manager has under that
 * text. A row is eligible when it waives this fee (`applies_to`) and applies on this property
 * (`waiverCodeCoversProperty`: the property list, else the legacy single property, else every property).
 * Prefers an active row limited to specific properties, then an active workspace-wide row, then their
 * inactive equivalents so a refusal can be explained precisely ("revoked" / "expired") instead of a
 * blanket "not found". A row for the other fee, or for other properties, is simply not found.
 */
function pickWaiverCodeRowForProperty<
  T extends {
    property_id?: string | null;
    property_ids?: string[] | null;
    applies_to?: string | null;
    status?: string | null;
  },
>(rows: readonly T[], propertyId: string, fee: WaiverFeeKind = "application"): T | null {
  const eligible = rows.filter(
    (r) =>
      waiverCodeAppliesToFee(r.applies_to, fee) &&
      waiverCodeCoversProperty({ propertyId: r.property_id ?? null, propertyIds: r.property_ids ?? null }, propertyId),
  );
  const limited = (r: T) => (r.property_ids?.length ?? 0) > 0 || r.property_id != null;
  return (
    eligible.find((r) => limited(r) && r.status === "active") ??
    eligible.find((r) => r.status === "active") ??
    eligible.find((r) => limited(r)) ??
    eligible[0] ??
    null
  );
}

type WaiverLookupRow = Pick<
  WaiverCodeRow,
  "status" | "expires_at" | "max_uses" | "used_count" | "property_id" | "property_ids" | "applies_to"
>;

/** Why a code that exists cannot be spent (or that it does not apply here at all). Never throws. */
function explainWaiverRow(
  row: WaiverLookupRow | null,
  fee: WaiverFeeKind,
): { reason: WaiverRedeemFailureReason; error: string } | null {
  if (!row) return { reason: "NOT_FOUND", error: waiverFailureMessage("NOT_FOUND", fee) };
  if (row.status === "revoked") return { reason: "REVOKED", error: waiverFailureMessage("REVOKED", fee) };
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    return { reason: "EXPIRED", error: waiverFailureMessage("EXPIRED", fee) };
  }
  if (row.max_uses != null && row.used_count >= row.max_uses) {
    return { reason: "EXHAUSTED", error: waiverFailureMessage("EXHAUSTED", fee) };
  }
  return null;
}

function waiverFailureMessage(reason: WaiverRedeemFailureReason, fee: WaiverFeeKind): string {
  if (fee === "lease" && reason === "NOT_FOUND") return "That code isn't valid for this lease.";
  return WAIVER_REDEEM_FAILURE_MESSAGES[reason];
}

async function classifyWaiverRedeemFailure(
  db: SupabaseClient,
  managerUserId: string,
  normalizedCode: string,
  propertyId: string,
  fee: WaiverFeeKind = "application",
): Promise<{ reason: WaiverRedeemFailureReason; error: string }> {
  const { data, error } = await db
    .from("manager_application_fee_waiver_codes")
    .select("id, status, expires_at, max_uses, used_count, property_id, property_ids, applies_to")
    .eq("manager_user_id", managerUserId)
    .eq("code_normalized", normalizedCode);
  if (error) {
    console.error("[application-fee-waiver] classify lookup failed:", error.message);
    return { reason: "UNAVAILABLE", error: WAIVER_REDEEM_FAILURE_MESSAGES.UNAVAILABLE };
  }
  const row = pickWaiverCodeRowForProperty((data as WaiverLookupRow[] | null) ?? [], propertyId, fee);
  const explained = explainWaiverRow(row, fee);
  if (explained) return explained;
  // Lost a race with a concurrent redemption between the lookup and the RPC.
  return { reason: "EXHAUSTED", error: waiverFailureMessage("EXHAUSTED", fee) };
}

/**
 * Find the ONE code a resident typed, for one fee on one property, and say whether it can be spent.
 * Read-only: the atomic redeem function is still what spends a use. Shared by the application-fee
 * redeem/preview and the lease-fee redeem so both read the rule through the same lookup.
 */
export async function lookupWaiverCodeForFee(
  db: SupabaseClient,
  input: { managerUserId: string; code: string; propertyId: string; fee: WaiverFeeKind },
): Promise<{ ok: true; codeId: string } | { ok: false; reason: WaiverRedeemFailureReason; error: string }> {
  const normalized = normalizeWaiverCode(input.code);
  if (!normalized || !input.managerUserId.trim() || !input.propertyId.trim()) {
    return { ok: false, reason: "NOT_FOUND", error: waiverFailureMessage("NOT_FOUND", input.fee) };
  }
  const { data, error } = await db
    .from("manager_application_fee_waiver_codes")
    .select("id, status, expires_at, max_uses, used_count, property_id, property_ids, applies_to")
    .eq("manager_user_id", input.managerUserId.trim())
    .eq("code_normalized", normalized);
  // A database that cannot answer must never read as a code that does not exist.
  if (error) {
    console.error("[application-fee-waiver] lookup failed:", error.message);
    return { ok: false, reason: "UNAVAILABLE", error: WAIVER_REDEEM_FAILURE_MESSAGES.UNAVAILABLE };
  }
  const row = pickWaiverCodeRowForProperty((data as (WaiverLookupRow & { id: string })[] | null) ?? [], input.propertyId.trim(), input.fee);
  const explained = explainWaiverRow(row, input.fee);
  if (explained) return { ok: false, ...explained };
  return { ok: true, codeId: (row as unknown as { id: string }).id };
}

/**
 * Validates AND atomically redeems a waiver code for one application, in a
 * single server-side call. Scoped to `managerUserId` (the property's REAL
 * owner, resolved by the caller the same way the checkout route resolves it —
 * never trust a client-supplied manager id) so a code can never be redeemed
 * against a different manager's property. Never partially applies: either
 * the whole redemption lands (usage incremented + audit row inserted) or
 * nothing happens at all. Only a code that applies to the APPLICATION fee
 * (`applies_to` application or both) can be spent here.
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

  // The SAME text can sit on several rows only in theory (the unique index is per manager + text), but
  // select every candidate and prefer the one that applies to THIS property for THIS fee. The database
  // still arbitrates: the redeem function re-checks the property and the fee, so a mis-picked row cannot
  // waive anything.
  const { data: codeRows, error: lookupError } = await db
    .from("manager_application_fee_waiver_codes")
    .select("id, property_id, property_ids, applies_to, status")
    .eq("manager_user_id", managerUserId)
    .eq("code_normalized", normalizedCode);
  if (lookupError) {
    // Never blame the applicant for a query we could not run.
    console.error("[application-fee-waiver] redeem lookup failed:", lookupError.message);
    return { ok: false, reason: "UNAVAILABLE", error: WAIVER_REDEEM_FAILURE_MESSAGES.UNAVAILABLE };
  }
  const candidates =
    (codeRows as
      | { id: string; property_id: string | null; property_ids: string[] | null; applies_to: string | null; status: string }[]
      | null) ?? [];
  const codeRow = pickWaiverCodeRowForProperty(candidates, propertyId, "application");
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
    return { ok: false, reason: "UNAVAILABLE", error: WAIVER_REDEEM_FAILURE_MESSAGES.UNAVAILABLE };
  }
  const rows = (redeemed as { id: string }[] | null) ?? [];
  if (rows.length === 0 || !rows[0]?.id) {
    const failure = await classifyWaiverRedeemFailure(db, managerUserId, normalizedCode, propertyId, "application");
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
  /**
   * The listing being applied to. Required — without it this would tell an
   * applicant a neighbouring property's code is valid, and the redeem call would
   * then refuse it at payment.
   */
  propertyId: string,
): Promise<{ ok: true } | { ok: false; reason: WaiverRedeemFailureReason; error: string }> {
  const result = await lookupWaiverCodeForFee(db, {
    managerUserId,
    code,
    propertyId,
    fee: "application",
  });
  return result.ok ? { ok: true } : result;
}

/**
 * The single "primary" active code for the simplified Application settings UI.
 * When multiple actives exist (legacy multi-code Manage UI), prefer the oldest
 * so a standing code is not silently swapped for a newer one-off.
 */
export function pickPrimaryApplicationFeeWaiverCode(
  codes: ApplicationFeeWaiverCode[],
): ApplicationFeeWaiverCode | null {
  const active = codes.filter((c) => c.status === "active" && isPromoFieldCode(c));
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
 * The manager's active PORTFOLIO-WIDE code — `property_id IS NULL` and not a
 * legacy `listing:<id>` row. `pickWaiverCodeRowForProperty` keeps these
 * redeemable on EVERY property, so a per-property settings screen that surfaces
 * only the property-scoped code hides a waiver that is still live on that
 * property. Reported alongside, never instead of, the property's own code: a
 * property-scoped field must not look like it can revoke a portfolio code.
 */
export function pickPortfolioApplicationFeeWaiverCode(
  codes: ApplicationFeeWaiverCode[],
): ApplicationFeeWaiverCode | null {
  const active = codes.filter(
    (c) =>
      c.status === "active" &&
      isPromoFieldCode(c) &&
      c.propertyId == null &&
      !(c.label ?? "").startsWith(LISTING_WAIVER_LABEL_PREFIX),
  );
  if (active.length === 0) return null;
  return [...active].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0] ?? null;
}

/**
 * The unique index is `(manager_user_id, code_normalized)` — it does NOT include
 * `status`. A REVOKED row therefore still owns its text, so re-typing a code the
 * manager retired earlier cannot be created, and the insert comes back as an
 * opaque 23505 only AFTER the caller has already revoked whatever code was live.
 * Both write planners refuse it up front instead, so nothing is written and the
 * currently active code survives. Reviving the old row is deliberately NOT the
 * answer: its usage count, cap and expiry belong to the grant that was ended.
 */
const RETIRED_WAIVER_CODE_ERROR =
  "That code was used before and has been retired, so it cannot be brought back. Pick different text.";

function findRetiredWaiverCodeWithText(
  existing: ApplicationFeeWaiverCode[],
  normalized: string,
): ApplicationFeeWaiverCode | null {
  return existing.find((c) => c.code === normalized && c.status === "revoked") ?? null;
}

/**
 * The single promo-code field on the Applications settings and the listing wizard manages APPLICATION-only
 * codes. A code that also waives (or only waives) the lease fee is edited on the waive-codes screen, so the
 * promo field neither lists it, nor revokes it when the field is cleared, nor takes its text over.
 */
const LEASE_CODE_TEXT_ERROR =
  "That code is managed under Waive codes. Change it there, or pick different text.";

/** A code the single promo field owns: application-only, and not limited to a list of properties. */
function isPromoFieldCode(c: ApplicationFeeWaiverCode): boolean {
  // `?? ` tolerates a code object built before these fields existed (a stored or hand-built one).
  return (c.appliesTo ?? "application") === "application" && (c.propertyIds ?? []).length === 0;
}

function findLeaseWaiverCodeWithText(
  existing: ApplicationFeeWaiverCode[],
  normalized: string,
): ApplicationFeeWaiverCode | null {
  return existing.find((c) => c.code === normalized && !isPromoFieldCode(c)) ?? null;
}

type PropertyWaiverCodePlan =
  | { ok: false; error: string }
  | {
      ok: true;
      /** Rows on this property whose active grant this write ends. */
      revoke: ApplicationFeeWaiverCode[];
      /** The row this write keeps or re-pins, when one already carries the text. */
      matching: ApplicationFeeWaiverCode | null;
      normalized: string;
      label: string;
    };

/**
 * Decide what a per-property waiver write would do, from rows already read.
 *
 * Pure, so the same answer serves the write itself and the read-only precheck a
 * caller runs before committing a listing. Two rules cannot be decided by the
 * database — its unique index reports a collision as an opaque 23505, and it
 * cannot see who is asking — so they live here.
 */
function planPropertyWaiverCodeWrite(
  allCodes: ApplicationFeeWaiverCode[],
  propertyId: string,
  rawCode: string | null | undefined,
  allowPortfolioConversion: boolean,
): PropertyWaiverCodePlan {
  const label = listingWaiverLabel(propertyId);
  // Only application-only codes are this field's to manage; lease and both codes are left untouched.
  const existing = allCodes.filter(isPromoFieldCode);
  // A row belongs to this listing by `property_id`; the older `listing:<id>`
  // label is still honoured for rows written before the column existed.
  const mine = existing.filter(
    (c) => c.propertyId === propertyId || (c.propertyId == null && c.label === label),
  );
  const activeMine = mine.filter((row) => row.status === "active");
  const trimmed = (rawCode ?? "").trim();

  if (!trimmed) {
    return { ok: true, revoke: activeMine, matching: null, normalized: "", label };
  }

  if (!isValidWaiverCodeFormat(trimmed)) {
    return { ok: false, error: "Codes must be 4-32 letters, numbers, or hyphens." };
  }
  const normalized = normalizeWaiverCode(trimmed);
  if (findLeaseWaiverCodeWithText(allCodes, normalized)) {
    return { ok: false, error: LEASE_CODE_TEXT_ERROR };
  }

  // Code text is unique per manager, so the same text cannot sit on two
  // listings. Reusing another property's row would MOVE the code off that
  // property — silently un-waiving a code its applicants may already hold. Say
  // so instead.
  const onAnotherProperty = existing.find(
    (c) => c.code === normalized && c.status === "active" && c.propertyId != null && c.propertyId !== propertyId,
  );
  if (onAnotherProperty) {
    return {
      ok: false,
      error: "That code is already in use on another property. Give this one its own code.",
    };
  }

  const ownMatch = mine.find((c) => c.code === normalized && c.status === "active") ?? null;
  // A legacy portfolio-wide code with this text is taken over by this property
  // rather than left applying everywhere — but that un-waives the fee on every
  // OTHER listing the owner has, so only the owner may do it.
  const portfolioMatch = ownMatch
    ? null
    : existing.find((c) => c.code === normalized && c.status === "active" && c.propertyId == null) ?? null;
  if (portfolioMatch && !allowPortfolioConversion) {
    return {
      ok: false,
      error:
        "That code applies to every property on this account. Only the account owner can point it at a single property. Give this listing its own code.",
    };
  }
  const matching = ownMatch ?? portfolioMatch;
  if (!matching && findRetiredWaiverCodeWithText(allCodes, normalized)) {
    return { ok: false, error: RETIRED_WAIVER_CODE_ERROR };
  }

  return {
    ok: true,
    revoke: activeMine.filter((row) => row.id !== matching?.id),
    matching,
    normalized,
    label,
  };
}

/**
 * Whether a per-property waiver write WOULD be accepted, without writing.
 *
 * Internal: `previewApplicationFeeWaiverCodeWrite` is the single exported gate,
 * so a route cannot pick the narrower of two same-shaped prechecks by name and
 * silently skip the portfolio path.
 */
async function previewPropertyApplicationFeeWaiverCodeWrite(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string,
  rawCode: string | null | undefined,
  opts?: { allowPortfolioConversion?: boolean },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const pid = propertyId.trim();
  if (!pid) return { ok: false, error: "propertyId is required." };
  const existing = await listApplicationFeeWaiverCodes(db, managerUserId);
  const plan = planPropertyWaiverCodeWrite(existing, pid, rawCode, opts?.allowPortfolioConversion === true);
  return plan.ok ? { ok: true } : { ok: false, error: plan.error };
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
  /**
   * Whether this write may CONVERT a legacy portfolio-wide code (`property_id
   * IS NULL`, redeemable on every one of the owner's listings) into a code
   * pinned to `propertyId`. Off by default: this function is called with the
   * OWNER's id even when a property-scoped co-manager is the one typing, so it
   * cannot tell the two apart on its own. Only a caller that has established
   * the authenticated user IS the owner may pass `true`.
   */
  opts?: { allowPortfolioConversion?: boolean },
): Promise<SetPrimaryWaiverCodeResult> {
  const allowPortfolioConversion = opts?.allowPortfolioConversion === true;
  const pid = propertyId.trim();
  if (!pid) return { ok: false, error: "propertyId is required." };
  const existing = await listApplicationFeeWaiverCodes(db, managerUserId);
  const plan = planPropertyWaiverCodeWrite(existing, pid, rawCode, allowPortfolioConversion);
  if (!plan.ok) return { ok: false, error: plan.error };
  const { matching, normalized, label } = plan;

  for (const c of plan.revoke) {
    const revoked = await revokeApplicationFeeWaiverCode(db, managerUserId, c.id);
    if (!revoked.ok) return { ok: false, error: revoked.error };
  }

  if (!normalized) return { ok: true, code: null };

  if (matching) {
    if (matching.label !== label || matching.propertyId !== pid) {
      const { error } = await db
        .from("manager_application_fee_waiver_codes")
        .update({ label, property_id: pid })
        .eq("id", matching.id)
        .eq("manager_user_id", managerUserId.trim());
      if (error) return { ok: false, error: error.message };
      return { ok: true, code: { ...matching, label, propertyId: pid } };
    }
    return { ok: true, code: matching };
  }

  const created = await createApplicationFeeWaiverCode(db, managerUserId, {
    code: normalized,
    label,
    propertyId: pid,
    maxUses: null,
  });
  if (!created.ok) return { ok: false, error: created.error };
  return { ok: true, code: created.code };
}

type PortfolioWaiverCodePlan =
  | { ok: false; error: string }
  | {
      ok: true;
      revoke: ApplicationFeeWaiverCode[];
      matching: ApplicationFeeWaiverCode | null;
      normalized: string;
    };

/**
 * Decide what a PORTFOLIO-wide waiver write would do, from rows already read.
 * Pure, for the same reason the per-property planner is: the refusal has to be
 * available before the caller revokes the code that is live today.
 */
function planPortfolioWaiverCodeWrite(
  allCodes: ApplicationFeeWaiverCode[],
  rawCode: string | null | undefined,
): PortfolioWaiverCodePlan {
  const trimmed = (rawCode ?? "").trim();
  // Only application-only codes are this field's to manage; lease and both codes are left untouched.
  const active = allCodes.filter((c) => c.status === "active" && isPromoFieldCode(c));

  if (!trimmed) return { ok: true, revoke: active, matching: null, normalized: "" };

  if (!isValidWaiverCodeFormat(trimmed)) {
    return { ok: false, error: "Codes must be 4-32 letters, numbers, or hyphens." };
  }
  const normalized = normalizeWaiverCode(trimmed);
  if (findLeaseWaiverCodeWithText(allCodes, normalized)) {
    return { ok: false, error: LEASE_CODE_TEXT_ERROR };
  }
  const matching = active.find((c) => c.code === normalized) ?? null;
  if (!matching && findRetiredWaiverCodeWithText(allCodes, normalized)) {
    return { ok: false, error: RETIRED_WAIVER_CODE_ERROR };
  }

  return { ok: true, revoke: active.filter((c) => c.id !== matching?.id), matching, normalized };
}

/**
 * Whether a waiver write WOULD be accepted, without writing — per-property when
 * `propertyId` is given, portfolio-wide when it is empty.
 *
 * Every caller that must commit something else in the same request (a listing
 * record, the fee settings row) runs this FIRST, so a refused code leaves zero
 * mutations behind instead of a half-applied save.
 */
export async function previewApplicationFeeWaiverCodeWrite(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string | null | undefined,
  rawCode: string | null | undefined,
  opts?: { allowPortfolioConversion?: boolean },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const pid = (propertyId ?? "").trim();
  if (pid) {
    return previewPropertyApplicationFeeWaiverCodeWrite(db, managerUserId, pid, rawCode, opts);
  }
  const existing = await listApplicationFeeWaiverCodes(db, managerUserId);
  const plan = planPortfolioWaiverCodeWrite(existing, rawCode);
  return plan.ok ? { ok: true } : { ok: false, error: plan.error };
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
  const existing = await listApplicationFeeWaiverCodes(db, managerUserId);
  const plan = planPortfolioWaiverCodeWrite(existing, rawCode);
  if (!plan.ok) return { ok: false, error: plan.error };
  const { matching, normalized } = plan;

  for (const c of plan.revoke) {
    const revoked = await revokeApplicationFeeWaiverCode(db, managerUserId, c.id);
    if (!revoked.ok) return { ok: false, error: revoked.error };
  }

  if (!normalized) return { ok: true, code: null };
  if (matching) return { ok: true, code: matching };

  const created = await createApplicationFeeWaiverCode(db, managerUserId, {
    code: normalized,
    maxUses: null,
  });
  if (!created.ok) return { ok: false, error: created.error };
  return { ok: true, code: created.code };
}
