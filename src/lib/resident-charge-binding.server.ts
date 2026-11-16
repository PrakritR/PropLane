import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Which charge rows are a resident's even though the row carries neither their Auth id nor their sign-in address.
 *
 * A manager creates charges (and records offline receipts) against the address they typed on
 * the application. The row lands with `resident_user_id = null` and that address, and the resident may sign in with another
 * one. The resident Payments read then matched nothing and the screen said "No payments yet" over paid charges.
 *
 * Ownership here is the authenticated SUBJECT's: an application row whose `row_data.residentUserId` is the signed-in user
 * (the binding the application flow stamps), never an address on its own. Two shapes are claimed, and only when the charge
 * row has NO resident id of its own (a row already pinned to another subject is never taken):
 *  1. the charge names that application (`row_data.applicationId`), or
 *  2. the charge was written by the same manager for the application's own address.
 */
export type ResidentChargeBinding = { applicationIds: string[]; managerEmails: Array<{ managerUserId: string; email: string }> };

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An address that would break out of a PostgREST filter value is not matched at all.
const SAFE_EMAIL = /^[^\s,()"'\\*%]{1,254}$/;
const MAX_APPLICATIONS = 50;

export async function loadResidentChargeBinding(db: SupabaseClient, userId: string): Promise<ResidentChargeBinding> {
  const empty: ResidentChargeBinding = { applicationIds: [], managerEmails: [] };
  if (!userId) return empty;
  try {
    const { data, error } = await db
      .from("manager_application_records")
      .select("id, manager_user_id, resident_email")
      .eq("row_data->>residentUserId", userId)
      .limit(MAX_APPLICATIONS);
    if (error) return empty;
    const applicationIds = new Set<string>();
    const pairs = new Map<string, { managerUserId: string; email: string }>();
    for (const row of (data ?? []) as Array<{ id?: unknown; manager_user_id?: unknown; resident_email?: unknown }>) {
      const id = String(row.id ?? "").trim();
      if (SAFE_ID.test(id)) applicationIds.add(id);
      const managerUserId = String(row.manager_user_id ?? "").trim();
      const email = String(row.resident_email ?? "").trim().toLowerCase();
      if (SAFE_UUID.test(managerUserId) && SAFE_EMAIL.test(email)) pairs.set(`${managerUserId}|${email}`, { managerUserId, email });
    }
    return { applicationIds: [...applicationIds], managerEmails: [...pairs.values()] };
  } catch {
    // A failed read narrows to the direct match; it never widens.
    return empty;
  }
}

/** The extra PostgREST `or()` branch for a resident's bound charges, or null when nothing is bound. */
export function residentBoundChargeClause(binding: ResidentChargeBinding): string | null {
  const parts: string[] = [];
  if (binding.applicationIds.length > 0) parts.push(`row_data->>applicationId.in.(${binding.applicationIds.join(",")})`);
  for (const { managerUserId, email } of binding.managerEmails) {
    parts.push(`and(manager_user_id.eq.${managerUserId},resident_email.eq.${email})`);
  }
  if (parts.length === 0) return null;
  return `and(resident_user_id.is.null,or(${parts.join(",")}))`;
}
