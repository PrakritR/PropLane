import { cache } from "react";
import { getAdminPreviewFromCookies } from "@/lib/auth/admin-preview";
import type { PreviewPortal } from "@/lib/auth/preview-types";
import { getPortalAccessContext, hasAdminRole, hasRole } from "@/lib/auth/portal-access";
import { isPrimaryAdminEmail } from "@/lib/auth/primary-admin";
import type { ServerProfile } from "@/lib/auth/server-profile";

/**
 * Session + profile for the user whose portal is being viewed.
 *
 * While a verified "View as" session is open for THIS portal, the portal access
 * context already resolves as the viewed account (see `getPortalAccessContext`
 * and `createSupabaseServerClient`), so the viewed account is returned as-is.
 * Otherwise it is the signed-in user. There is no cookie that can name an
 * arbitrary account any more: the old "admin acting as themselves" bypass is
 * gone, because a session is now explicit, signed, bounded and bannered.
 */
export const getEffectiveSessionForPortal = cache(async (
  portal: PreviewPortal,
): Promise<{ user: { id: string; email?: string | null } | null; profile: ServerProfile | null }> => {
  const ctx = await getPortalAccessContext();
  if (!ctx.user) return { user: null, profile: null };
  return { user: ctx.user, profile: ctx.profile };
});

export const getEffectiveUserIdForPortal = cache(async (portal: PreviewPortal): Promise<string | null> => {
  const ctx = await getPortalAccessContext();
  if (!ctx.user) return null;

  const preview = await getAdminPreviewFromCookies();
  if (preview?.portal === portal) return preview.targetUserId;

  if (hasAdminRole(ctx)) {
    /** Admin acting as themselves in a portal they also hold. */
    if (hasRole(ctx, portal)) {
      return ctx.user.id;
    }
    /** Primary admin may co-manage via accepted links even before manager role backfill lands. */
    if (portal === "manager" && isPrimaryAdminEmail(ctx.user?.email)) {
      return ctx.user.id;
    }
    return null;
  }

  return ctx.user.id;
});
