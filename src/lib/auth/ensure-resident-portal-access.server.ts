import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureSignedInResidentAccount } from "@/lib/auth/ensure-signed-in-resident.server";

export type EnsureResidentPortalAccessResult =
  | { ok: true }
  | { ok: false; status: 500; error: string };

/**
 * Resident tour surfaces may auto-promote any signed-in account (including a
 * manager booking their own listing). Always backfills tour links for the
 * account email — idempotent for accounts that already hold the resident role.
 */
export async function ensureMayAccessResidentPortal(
  db: SupabaseClient,
  user: { id: string; email?: string | null; email_confirmed_at?: string | null },
): Promise<EnsureResidentPortalAccessResult> {
  const ensured = await ensureSignedInResidentAccount(db, user);
  if (!ensured.ok) {
    return { ok: false, status: 500, error: ensured.error };
  }
  return { ok: true };
}
