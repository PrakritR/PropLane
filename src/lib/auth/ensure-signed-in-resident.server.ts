import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePortalRoles } from "@/lib/auth/portal-roles";
import { primaryRoleWhenAddingResident } from "@/lib/auth/profile-primary-role";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { normalizeE164 } from "@/lib/phone-e164";
import {
  linkAllTourInquiriesForEmail,
  reconcileProspectInboxThreadsForResident,
} from "@/lib/tour-resident-link.server";

function normalizeEmail(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export type EnsureSignedInResidentResult =
  | { ok: true; createdResidentRole: boolean; email: string }
  | { ok: false; error: string };

/**
 * Add the resident role to the signed-in account when missing, then backfill
 * tour links and Communication threads for the account email.
 */
export async function ensureSignedInResidentAccount(
  service: SupabaseClient,
  user: { id: string; email?: string | null; user_metadata?: Record<string, unknown> | null },
  options?: { contactEmail?: string | null; phone?: string | null },
): Promise<EnsureSignedInResidentResult> {
  const { data: existingProfile } = await service
    .from("profiles")
    .select("role, email, full_name, phone")
    .eq("id", user.id)
    .maybeSingle();

  const authEmail = normalizeEmail(existingProfile?.email ?? user.email);
  if (!authEmail.includes("@")) {
    return { ok: false, error: "Profile email is required." };
  }
  const requestedContact = normalizeEmail(options?.contactEmail);
  const contactEmail =
    requestedContact && requestedContact === authEmail ? requestedContact : authEmail;

  // The name and number typed at signup live only in auth metadata until a profile row exists (the role step
  // creates it). Carry them over so holds, notices and Profile do not say "Guest" / "—". The phone stays
  // unverified until its code is entered.
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const signupName = typeof meta.full_name === "string" ? meta.full_name.trim().slice(0, 200) : "";
  const signupPhone = normalizeE164(typeof meta.phone === "string" ? meta.phone : "");

  const { data: existingRoleRows } = await service.from("profile_roles").select("role").eq("user_id", user.id);
  const currentRoles = normalizePortalRoles(existingRoleRows, existingProfile?.role as string | undefined);
  const hadResidentRole = currentRoles.includes("resident");

  if (!hadResidentRole) {
    const nextPrimaryRole = primaryRoleWhenAddingResident(existingProfile?.role as string | undefined);
    if (!existingProfile) {
      const { error } = await service
        .from("profiles")
        .insert({ id: user.id, email: contactEmail, role: nextPrimaryRole, ...(signupName ? { full_name: signupName } : {}) });
      if (error) return { ok: false, error: error.message };
    } else if (nextPrimaryRole !== existingProfile.role) {
      const { error } = await service.from("profiles").update({ role: nextPrimaryRole }).eq("id", user.id);
      if (error) return { ok: false, error: error.message };
    }

    for (const role of currentRoles) {
      if (role !== "resident") {
        await ensureProfileRoleRow(service, user.id, role);
      }
    }
    await ensureProfileRoleRow(service, user.id, "resident");
  }

  // Best-effort backfill onto a row that already existed without them; never overwrites a value.
  const backfill: Record<string, string> = {};
  if (existingProfile && !String(existingProfile.full_name ?? "").trim() && signupName) backfill.full_name = signupName;
  if (signupPhone && !String(existingProfile?.phone ?? "").trim()) backfill.phone = signupPhone;
  if (Object.keys(backfill).length > 0) {
    await service.from("profiles").update(backfill).eq("id", user.id).is(backfill.phone ? "phone" : "full_name", null);
  }

  await linkAllTourInquiriesForEmail(service, { userId: user.id, email: contactEmail });
  await reconcileProspectInboxThreadsForResident(service, {
    userId: user.id,
    contactEmail,
    authEmail: contactEmail !== authEmail ? authEmail : undefined,
    phone: options?.phone,
  });

  return { ok: true, createdResidentRole: !hadResidentRole, email: contactEmail };
}
