import { managerSectionLockedForTier, residentSectionLockedForManagerTier } from "@/lib/manager-access";
import type { PortalKind } from "@/lib/portal-types";
import { residentSectionLockedForStage, type ResidentPortalNavStage } from "@/lib/resident-portal-nav";

/**
 * What a locked nav row DOES when you click it.
 *
 * - `"none"`   — not locked.
 * - `"upsell"` — locked, but still navigates. The manager / pro free-tier case:
 *   the destination route renders `PortalTierPaywall`, and the sidebar row is
 *   the ONLY entry point to that upgrade page anywhere in the product. Rendering
 *   it as a non-navigating `<span>` deletes the upgrade CTA — a revenue path —
 *   which is exactly what shipped in the resident redesign.
 * - `"notice"` — locked, but navigates to a disabled preview explaining that
 *   the resident's property manager must upgrade the workspace.
 * - `"inert"`  — locked and dead because the resident has not reached the
 *   required lifecycle stage yet (for example, before lease signing).
 *
 * Locks apply to managers AND residents — this only decides what a click does.
 *
 * Every locked-nav surface must honour the same split: desktop list, collapsed
 * rail, mobile top strip, native bottom bar, and the native More sheet. A live
 * link into a section the server then redirects home reads as a broken tab.
 */
export type PortalNavLockKind = "none" | "upsell" | "notice" | "inert";


/**
 * Sections switched off while they are unfinished, for EVERY viewer and every plan.
 *
 * Empty by default — add a section id here only when it must stay unreachable by URL and nav
 * until the flows around it are ready. Payments was parked here during mid-build work and is
 * live again; keep the redirect guard in `render-portal-section.tsx` for any future deferrals.
 */
export const DEFERRED_SECTIONS = new Set<string>([]);

export function portalNavLockKind(params: {
  kind: PortalKind;
  section: string;
  /** The viewer's own plan for manager/pro; the linked MANAGER's plan for a resident. */
  subscriptionTier: "free" | "paid" | null | undefined;
  residentNavStage?: ResidentPortalNavStage | null;
  /**
   * @deprecated Co-manager module grants no longer lock nav rows — every manager
   * sees the same sidebar; property scoping happens in list APIs and filters.
   */
  coManagerRestricted?: boolean;
}): PortalNavLockKind {
  const { kind, section, subscriptionTier, residentNavStage } = params;

  // Checked before tier and stage: a deferred section is locked for a paid manager and a
  // fully-approved resident alike, which neither of those rules would do on its own.
  if (DEFERRED_SECTIONS.has(section)) return "inert";

  if (kind === "resident") {
    if (residentNavStage && residentSectionLockedForStage(section, residentNavStage)) return "inert";
    if (subscriptionTier === "free" && residentSectionLockedForManagerTier(section, subscriptionTier)) {
      return "notice";
    }
    return "none";
  }

  if ((kind === "manager" || kind === "pro") && subscriptionTier === "free") {
    return managerSectionLockedForTier(section, subscriptionTier) ? "upsell" : "none";
  }

  return "none";
}

export function portalNavSectionLocked(params: Parameters<typeof portalNavLockKind>[0]): boolean {
  return portalNavLockKind(params) !== "none";
}

/** True when a locked row must still navigate (to the upgrade paywall page). */
export function portalNavLockNavigable(params: Parameters<typeof portalNavLockKind>[0]): boolean {
  const kind = portalNavLockKind(params);
  return kind === "upsell" || kind === "notice";
}
