import { pendingAccountRecovery } from "@/lib/auth/account-recovery.server";
import { findAuthUserIdByEmail } from "@/lib/auth/find-auth-user-id-by-email";
import { migratePortalUserId } from "@/lib/auth/migrate-portal-user-id";
import { primaryRoleWhenAddingResident } from "@/lib/auth/profile-primary-role";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { attachInboxThreadsToResident } from "@/lib/tour-resident-link.server";
import { normalizeE164 } from "@/lib/twilio";
import { generateAxisId } from "@/lib/manager-id";
import type { SupabaseClient } from "@supabase/supabase-js";

type ApplicationRow = {
  id: string;
  resident_email: string | null;
  row_data: unknown;
};

function applicationApproved(row: ApplicationRow): boolean {
  const rowData =
    row.row_data && typeof row.row_data === "object" && !Array.isArray(row.row_data)
      ? (row.row_data as Record<string, unknown>)
      : null;
  return String(rowData?.bucket ?? "").toLowerCase() === "approved";
}

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

async function findApplicationByEmail(
  supabase: SupabaseClient,
  email: string,
): Promise<ApplicationRow | null> {
  const { data, error } = await supabase
    .from("manager_application_records")
    .select("id, resident_email, row_data")
    .eq("resident_email", email)
    .order("updated_at", { ascending: false })
    .limit(5);

  if (error) throw new Error(error.message);
  const rows = (data ?? []) as ApplicationRow[];
  if (rows.length === 0) return null;
  return rows.find((row) => applicationApproved(row)) ?? rows[0] ?? null;
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
  const matchingApplication =
    opts.inheritFromApplication === true ? await findApplicationByEmail(supabase, normalEmail) : null;
  const linkedApplication = Boolean(matchingApplication);

  const existingAuthId = await findAuthUserIdByEmail(supabase, normalEmail);
  if (existingAuthId && existingAuthId !== opts.userId) {
    await migratePortalUserId(supabase, existingAuthId, opts.userId);
  }

  const { data: existingAuth } = await supabase.auth.admin.getUserById(opts.userId);
  const metadata = existingAuth.user?.user_metadata as Record<string, unknown> | undefined;
  const axisId = matchingApplication?.id ?? metadata?.axis_id?.toString() ?? generateAxisId();

  await supabase.auth.admin.updateUserById(opts.userId, {
    email_confirm: true,
    user_metadata: {
      ...(metadata ?? {}),
      role: "resident",
      axis_id: axisId,
      auto_provisioned_resident: !linkedApplication,
    },
  });

  const { data: existingProfile } = await supabase.from("profiles").select("*").eq("id", opts.userId).maybeSingle();
  const approved =
    (matchingApplication ? applicationApproved(matchingApplication) : false) ||
    Boolean(existingProfile?.application_approved);

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
      phone:
        explicitPhone ||
        (existingProfile?.phone as string | null)?.trim() ||
        (matchingApplication ? normalizeE164(applicationPhone(matchingApplication) ?? "") : null) ||
        null,
      application_approved: approved,
    },
    { onConflict: "id" },
  );
  if (upErr) {
    return { ok: false, status: 500, error: upErr.message };
  }

  await ensureProfileRoleRow(supabase, opts.userId, "resident");
  await attachInboxThreadsToResident(supabase, opts.userId, normalEmail).catch(() => undefined);
  return { ok: true, axisId, linkedApplication };
}
