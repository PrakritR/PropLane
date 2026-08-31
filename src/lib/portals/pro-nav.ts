import { portalDashboardPath } from "@/lib/auth/portal-roles";
import { redirect } from "next/navigation";
import { getAdminPreviewFromCookies } from "@/lib/auth/admin-preview";
import { getEffectiveUserIdForPortal } from "@/lib/auth/effective-session";
import { getPortalAccessContext, hasAdminRole, hasRole } from "@/lib/auth/portal-access";
import { isManagerFreePlan, managerTierDisplayLabel, paidWorkspacePortalTitle } from "@/lib/manager-access";
import {
  getManagerPortalNavSubscriptionTier,
  getManagerPurchaseSku,
} from "@/lib/manager-access-server";
import type { PortalDefinition } from "@/lib/portal-types";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { proPortal } from "./pro";
import { cache } from "react";

export const getProPortalRenderContext = cache(async () => {
  const ctx = await getPortalAccessContext();
  if (!ctx.user) redirect("/auth/sign-in");

  const preview = await getAdminPreviewFromCookies();
  if (hasAdminRole(ctx) && preview?.portal === "manager") {
    /* admin preview as manager — allowed */
  } else if (hasAdminRole(ctx) && !hasRole(ctx, "manager")) {
    redirect("/admin/dashboard");
  } else if (!hasRole(ctx, "manager")) {
    redirect("/auth/sign-in");
  } else if (ctx.roles.length > 1 && ctx.effectiveRole === null) {
    redirect(`/auth/choose-portal?next=${encodeURIComponent("/portal/dashboard")}`);
  } else if (ctx.effectiveRole !== null && ctx.effectiveRole !== "manager") {
    redirect(portalDashboardPath(ctx.effectiveRole));
  }

  const effectiveUserId = await getEffectiveUserIdForPortal("manager");
  if (!effectiveUserId) redirect("/admin/dashboard");

  const purchase = await getManagerPurchaseSku(effectiveUserId);
  const subscriptionTier = await getManagerPortalNavSubscriptionTier(effectiveUserId);
  const portalTitle = paidWorkspacePortalTitle(purchase.tier, purchase.stripeSubscriptionId);
  const isFree = isManagerFreePlan(subscriptionTier);

  return {
    ctx,
    preview,
    effectiveUserId,
    purchase,
    portalTitle,
    isFree,
    subscriptionTier,
  };
});

export const buildProPortalDefinition = cache(async (): Promise<{
  definition: PortalDefinition;
  showPlanBanner: boolean;
  showPreviewBanner: boolean;
  previewLabel: string | null;
  subscriptionTier: "free" | "paid" | null;
  /** Sidebar header badge: the manager's current plan (Free / Pro / Business). */
  planLabel: string;
}> => {
  const { ctx, preview, portalTitle, isFree, subscriptionTier, purchase } = await getProPortalRenderContext();
  const planLabel = isFree ? "Free" : managerTierDisplayLabel(purchase.tier);

  const showPreviewBanner = hasAdminRole(ctx) && !!preview?.targetUserId;

  let previewLabel: string | null = null;
  if (showPreviewBanner && preview) {
    const supabase = createSupabaseServiceRoleClient();
    const { data: p } = await supabase
      .from("profiles")
      .select("full_name, email")
      .eq("id", preview.targetUserId)
      .maybeSingle();
    previewLabel = p?.full_name?.trim() || p?.email || preview.targetUserId;
  }

  return {
    definition: { ...proPortal, sections: proPortal.sections, title: portalTitle },
    showPlanBanner: isFree,
    showPreviewBanner,
    previewLabel,
    subscriptionTier,
    planLabel,
  };
});
