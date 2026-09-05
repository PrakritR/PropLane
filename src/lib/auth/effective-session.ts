import { cache } from "react";
import { getAdminPreviewFromCookies, isAdminUser } from "@/lib/auth/admin-preview";
import type { PreviewPortal } from "@/lib/auth/preview-types";
import { getPortalAccessContext, hasAdminRole, hasRole } from "@/lib/auth/portal-access";
import { isPrimaryAdminEmail } from "@/lib/auth/primary-admin";
import type { ServerProfile } from "@/lib/auth/server-profile";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

/**
 * Session + profile for the user whose portal is being viewed (real login or admin preview).
 */
export const getEffectiveSessionForPortal = cache(async (
  portal: PreviewPortal,
): Promise<{ user: { id: string; email?: string | null } | null; profile: ServerProfile | null }> => {
  const ctx = await getPortalAccessContext();
  if (!ctx.user) return { user: null, profile: null };

  const preview = await getAdminPreviewFromCookies();
  if (hasAdminRole(ctx) && preview?.portal === portal) {
    /** Stale preview cookies + `axis_active_portal=manager` would otherwise load another user's profile on /pro. */
    const actingSelfInThisPortal = ctx.effectiveRole === portal && hasRole(ctx, portal);
    if (actingSelfInThisPortal) {
      return { user: ctx.user, profile: ctx.profile };
    }

    const adminOk = await isAdminUser(ctx.user.id);
    if (!adminOk) return { user: ctx.user, profile: ctx.profile };

    const supabase = createSupabaseServiceRoleClient();
    const { data: profile } = await supabase.from("profiles").select("*").eq("id", preview.targetUserId).maybeSingle();
    const { data: roleRow } = await supabase
      .from("profile_roles")
      .select("role")
      .eq("user_id", preview.targetUserId)
      .eq("role", portal)
      .maybeSingle();
    if (!profile || (profile.role !== portal && !roleRow)) {
      return { user: ctx.user, profile: ctx.profile };
    }
    return {
      user: { id: profile.id, email: profile.email },
      profile: profile as ServerProfile,
    };
  }

  return { user: ctx.user, profile: ctx.profile };
});

export const getEffectiveUserIdForPortal = cache(async (portal: PreviewPortal): Promise<string | null> => {
  const ctx = await getPortalAccessContext();
  if (!ctx.user) return null;

  const preview = await getAdminPreviewFromCookies();

  if (hasAdminRole(ctx)) {
    if (preview?.portal === portal) {
      const actingSelfInThisPortal = ctx.effectiveRole === portal && hasRole(ctx, portal);
      if (actingSelfInThisPortal) {
        return ctx.user.id;
      }
      return preview.targetUserId;
    }
    /** Admin acting as themselves in a portal they also hold (no preview cookies). */
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
