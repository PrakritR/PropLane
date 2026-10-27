import { AdminProfileClient } from "@/components/portal/admin-profile-client";
import { getServerSessionProfile } from "@/lib/auth/server-profile";
import { loadAdminSettingsScope } from "@/lib/admin-team/settings-scope.server";

/** Avoid `.trim()` on non-strings from DB/JSON edge cases (would throw in RSC). */
function safeLine(value: unknown): string {
  const t = String(value ?? "").trim();
  return t.length ? t : "—";
}

function adminAxisIdFrom(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "—";
  const compact = raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return `PROPLANE-A-${compact.slice(0, 8)}`;
}

/**
 * Admin profile — isolated server fetch with safe coercion so transient Supabase/auth
 * issues or odd row shapes don’t take down the whole `/admin/profile` segment.
 */
export async function AdminProfileSection() {
  let profile: Awaited<ReturnType<typeof getServerSessionProfile>>["profile"];
  let user: Awaited<ReturnType<typeof getServerSessionProfile>>["user"];

  try {
    ({ profile, user } = await getServerSessionProfile());
  } catch {
    return (
      <AdminProfileClient
        fullName="—"
        email="—"
        phone="—"
        adminId="—"
      />
    );
  }

  const settingsScope = user ? await loadAdminSettingsScope(user.id) : null;
  return (
    <AdminProfileClient
      settingsScope={settingsScope}
      fullName={safeLine(profile?.full_name)}
      email={safeLine(profile?.email ?? user?.email)}
      phone={safeLine(profile?.phone)}
      phoneVerified={Boolean(profile?.phone_verified_at)}
      adminId={adminAxisIdFrom(profile?.id ?? user?.id)}
    />
  );
}
