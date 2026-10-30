import { pendingAccountRecovery } from "@/lib/auth/account-recovery.server";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { isPrimaryAdminEmail } from "@/lib/auth/primary-admin";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { User } from "@supabase/supabase-js";

type ServiceDb = ReturnType<typeof createSupabaseServiceRoleClient>;

function normalizeEmail(email: string | null | undefined): string {
  return email?.trim().toLowerCase() ?? "";
}

function hasProvider(user: User, provider: string): boolean {
  return (user.identities ?? []).some((identity) => identity.provider === provider);
}

/** All auth users registered with this email (email + Google duplicates). */
export async function findAuthUsersByEmail(db: ServiceDb, email: string): Promise<User[]> {
  const normal = normalizeEmail(email);
  if (!normal) return [];

  const { data, error } = await db.auth.admin.listUsers({ perPage: 1000 });
  if (error || !data?.users?.length) return [];
  return data.users.filter((user) => normalizeEmail(user.email) === normal);
}

function oauthFullName(user: User): string | null {
  const meta = user.user_metadata ?? {};
  const fullName = typeof meta.full_name === "string" ? meta.full_name.trim() : "";
  if (fullName) return fullName;
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  return name || null;
}

async function syncProfileForUser(db: ServiceDb, user: User): Promise<void> {
  const email = normalizeEmail(user.email);
  if (!email) return;

  const fullName = oauthFullName(user);
  const { data: existing } = await db.from("profiles").select("*").eq("id", user.id).maybeSingle();

  if (existing) {
    const patch: { email: string; full_name?: string } = { email };
    if (!existing.full_name?.trim() && fullName) patch.full_name = fullName;
    const { error } = await db.from("profiles").update(patch).eq("id", user.id);
    if (error) throw error;
    if (isPrimaryAdminEmail(email)) {
      await ensureProfileRoleRow(db, user.id, "manager");
    }
    return;
  }

  if (!isPrimaryAdminEmail(email)) return;

  const { error: profileError } = await db.from("profiles").upsert(
    {
      id: user.id,
      email,
      role: "admin",
      full_name: fullName,
      manager_id: null,
      application_approved: true,
    },
    { onConflict: "id" },
  );
  if (profileError) throw profileError;

  await ensureProfileRoleRow(db, user.id, "admin");
  await ensureProfileRoleRow(db, user.id, "manager");
}

/** Synchronize this verified Auth user's own profile and roles only. */
export async function reconcileAuthAccountsByEmail(db: ServiceDb, sessionUser: User): Promise<void> {
  const email = normalizeEmail(sessionUser.email);
  if (!email || !sessionUser.email_confirmed_at) return;

  if (await pendingAccountRecovery(db, sessionUser.id)) return;
  await syncProfileForUser(db, sessionUser);

  const { data: profile } = await db.from("profiles").select("role").eq("id", sessionUser.id).maybeSingle();
  const role = String(profile?.role ?? sessionUser.user_metadata?.role ?? "").toLowerCase();
  if (role === "manager" || role === "pro") {
    await ensureProfileRoleRow(db, sessionUser.id, "manager");
  }
  if (role === "resident") {
    await ensureProfileRoleRow(db, sessionUser.id, "resident");
  }
  if (role === "admin" || isPrimaryAdminEmail(email)) {
    await ensureProfileRoleRow(db, sessionUser.id, "admin");
  }
  if (isPrimaryAdminEmail(email)) {
    await ensureProfileRoleRow(db, sessionUser.id, "manager");
  }

  if (hasProvider(sessionUser, "google")) {
    await db.auth.admin.updateUserById(sessionUser.id, {
      user_metadata: {
        ...(sessionUser.user_metadata ?? {}),
        google_linked_at: new Date().toISOString(),
      },
    });
  }
}
