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
 * - `"inert"`  — locked and dead. Every RESIDENT lock:
 *     * a stage lock ("available after your lease is signed") has nothing to buy;
 *     * a resident free-tier lock is the MANAGER's plan, so
 *       `ResidentFreeTierFeatureNotice` can only say "ask your manager", which
 *       the row's own lock label already says.
 *   Both resident cases behave identically so a lock reads one way to a resident.
 *
 * Locks apply to managers AND residents — this only decides what a click does.
 *
 * Every locked-nav surface must honour the same split: desktop list, collapsed
 * rail, mobile top strip, native bottom bar, and the native More sheet. A live
 * link into a section the server then redirects home reads as a broken tab.
 */
export type PortalNavLockKind = "none" | "upsell" | "inert";


/**
 * Sections switched off while they are unfinished, for EVERY viewer and every plan.
 *
 * Payments is parked: the flows around it (reminders, re-pay, ledger) are mid-build, and a
 * manager or resident who wanders in lands in a half-built surface. Locking it is deliberately
 * cheaper than half-fixing it, and it shrinks the surface the flows that DO matter get tested
 * against.
 *
 * `inert`, never `upsell`: an upsell lock still navigates, because that row is the only entry
 * point to the upgrade page. There is nothing to buy here — the section is simply not ready —
 * so the row must not lead anywhere. Deleting an entry from this set is all it takes to bring a
 * section back.
 */
const DEFERRED_SECTIONS = new Set(["payments"]);

export function portalNavLockKind(params: {
  kind: PortalKind;
  section: string;
  /** The viewer's own plan for manager/pro; the linked MANAGER's plan for a resident. */
  subscriptionTier: "free" | "paid" | null | undefined;
  residentNavStage?: ResidentPortalNavStage | null;
}): PortalNavLockKind {
  const { kind, section, subscriptionTier, residentNavStage } = params;

  // Checked before tier and stage: a deferred section is locked for a paid manager and a
  // fully-approved resident alike, which neither of those rules would do on its own.
  if (DEFERRED_SECTIONS.has(section)) return "inert";

  if (kind === "resident") {
    if (residentNavStage && residentSectionLockedForStage(section, residentNavStage)) return "inert";
    if (subscriptionTier === "free" && residentSectionLockedForManagerTier(section, subscriptionTier)) {
      return "inert";
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
  return portalNavLockKind(params) === "upsell";
}
