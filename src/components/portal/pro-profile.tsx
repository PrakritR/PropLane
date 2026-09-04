import { PortalProfileClient } from "@/components/portal/portal-profile-client";
import { getServerSessionProfile } from "@/lib/auth/server-profile";

function dash(s: string | null | undefined) {
  const t = (s ?? "").trim();
  return t.length ? t : "—";
}

export async function ManagerProfile() {
  const { profile, user } = await getServerSessionProfile();

  return (
    <PortalProfileClient
      variant="manager"
      portalKind="pro"
      initialFullName={dash(profile?.full_name)}
      initialEmail={dash(profile?.email ?? user?.email)}
      initialPhone={dash(profile?.phone)}
      idLabel="PropLane ID"
      idValue={dash(profile?.manager_id)}
    />
  );
}
