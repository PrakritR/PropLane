import "server-only";
import { openApplicantRow, sealApplicantRow } from "@/lib/security/applicant-identity";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { proplaneIdLookupVariants } from "@/lib/manager-id";
import type { SupabaseClient } from "@supabase/supabase-js";

// Keep existing server imports compatible while browser callers use the URL-only module.
export { residentSetupIdFromUrlParams, buildResidentSetupHref, residentSetupAccountUrl } from "./resident-setup-links";

/** Default lifetime for resident account-setup links emailed after apply / approval. */
export const RESIDENT_SETUP_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function generateResidentSetupToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashResidentSetupToken(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex");
}

function hashesEqual(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");
    if (left.length === 0 || left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}


export function isResidentSetupTokenValid(row: Pick<DemoApplicantRow, "setupTokenHash" | "setupTokenExpiresAt" | "setupTokenConsumedAt">, token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed || !row.setupTokenHash) return false;
  if (row.setupTokenConsumedAt) return false;
  if (row.setupTokenExpiresAt && new Date(row.setupTokenExpiresAt).getTime() < Date.now()) return false;
  return hashesEqual(row.setupTokenHash, hashResidentSetupToken(trimmed));
}

/** Issue a fresh setup token on the application row (hash stored; raw token returned once). */
export function attachResidentSetupToken(
  row: DemoApplicantRow,
  opts?: { ttlMs?: number; now?: Date },
): { row: DemoApplicantRow; token: string } {
  const token = generateResidentSetupToken();
  const ttlMs = opts?.ttlMs ?? RESIDENT_SETUP_TOKEN_TTL_MS;
  const now = opts?.now ?? new Date();
  return {
    token,
    row: {
      ...row,
      setupTokenHash: hashResidentSetupToken(token),
      setupTokenExpiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      setupTokenConsumedAt: null,
    },
  };
}

export function markResidentSetupTokenConsumed(row: DemoApplicantRow, now = new Date()): DemoApplicantRow {
  return {
    ...row,
    setupTokenConsumedAt: now.toISOString(),
  };
}

export type ResidentSetupLookup =
  | {
      ok: true;
      axisId: string;
      email: string;
      name: string | null;
      phone: string | null;
      propertyId: string | null;
      row: DemoApplicantRow;
    }
  | { ok: false; error: string; status: number };

function rowFromRecord(record: { id: string; resident_email: string | null; row_data: unknown }): DemoApplicantRow | null {
  if (!record.row_data || typeof record.row_data !== "object" || Array.isArray(record.row_data)) return null;
  const row = record.row_data as DemoApplicantRow;
  return {
    ...row,
    id: normalizeApplicationAxisId(typeof row.id === "string" ? row.id : record.id),
    email: (row.email ?? record.resident_email ?? "").trim().toLowerCase() || row.email,
  };
}

export async function findApplicationForResidentSetup(
  db: SupabaseClient,
  params: { token: string; axisId: string },
): Promise<ResidentSetupLookup> {
  const token = params.token.trim();
  const axisId = normalizeApplicationAxisId(params.axisId);
  if (!token || !axisId) {
    return { ok: false, status: 400, error: "Setup link is missing required details." };
  }

  const variants = proplaneIdLookupVariants(axisId);
  const { data, error } = await db
    .from("manager_application_records")
    .select("id, resident_email, row_data, manager_user_id")
    .in("id", variants)
    .limit(5);

  if (error) return { ok: false, status: 500, error: error.message };

  type RecordRow = {
    id: string;
    resident_email: string | null;
    row_data: unknown;
    manager_user_id?: string | null;
  };

  let matchedRecord: RecordRow | null = null;
  let match: DemoApplicantRow | null = null;
  for (const record of (data ?? []) as RecordRow[]) {
    const row = rowFromRecord(record);
    if (row && isResidentSetupTokenValid(row, token)) {
      matchedRecord = record;
      match = row;
      break;
    }
  }

  if (!match || !matchedRecord) {
    return { ok: false, status: 403, error: "This setup link is invalid or has expired." };
  }

  const email = (match.email ?? "").trim().toLowerCase();
  if (!email.includes("@")) {
    return { ok: false, status: 400, error: "This application is missing an email address." };
  }

  match = openApplicantRow(match, matchedRecord.id);
  const managerFromDb = String(matchedRecord.manager_user_id ?? "").trim();
  if (managerFromDb) {
    match = { ...match, managerUserId: managerFromDb };
  }

  return {
    ok: true,
    axisId: match.id,
    email,
    name: match.name?.trim() || match.application?.fullLegalName?.trim() || null,
    phone: match.application?.phone?.trim() || null,
    propertyId: match.propertyId?.trim() || match.application?.propertyId?.trim() || null,
    row: match,
  };
}

