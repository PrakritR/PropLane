import "server-only";

import { redirect } from "next/navigation";
import { getServerSessionProfile } from "@/lib/auth/server-profile";
import { getOwnerAccessState, type OwnerAccessState } from "@/lib/property-owner/access.server";
import { OWNER_HOME_PATH } from "@/lib/property-owner/sections";

/**
 * Page-level gate for `/portal/owner/*`. Someone with no owner membership is
 * sent back to their own dashboard; Messages is reachable only while it is on.
 */
export async function requireOwnerPage(section?: "messages"): Promise<{ name: string | null; email: string | null }> {
  const { user, profile } = await getServerSessionProfile();
  if (!user) redirect("/auth/sign-in");
  let state: OwnerAccessState | null = null;
  try {
    state = await getOwnerAccessState(user.id);
  } catch {
    // Unreadable membership: stay on the owner page (every figure here comes
    // from /api/owner/*, which denies on its own) rather than send anyone to a
    // manager dashboard, and keep Messages shut because we cannot see the key.
    if (section === "messages") redirect(OWNER_HOME_PATH);
  }
  if (state) {
    // A revoked owner-only account stays here and sees the empty state.
    if (!state.hasOwnerAccess && !state.ownerOnly) redirect("/portal/dashboard");
    if (section === "messages" && !state.messagesOn) redirect(OWNER_HOME_PATH);
  }
  return { name: profile?.full_name ?? null, email: profile?.email ?? user.email ?? null };
}
