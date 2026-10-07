import "server-only";

import { getAdminPreviewFromCookies } from "@/lib/auth/admin-preview";
import { getServerSessionProfile } from "@/lib/auth/server-profile";

export type ViewAsBannerState = {
  /** Who is being viewed: full name, else email. */
  name: string;
  portal: "manager" | "resident" | "vendor";
  /** Session expiry, epoch milliseconds. */
  expiresAtMs: number;
  /** Where End lands: the viewed account's record in the admin console. */
  endHref: string;
};

/**
 * What the persistent "Viewing as" banner needs, or null when this request is
 * not a view-as session. Layouts call it once; null renders nothing.
 */
export async function getViewAsBannerState(): Promise<ViewAsBannerState | null> {
  const preview = await getAdminPreviewFromCookies();
  if (!preview) return null;
  const { profile, user } = await getServerSessionProfile();
  const name = profile?.full_name?.trim() || profile?.email || user?.email || "this account";
  return {
    name,
    portal: preview.portal,
    expiresAtMs: preview.exp * 1000,
    endHref: `/admin/axis-users/${encodeURIComponent(`${preview.portal}-${preview.targetUserId}`)}`,
  };
}

/** True while the AI assistant, push registration and other side-effect UI must stay off. */
export async function isViewingAs(): Promise<boolean> {
  return (await getAdminPreviewFromCookies()) !== null;
}
