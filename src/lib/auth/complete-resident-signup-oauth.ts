import { findAuthUserIdByEmail } from "@/lib/auth/find-auth-user-id-by-email";
import { migratePortalUserId } from "@/lib/auth/migrate-portal-user-id";
import { primaryRoleWhenAddingResident } from "@/lib/auth/profile-primary-role";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { generateAxisId } from "@/lib/manager-id";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import type { SupabaseClient } from "@supabase/supabase-js";

export type CompleteResidentSignupResult =
  | { ok: true; axisId: string }
  | { ok: false; status: number; error: string };

function axisIdVariants(axisId: string): string[] {
  const trimmed = axisId.trim();
  const normalized = normalizeApplicationAxisId(trimmed);
  return [...new Set([trimmed, normalized].filter(Boolean))];
}

/** Links an OAuth-authenticated user to an approved rental application (same rules as password signup). */
export async function completeResidentSignupFromOAuth(
  supabase: SupabaseClient,
  userId: string,
  userEmail: string,
  axisId: string,
): Promise<CompleteResidentSignupResult> {
  const normalEmail = userEmail.trim().toLowerCase();
  const normalAxisId = axisId.trim();

  if (!normalEmail || !normalAxisId) {
    return { ok: false, status: 400, error: "Email and application ID are required." };
  }

  const { data: verifiedAuth, error: verifiedError } = await supabase.auth.admin.getUserById(userId);
  if (verifiedError || !verifiedAuth.user?.email_confirmed_at || verifiedAuth.user.email?.trim().toLowerCase() !== normalEmail) {
    return { ok: false, status: 403, error: "Sign in with your verified email before continuing." };
  }

  const { data: applicationRows, error: applicationError } = await supabase
    .from("manager_application_records")
    .select("id, resident_email, row_data")
    .in("id", axisIdVariants(normalAxisId));

  if (applicationError) {
    return { ok: false, status: 500, error: applicationError.message };
  }

  const matchingApplication = (applicationRows ?? []).find((row) => {
    const rowEmail = row.resident_email?.trim().toLowerCase() ?? "";
    return rowEmail === normalEmail;
  });

  const matchingRowData =
    matchingApplication?.row_data && typeof matchingApplication.row_data === "object" && !Array.isArray(matchingApplication.row_data)
      ? (matchingApplication.row_data as Record<string, unknown>)
      : null;
  const applicationApproved = String(matchingRowData?.bucket ?? "").toLowerCase() === "approved";

  if (!matchingApplication) {
    const hasDifferentEmailMatch = (applicationRows ?? []).length > 0;
    return {
      ok: false,
      status: 403,
      error: hasDifferentEmailMatch
        ? "This application ID belongs to a different email address. Sign in with the same Google account used on your rental application."
        : "Application ID not found. Check the ID and try again.",
    };
  }

  const existingAuthId = await findAuthUserIdByEmail(supabase, normalEmail);
  if (existingAuthId && existingAuthId !== userId) {
    await migratePortalUserId(supabase, existingAuthId, userId);
  }

  const { data: existingAuth } = await supabase.auth.admin.getUserById(userId);
  const metadata = existingAuth.user?.user_metadata as Record<string, unknown> | undefined;
  await supabase.auth.admin.updateUserById(userId, {
    user_metadata: {
      ...(metadata ?? {}),
      role: "resident",
      axis_id: matchingApplication.id,
      auto_provisioned_resident: false,
      resident_oauth_linked_at: new Date().toISOString(),
    },
  });

  const { data: existingProfile } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
  const profileAxisId = existingProfile?.manager_id?.trim() || matchingApplication.id || normalAxisId || generateAxisId();

  const { error: upErr } = await supabase.from("profiles").upsert(
    {
      id: userId,
      email: normalEmail,
      role: primaryRoleWhenAddingResident(existingProfile?.role as string | undefined),
      full_name: existingProfile?.full_name ?? (typeof matchingRowData?.name === "string" ? matchingRowData.name : null),
      manager_id: profileAxisId,
      application_approved: applicationApproved || existingProfile?.application_approved || false,
    },
    { onConflict: "id" },
  );
  if (upErr) {
    return { ok: false, status: 500, error: upErr.message };
  }

  await ensureProfileRoleRow(supabase, userId, "resident");
  return { ok: true, axisId: profileAxisId };
}
