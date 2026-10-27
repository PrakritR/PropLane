import { PortalProfileClient } from "@/components/portal/portal-profile-client";
import { getServerSessionProfile } from "@/lib/auth/server-profile";
import { loadPortalSettingsScope } from "@/lib/admin-team/settings-scope.server";

function dash(s: unknown) {
  const t = typeof s === "string" ? s.trim() : "";
  return t.length ? t : "—";
}

export async function ManagerProfile() {
  const { profile, user, viewAs } = await getServerSessionProfile();
  // Service mode only: the Settings scope dropdown (PropLane / each workspace) is for PropLane staff, never a View-as session.
  const settingsScope = user && !viewAs ? await loadPortalSettingsScope(user.id) : null;

  return (
    <PortalProfileClient
      variant="manager"
      portalKind="pro"
      initialFullName={dash(profile?.full_name)}
      initialEmail={dash(profile?.email ?? user?.email)}
      initialPhone={dash(profile?.phone)}
      initialPhoneVerified={Boolean(profile?.phone_verified_at)}
      idLabel="PropLane ID"
      idValue={dash(profile?.manager_id)}
      settingsScope={settingsScope}
    />
  );
}
