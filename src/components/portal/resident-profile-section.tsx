import { ResidentProfilePanel } from "@/components/portal/resident-profile-panel";
import { getServerSessionProfile } from "@/lib/auth/server-profile";

/**
 * Resident Settings > Profile is hydrated from the same server session as the
 * portal shell. The panel still refreshes in the browser, but it must not
 * depend on client-only auth to show name, email, and PropLane ID.
 */
export async function ResidentProfileSection() {
  const { profile, user } = await getServerSessionProfile();

  return (
    <ResidentProfilePanel
      initialUserId={user?.id ?? null}
      initialEmail={(profile?.email ?? user?.email ?? "").trim()}
      initialFullName={(profile?.full_name ?? "").trim()}
      initialPhone={(profile?.phone ?? "").trim()}
      initialAxisId={(profile?.manager_id ?? "").trim()}
    />
  );
}
