import { pendingAccountRecovery } from "@/lib/auth/account-recovery.server";
import { findAuthUserIdByEmail } from "@/lib/auth/find-auth-user-id-by-email";
import { primaryRoleWhenAddingResident } from "@/lib/auth/profile-primary-role";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { normalizeE164 } from "@/lib/twilio";
import { generateAxisId } from "@/lib/manager-id";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSharedLineConfig } from "@/lib/one-number/config.server";
import { legacyPhoneWriteDecision, VERIFIED_PHONE_CHANGE_MESSAGE } from "@/lib/auth/legacy-phone-write";

type ApplicationRow = {
  id: string;
  resident_email: string | null;
  row_data: unknown;
};

function applicationPhone(row: ApplicationRow): string | null {
  const rowData =
    row.row_data && typeof row.row_data === "object" && !Array.isArray(row.row_data)
      ? (row.row_data as Record<string, unknown>)
      : null;
  const application =
    rowData?.application && typeof rowData.application === "object" && !Array.isArray(rowData.application)
      ? (rowData.application as Record<string, unknown>)
      : null;
  const raw = application?.phone ?? rowData?.phone;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function applicationName(row: ApplicationRow): string | null {
  const rowData =
    row.row_data && typeof row.row_data === "object" && !Array.isArray(row.row_data)
      ? (row.row_data as Record<string, unknown>)
      : null;
  return typeof rowData?.name === "string" ? rowData.name : null;
}

async function findApplicationById(
  supabase: SupabaseClient,
  email: string,
  applicationId: string,
): Promise<ApplicationRow | null> {
  const { data, error } = await supabase.from("manager_application_records")
    .select("id, resident_email, row_data").eq("id", applicationId).eq("resident_email", email).maybeSingle();
  if (error) throw new Error(error.message);
  return data as ApplicationRow | null;
}

export type ProvisionResidentResult =
  | { ok: true; axisId: string; linkedApplication: boolean }
  | { ok: false; status: number; error: string };

/**
 * Resident account provisioning — links by email when an application exists.
 *
 * **Default-deny inheritance.** Inheriting a matching application's identity and
 * approval requires PROVEN email control, so a caller must OPT IN with
 * `inheritFromApplication: true`. Only the setup-token and OAuth flows (which
 * prove control) pass it. The default — and anything that forgets the flag,
 * including the anonymous self-serve `resident-register` path — inherits NOTHING:
 * a clean profile (`application_approved=false`, no application PII, no link),
 * so a failure to prove control can never accidentally claim a prior applicant's
 * application.
 */
export async function provisionResidentAccountByEmail(
  supabase: SupabaseClient,
  opts: {
    userId: string;
    email: string;
    fullName?: string | null;
    phone?: string | null;
    inheritFromApplication?: boolean;
    /**
     * Has the caller proved control of `email`? `false` means the
     * address is a claim or a placeholder: no application inheritance, no merging of another account
     * that owns the address, no attaching the address's inbox threads.
     */
    emailProven: boolean;
    applicationId?: string;
  },
): Promise<ProvisionResidentResult> {
  if (await pendingAccountRecovery(supabase, opts.userId)) return { ok: false, status: 409, error: "Sign in to recover your saved account or start fresh before continuing setup." };
  const normalEmail = opts.email.trim().toLowerCase();
  if (!normalEmail.includes("@")) {
    return { ok: false, status: 400, error: "Enter a valid email address." };
  }
  // A phone the resident confirmed on the setup screen wins over the one from the
  // application snapshot — it is the most recent value they vouched for.
  const explicitPhone = opts.phone?.trim() ? normalizeE164(opts.phone.trim()) : null;

  // Default-deny: only an explicit opt-in (proven email control) looks up the
  // application at all. Otherwise `matchingApplication` stays null and every
  // downstream field treats it as a clean, un-inheriting profile.
  const emailProven = opts.emailProven === true;
  if (emailProven) {
    const { data, error } = await supabase.auth.admin.getUserById(opts.userId);
    if (error || !data.user?.email_confirmed_at || data.user.email?.trim().toLowerCase() !== normalEmail) {
      return { ok: false, status: 403, error: "Sign in with your verified email before continuing." };
    }
  }
  if (opts.inheritFromApplication && (!emailProven || !opts.applicationId)) {
    return { ok: false, status: 403, error: "A verified application is required." };
  }
  const matchingApplication = opts.inheritFromApplication && opts.applicationId
    ? await findApplicationById(supabase, normalEmail, opts.applicationId) : null;
  if (opts.inheritFromApplication && !matchingApplication) {
    return { ok: false, status: 403, error: "Application email could not be verified." };
  }
  const linkedApplication = Boolean(matchingApplication);

  const shared = (await loadSharedLineConfig(supabase)).mode === "shared";
  if (shared) {
    const { data: profile, error } = await supabase.from("profiles").select("phone, phone_verified_at").eq("id", opts.userId).maybeSingle();
    if (error) return { ok: false, status: 503, error: "Could not load your profile." };
    if (legacyPhoneWriteDecision(profile, explicitPhone || profile?.phone || null, true).blocked) {
      return { ok: false, status: 409, error: VERIFIED_PHONE_CHANGE_MESSAGE };
    }
  }

  const existingAuthId = emailProven ? await findAuthUserIdByEmail(supabase, normalEmail) : null;
  if (existingAuthId && existingAuthId !== opts.userId) {
    return { ok: false, status: 403, error: "Sign in with the account that owns this email before continuing." };
  }

  const { data: existingAuth } = await supabase.auth.admin.getUserById(opts.userId);
  const metadata = existingAuth.user?.user_metadata as Record<string, unknown> | undefined;
  const axisId = matchingApplication?.id ?? metadata?.axis_id?.toString() ?? generateAxisId();

  await supabase.auth.admin.updateUserById(opts.userId, {
    user_metadata: {
      ...(metadata ?? {}),
      role: "resident",
      axis_id: axisId,
      auto_provisioned_resident: !linkedApplication,
    },
  });

  const { data: existingProfile, error: profileReadError } = await supabase.from("profiles").select("*").eq("id", opts.userId).maybeSingle();
  if (profileReadError) return { ok: false, status: 503, error: "Could not load your profile." };
  const phoneDecision = legacyPhoneWriteDecision(existingProfile,
    explicitPhone || (existingProfile?.phone as string | null)?.trim() ||
    (matchingApplication ? normalizeE164(applicationPhone(matchingApplication) ?? "") : null) || null,
    shared);
  if (phoneDecision.blocked) return { ok: false, status: 409, error: VERIFIED_PHONE_CHANGE_MESSAGE };

  const { error: upErr } = await supabase.from("profiles").upsert(
    {
      id: opts.userId,
      email: normalEmail,
      role: primaryRoleWhenAddingResident(existingProfile?.role as string | undefined),
      full_name:
        opts.fullName?.trim() ||
        existingProfile?.full_name ||
        (matchingApplication ? applicationName(matchingApplication) : null),
      manager_id: existingProfile?.manager_id?.trim() || axisId,
      // Notifications text this number automatically — carry the phone the
      // resident gave on their rental application onto the profile.
      phone: phoneDecision.phone,
      ...(phoneDecision.clearVerification ? { phone_verified_at: null } : {}),
      // Never overwrite an existing approval flag from a stale profile read.
      ...(existingProfile ? {} : { application_approved: false }),
    },
    { onConflict: "id" },
  );
  if (upErr) {
    return { ok: false, status: 500, error: upErr.message };
  }

  await ensureProfileRoleRow(supabase, opts.userId, "resident");
  return { ok: true, axisId, linkedApplication };
}
