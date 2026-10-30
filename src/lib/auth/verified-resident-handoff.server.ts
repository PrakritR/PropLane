import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { openApplicantRow } from "@/lib/security/applicant-identity";
import { normalizeE164 } from "@/lib/twilio";
import { pendingAccountRecovery } from "@/lib/auth/account-recovery.server";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { attachInboxThreadsToResident } from "@/lib/tour-resident-link.server";

/** Idempotent verified handoff. Existing profile fields are never copied from a stale read. */
export async function provisionVerifiedResidentHandoff(db: SupabaseClient, input: { userId: string; email: string; applicationId?: string | null }): Promise<boolean> {
  const email = input.email.trim().toLowerCase();
  const { data: auth, error: authError } = await db.auth.admin.getUserById(input.userId);
  if (authError || !auth.user?.email_confirmed_at || auth.user.email?.trim().toLowerCase() !== email) return false;
  if (await pendingAccountRecovery(db, input.userId)) return false;
  let name: string | null = null;
  let phone: string | null = null;
  if (input.applicationId) {
    const { data: app, error } = await db.from("manager_application_records").select("resident_email, row_data").eq("id", input.applicationId).maybeSingle();
    if (error || !app || String(app.resident_email ?? "").trim().toLowerCase() !== email) return false;
    const opened = openApplicantRow(app.row_data, input.applicationId);
    const rawName = opened.name ?? opened.application?.fullLegalName;
    const rawPhone = opened.application?.phone;
    name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : null;
    phone = typeof rawPhone === "string" ? normalizeE164(rawPhone) : null;
  }
  // Do not copy approval from a separately read application: it may have been
  // withdrawn concurrently. Resident stage access resolves the live application.
  // Legacy consumers of profiles.application_approved may need separate repair.
  const inserted = await db.from("profiles").upsert({ id: input.userId, email, role: "resident", manager_id: input.applicationId || null, full_name: name, phone, application_approved: false }, { onConflict: "id", ignoreDuplicates: true });
  if (inserted.error) throw inserted.error;
  if (input.applicationId) {
    const manager = await db.from("profiles").update({ manager_id: input.applicationId }).eq("id", input.userId).eq("role", "resident").is("manager_id", null);
    if (manager.error) throw manager.error;
  }
  await ensureProfileRoleRow(db, input.userId, "resident");
  await attachInboxThreadsToResident(db, input.userId, email);
  return true;
}
