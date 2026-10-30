import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";

/** Approval alone does not prove that the applicant controls the named mailbox. */
export async function provisionApprovedResidentAccount(
  _supabase: SupabaseClient,
  row: DemoApplicantRow,
  _options?: { mode: "silent_migration" },
): Promise<{ ok: true; userId: string; created: boolean } | { ok: false; error: string; reason?: "invitation_required" }> {
  void _options;
  if (row.bucket !== "approved") return { ok: false, error: "Application is not approved." };
  const email = row.email?.trim() || row.application?.email?.trim() || "";
  if (!email || !email.includes("@")) return { ok: false, error: "Approved application is missing a resident email." };
  return { ok: false, reason: "invitation_required", error: "Resident invitation required: mailbox verification is required before access." };
}
