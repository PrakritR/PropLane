import { cache } from "react";
import { userHoldsAdminRole } from "@/lib/auth/admin-role";
import { getServerSessionProfile } from "@/lib/auth/server-profile";
import type { PreviewPortal } from "@/lib/auth/preview-types";
import {
  LEGACY_PREVIEW_PORTAL_COOKIE,
  LEGACY_PREVIEW_UID_COOKIE,
  VIEW_AS_COOKIE,
} from "@/lib/auth/view-as-token";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type { PreviewPortal } from "@/lib/auth/preview-types";

/**
 * "View as" is ONE signed, expiring cookie (`axis_view_as`, see
 * `view-as-token.ts`). The two unsigned cookies this feature used to set are no
 * longer read; they are named here only so sign-out and portal switching keep
 * clearing them off browsers that still hold one.
 */
export const PREVIEW_UID_COOKIE = VIEW_AS_COOKIE;
export const PREVIEW_PORTAL_COOKIE = LEGACY_PREVIEW_PORTAL_COOKIE;
export const LEGACY_PREVIEW_UID_COOKIE_NAME = LEGACY_PREVIEW_UID_COOKIE;

export type AdminPreview = {
  targetUserId: string;
  portal: PreviewPortal;
  adminId: string;
  /** Session id: ties the cookie to its audit rows. */
  sid: string;
  /** Issued at / expires at, epoch seconds. */
  iat: number;
  exp: number;
};

/**
 * The live "View as" session for this request, or null.
 *
 * Non-null only when the cookie's signature and expiry hold, the REAL signed-in
 * user is the operator who started it, that operator is still an admin on the
 * allowlist, and the viewed account still holds the portal (all resolved once,
 * in `resolveActiveViewAs`, when the server client identified the caller). It
 * is also null on /admin and /api/admin|auth paths, where the operator is
 * themselves. Rejects nothing by portal: a vendor session is valid.
 */
export const getAdminPreviewFromCookies = cache(async (): Promise<AdminPreview | null> => {
  const { viewAs } = await getServerSessionProfile();
  if (!viewAs) return null;
  return {
    targetUserId: viewAs.targetUserId,
    portal: viewAs.portal,
    adminId: viewAs.adminId,
    sid: viewAs.sid,
    iat: viewAs.iat,
    exp: viewAs.exp,
  };
});

/**
 * Data-API admin gate. Any account holding the `admin` role qualifies (same
 * rule as the /admin portal shell — see `hasAdminRole` in portal-access.ts);
 * the primary-admin email stays admin as a fallback via `userHoldsAdminRole`.
 */
export const isAdminUser = cache(async (userId: string): Promise<boolean> => {
  const supabase = await createSupabaseServerClient();
  return userHoldsAdminRole(supabase, userId);
});