/**
 * Relink an application record to a new resident email. Used when a resident
 * completes account setup via OAuth under a different email than the one on
 * their application — the valid setup token is the authorization, so we move the
 * application onto the account they actually control instead of rejecting it.
 * Rewrites both the `resident_email` column and the snapshot's `email` so the
 * downstream email-keyed provisioning (`provisionResidentAccountByEmail`) finds it.
 */
export async function relinkResidentSetupApplicationEmail(
  db: SupabaseClient,
  row: DemoApplicantRow,
  newEmail: string,
): Promise<DemoApplicantRow> {
  const email = newEmail.trim().toLowerCase();
  const relinked: DemoApplicantRow = { ...row, email };
  await db.from("manager_application_records").upsert(
    {
      id: relinked.id,
      manager_user_id: relinked.managerUserId || null,
      resident_email: email,
      property_id: relinked.propertyId || relinked.application?.propertyId || null,
      assigned_property_id: relinked.assignedPropertyId || null,
      row_data: sealApplicantRow(relinked, relinked.id, relinked.managerUserId),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  return relinked;
}

/** Persist a consumed setup token after successful account creation. */
export async function consumeResidentSetupTokenOnApplication(
  db: SupabaseClient,
  row: DemoApplicantRow,
): Promise<void> {
  const consumed = markResidentSetupTokenConsumed(row);
  await db.from("manager_application_records").upsert(
    {
      id: consumed.id,
      manager_user_id: consumed.managerUserId || null,
      resident_email: consumed.email?.trim().toLowerCase() || null,
      property_id: consumed.propertyId || consumed.application?.propertyId || null,
      assigned_property_id: consumed.assignedPropertyId || null,
      row_data: sealApplicantRow(consumed, consumed.id, consumed.managerUserId),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
}

function idVariants(id: string): string[] {
  return proplaneIdLookupVariants(id);
}

/**
 * Issue (or re-issue) a setup token on an application and persist it for emailing.
 *
 * Pass `managerUserId` to scope the lookup to applications owned by that manager.
 * Because this function ROTATES the token (invalidating any previously emailed
 * setup link), an unscoped call lets any authenticated manager rotate another
 * manager's applicant's token by id — so authenticated callers must scope.
 */
export async function ensureResidentSetupTokenForApplication(
  db: SupabaseClient,
  axisId: string,
  options?: { managerUserId?: string | null; preferredToken?: string | null },
): Promise<
  | { ok: true; token: string; axisId: string; email: string; row: DemoApplicantRow }
  | { ok: false; error: string }
> {
  const variants = idVariants(axisId);
  let query = db
    .from("manager_application_records")
    .select("id, resident_email, row_data, manager_user_id, property_id, assigned_property_id")
    .in("id", variants);
  const scopeManagerId = options?.managerUserId?.trim();
  if (scopeManagerId) query = query.eq("manager_user_id", scopeManagerId);
  const { data, error } = await query.limit(1);
  if (error) return { ok: false, error: error.message };
  const record = data?.[0];
  if (!record?.row_data) return { ok: false, error: "Application not found." };

  const raw = openApplicantRow(record.row_data, record.id);
  const row: DemoApplicantRow = {
    ...raw,
    id: normalizeApplicationAxisId(typeof raw.id === "string" ? raw.id : record.id),
    email: (raw.email ?? record.resident_email ?? "").trim().toLowerCase() || raw.email,
  };
  const email = (row.email ?? "").trim().toLowerCase();
  if (!email.includes("@")) return { ok: false, error: "Application is missing an email." };

  const preferred = options?.preferredToken?.trim();
  if (preferred && isResidentSetupTokenValid(row, preferred)) {
    return { ok: true, token: preferred, axisId: row.id, email, row };
  }

  const { row: withToken, token } = attachResidentSetupToken(row);
  await db.from("manager_application_records").upsert(
    {
      id: withToken.id,
      manager_user_id: withToken.managerUserId || record.manager_user_id || null,
      resident_email: email,
      property_id: withToken.propertyId || record.property_id || null,
      assigned_property_id: withToken.assignedPropertyId || record.assigned_property_id || null,
      row_data: sealApplicantRow(withToken, withToken.id, withToken.managerUserId || record.manager_user_id),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );

  return { ok: true, token, axisId: withToken.id, email, row: withToken };
}
