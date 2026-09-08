import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { managerCanAccessApplicationRecord } from "@/lib/auth/manager-application-access";
import { purgeApplicationPortalData } from "@/lib/auth/purge-portal-account-data";

/** A property relationship authorizes this application, never the resident's login. */
export async function removeResidentApplication(
  db: SupabaseClient,
  actor: { userId: string; isAdmin: boolean },
  input: { applicationId: string; email?: string },
) {
  const { data: row, error } = await db.from("manager_application_records")
    .select("id,resident_email,manager_user_id,property_id,assigned_property_id")
    .eq("id", input.applicationId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!row || (!actor.isAdmin && !(await managerCanAccessApplicationRecord(db, actor.userId, row, { level: "delete" })))) {
    return { ok: false as const, status: 403, error: "Forbidden: application is not in your portfolio." };
  }
  if (input.email && input.email.trim().toLowerCase() !== String(row.resident_email ?? "").trim().toLowerCase()) {
    return { ok: false as const, status: 400, error: "The resident does not match this application." };
  }
  await purgeApplicationPortalData(db, row.id);
  return { ok: true as const, mode: "removed_application" as const };
}
