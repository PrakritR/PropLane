import { portalDashboardPath } from "@/lib/auth/portal-roles";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { normalizePostAuthPath } from "@/lib/auth/normalize-post-auth-path";
import { getAdminPreviewFromCookies } from "@/lib/auth/admin-preview";
import type { PreviewPortal } from "@/lib/auth/preview-types";
import { getPortalAccessContext, hasAdminRole, hasRole } from "@/lib/auth/portal-access";

async function requestedPortalPath(role: "manager" | "resident" | "vendor"): Promise<string | null> {
  const requestedPath = (await headers()).get("x-requested-path");
  return requestedPath ? normalizePostAuthPath(requestedPath, role) : null;
}

/**
 * Ensures only the correct role (or admin with matching preview cookie) can load a portal layout.
 */
export async function assertPortalLayoutRole(
  portal: PreviewPortal,
  role: "manager" | "resident" | "vendor",
  options?: { allowSignedInApplyGate?: boolean; allowResidentTourAccess?: boolean },
) {
  const ctx = await getPortalAccessContext();
  if (!ctx.user) {
    const next = await requestedPortalPath(role);
    redirect(next ? `/auth/sign-in?next=${encodeURIComponent(next)}` : "/auth/sign-in");
  }

  const preview = await getAdminPreviewFromCookies();
  if (preview?.portal === portal) {
    return;
  }

  const applyGateBypass =
    options?.allowSignedInApplyGate === true && portal === "resident" && Boolean(ctx.user);

  const tourGateBypass =
    options?.allowResidentTourAccess === true &&
    portal === "resident" &&
    hasRole(ctx, "resident");

  if (!hasRole(ctx, role)) {
    if (applyGateBypass || tourGateBypass) return;
    const next = await requestedPortalPath(role);
    redirect(next ? `/auth/sign-in?next=${encodeURIComponent(next)}` : "/auth/sign-in");
  }

  if (ctx.roles.length > 1 && (ctx.effectiveRole === null || ctx.effectiveRole !== role) && !(applyGateBypass || tourGateBypass)) {
    const next = await requestedPortalPath(role) ?? portalDashboardPath(role);
    redirect(`/auth/choose-portal?next=${encodeURIComponent(next)}`);
  }

  if (ctx.effectiveRole !== role) {
    if (applyGateBypass || tourGateBypass) return;
    redirect(portalDashboardPath(ctx.effectiveRole ?? "resident"));
  }
}
