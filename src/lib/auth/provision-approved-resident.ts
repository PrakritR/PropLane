import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { findAuthUserIdByEmail } from "@/lib/auth/find-auth-user-id-by-email";
import { primaryRoleWhenAddingResident } from "@/lib/auth/profile-primary-role";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { randomBytes } from "node:crypto";

export const AUTO_RESIDENT_PASSWORD = "123Password$";

export async function provisionApprovedResidentAccount(
  supabase: SupabaseClient,
  row: DemoApplicantRow,
  options?: { mode: "silent_migration" },
): Promise<{ ok: true; userId: string; created: boolean } | { ok: false; error: string }> {
  if (row.bucket !== "approved") return { ok: false, error: "Application is not approved." };

  const email = row.email?.trim().toLowerCase() || row.application?.email?.trim().toLowerCase() || "";
  if (!email || !email.includes("@")) return { ok: false, error: "Approved application is missing a resident email." };

  const axisId = normalizeApplicationAxisId(row.id);
  const fullName = row.name?.trim() || row.application?.fullLegalName?.trim() || null;

  let userId = await findAuthUserIdByEmail(supabase, email);
  let created = false;

  if (!userId) {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password: options?.mode === "silent_migration" ? randomBytes(32).toString("base64url") : AUTO_RESIDENT_PASSWORD,
      email_confirm: options?.mode !== "silent_migration",
      user_metadata: {
        role: "resident",
        axis_id: axisId,
        auto_provisioned_resident: true,
      },
    });
    if (error) return { ok: false, error: error.message };
    if (!data.user?.id) return { ok: false, error: "Could not create resident auth user." };
    userId = data.user.id;
    created = true;
  } else if (options?.mode !== "silent_migration") {
    const { data: existingAuth } = await supabase.auth.admin.getUserById(userId);
    const metadata = existingAuth.user?.user_metadata as Record<string, unknown> | undefined;
    await supabase.auth.admin.updateUserById(userId, {
      email_confirm: true,
      user_metadata: {
        ...(metadata ?? {}),
        role: "resident",
        axis_id: axisId,
      },
    });
  }

  const { data: existingProfile, error: profileReadError } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (profileReadError) return { ok: false, error: profileReadError.message };
  if (options?.mode === "silent_migration") {
    // Auth triggers may already have created a profile. Never rewrite a role,
    // identity or manager relationship on an account imported by email.
    if (!existingProfile) {
      const { error } = await supabase.from("profiles").upsert({ id: userId, email, role: "resident", manager_id: axisId, full_name: fullName, application_approved: true }, { onConflict: "id", ignoreDuplicates: true });
      if (error) return { ok: false, error: error.message };
    } else {
      const { error } = await supabase.from("profiles").update({ application_approved: true }).eq("id", userId);
      if (error) return { ok: false, error: error.message };
    }
    await ensureProfileRoleRow(supabase, userId, "resident");
    return { ok: true, userId, created };
  }
  const { error: profileError } = await supabase.from("profiles").upsert(
    {
      id: userId,
      email,
      role: primaryRoleWhenAddingResident(existingProfile?.role as string | undefined),
      manager_id: existingProfile?.manager_id?.trim() || axisId,
      full_name: existingProfile?.full_name || fullName,
      application_approved: true,
    },
    { onConflict: "id" },
  );
  if (profileError) return { ok: false, error: profileError.message };

  await ensureProfileRoleRow(supabase, userId, "resident");
  return { ok: true, userId, created };
}
