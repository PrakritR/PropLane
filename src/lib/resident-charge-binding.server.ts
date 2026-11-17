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
 *  2. the charge was written by the same manager for the application's own address - and only while that
 *     (manager, address) pair belongs to this subject ALONE. A reused address is never ownership: the moment the
 *     same manager has that address on another subject's application the pair is dropped, so each subject keeps
 *     only shape 1. An unreadable check drops the pairs too; ambiguity always means less access.
 */
export type ResidentChargeBinding = { applicationIds: string[]; managerEmails: Array<{ managerUserId: string; email: string }> };

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An address that would break out of a PostgREST filter value is not matched at all.
const SAFE_EMAIL = /^[^\s,()"'\\*%]{1,254}$/;
const MAX_APPLICATIONS = 50;

/**
 * Remove every (manager, address) pair the same manager also has on ANOTHER Auth subject's application: a shared
 * household mailbox or a re-used contact email would otherwise hand each subject the other's unpinned charges.
 * Addresses are compared as the writers store them (`resident_email` is lowercased on write, here and on the
 * charge rows these pairs are matched against). A failed read removes every pair.
 */
async function dropSharedAddressPairs(
  db: SupabaseClient,
  userId: string,
  pairs: Map<string, { managerUserId: string; email: string }>,
): Promise<void> {
  const managerIds = [...new Set([...pairs.values()].map((pair) => pair.managerUserId))];
  const emails = [...new Set([...pairs.values()].map((pair) => pair.email))];
  try {
    const { data, error } = await db
      .from("manager_application_records")
      .select("manager_user_id, resident_email, subject:row_data->>residentUserId")
      .in("manager_user_id", managerIds)
      .in("resident_email", emails)
      .limit(500);
    if (error) {
      pairs.clear();
      return;
    }
    for (const row of (data ?? []) as Array<{ manager_user_id?: unknown; resident_email?: unknown; subject?: unknown }>) {
      const subject = String(row.subject ?? "").trim();
      if (!subject || subject === userId) continue;
      pairs.delete(`${String(row.manager_user_id ?? "").trim()}|${String(row.resident_email ?? "").trim().toLowerCase()}`);
    }
  } catch {
    // Only the address shapes go: the application ids are the subject's own binding and stay.
    pairs.clear();
  }
}

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
    if (pairs.size > 0) await dropSharedAddressPairs(db, userId, pairs);
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

/**
 * The same decision as `residentBoundChargeClause`, for ONE loaded charge row: a row with no resident id of its own
 * that names one of the subject's bound applications, or was written by the same manager for that application's own
 * (unshared) address. Paying a charge must follow exactly what the resident's Payments read shows them, or a phone
 * sign-up resident (whose sign-in address is a placeholder) sees "Pay" on their own charge and is refused at checkout.
 */
export function chargeRowBoundToResident(
  row: { residentUserId: string | null; managerUserId: string; residentEmail: string; applicationId: string },
  binding: ResidentChargeBinding,
): boolean {
  if (row.residentUserId?.trim()) return false;
  const applicationId = row.applicationId.trim();
  if (applicationId && binding.applicationIds.includes(applicationId)) return true;
  const manager = row.managerUserId.trim();
  const email = row.residentEmail.trim().toLowerCase();
  if (!manager || !email) return false;
  return binding.managerEmails.some((pair) => pair.managerUserId === manager && pair.email === email);
}
