/**
 * Client-side demo mode for the public `/demo` sandbox.
 *
 * The `/demo` route reuses the REAL portal panels signed-out. To make those
 * panels render rich data (most scope their reads by a manager/resident id), the
 * demo supplies a fixed, synthetic session per role instead of the null
 * signed-out session. Nothing here touches the network or a real account: the
 * ids are made-up scope keys, and every store the panels read is seeded locally
 * (see `demo-seed.ts`). The `@axis.local` emails are already treated as demo
 * addresses by the agent's send path, so they can never trigger a real email.
 *
 * `isDemoModeActive()` is derived from the pathname so the demo session is on
 * exactly and only under `/demo` and on `/` (the landing page embeds the demo
 * frame above the fold) — there is no ordering race with panel mount effects,
 * and it can never leak into a real signed-in portal session: portal routes
 * live under `/portal`, `/resident`, `/vendor`, `/admin`, never at `/`.
 *
 * Guided tour state (`demo-guided.ts`, key `axis_demo_guided_state_v1`) uses the
 * same pathname gate — production `/portal` routes never read demo localStorage.
 */

export type DemoPortalRole = "manager" | "resident" | "vendor";

import {
  CANONICAL_DEMO_GUIDED_EMAIL,
  CANONICAL_DEMO_GUIDED_NAME,
  CANONICAL_DEMO_MANAGER_EMAIL,
  CANONICAL_DEMO_MANAGER_NAME,
  CANONICAL_DEMO_RESIDENT_EMAIL,
  CANONICAL_DEMO_RESIDENT_NAME,
  CANONICAL_DEMO_VENDOR_EMAIL,
  CANONICAL_DEMO_VENDOR_NAME,
} from "@/lib/demo/demo-canonical-accounts";
import { isGuidedDemoActive } from "@/lib/demo/demo-guided";
import { isPublicDemoSurfaceEnabled } from "@/lib/public-demo-access";

export const DEMO_MANAGER_USER_ID = "demo-manager";
export const DEMO_RESIDENT_USER_ID = "demo-resident";
export const DEMO_VENDOR_USER_ID = "demo-vendor";
/** Scoped user id for guided tour — maps to `testeverything@test.proplane.local`. */
export const DEMO_GUIDED_USER_ID = "demo-everything";
export const DEMO_MANAGER_EMAIL = CANONICAL_DEMO_MANAGER_EMAIL;
export const DEMO_RESIDENT_EMAIL = CANONICAL_DEMO_RESIDENT_EMAIL;
export const DEMO_VENDOR_EMAIL = CANONICAL_DEMO_VENDOR_EMAIL;
export const DEMO_GUIDED_EMAIL = CANONICAL_DEMO_GUIDED_EMAIL;
export const DEMO_MANAGER_NAME = CANONICAL_DEMO_MANAGER_NAME;
export const DEMO_RESIDENT_NAME = CANONICAL_DEMO_RESIDENT_NAME;
export const DEMO_VENDOR_NAME = CANONICAL_DEMO_VENDOR_NAME;
export const DEMO_GUIDED_NAME = CANONICAL_DEMO_GUIDED_NAME;

export type DemoSessionSnapshot = { userId: string | null; email: string | null; ready: boolean };

/**
 * True when the browser is on a public demo sandbox surface: `/demo`, or the
 * landing-page embed at `/`. The `/` case only counts when the public demo
 * surface is enabled — when it is disabled the homepage renders the classic
 * hero (no embedded demo), so demo mode must not be active there.
 */
export function isDemoModeActive(): boolean {
  if (typeof window === "undefined") return false;
  const pathname = window.location?.pathname;
  if (!pathname) return false;
  if (pathname.startsWith("/demo")) return true;
  return pathname === "/" && isPublicDemoSurfaceEnabled();
}

/** Re-render portal hooks when demo navigation changes the pathname or in-frame section. */
export function subscribeDemoPath(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("popstate", listener);
  window.addEventListener(DEMO_NAVIGATE_EVENT, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(DEMO_NAVIGATE_EVENT, listener);
  };
}

/** Manager/resident scope id for portal reads — includes the demo sandbox when signed out. */
export function resolveManagerScopeUserId(userId: string | null): string | null {
  if (userId?.trim()) return userId.trim();
  if (isDemoModeActive()) return getDemoSessionSnapshot().userId;
  return null;
}

/**
 * Window event a reused portal panel dispatches (instead of a real router push)
 * when it wants to navigate while inside the demo sandbox. `DemoPortalShell`
 * listens for it and translates the target href into an in-demo section switch,
 * so programmatic navigations never escape to a real auth-gated route.
 */
export const DEMO_NAVIGATE_EVENT = "axis-demo:navigate";

let role: DemoPortalRole = "manager";
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function getDemoRole(): DemoPortalRole {
  return role;
}

export function setDemoRole(next: DemoPortalRole) {
  if (role === next) return;
  role = next;
  emit();
}

/**
 * The homepage Software demo's resident is a particular person per chapter (a prospect who has not applied, a
 * resident on a signed lease), not the canonical test resident. Set before the shell mounts; `null` restores the
 * canonical one.
 */
let residentIdentity: { email: string } | null = null;

export function setDemoResidentIdentity(next: { email: string } | null) {
  if (residentIdentity?.email === next?.email) return;
  residentIdentity = next;
  emit();
}

export function subscribeDemoRole(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The synthetic session the portal hooks report for the active demo role. */
export function demoSessionForRole(r: DemoPortalRole): DemoSessionSnapshot {
  if (isGuidedDemoActive()) {
    return { userId: DEMO_GUIDED_USER_ID, email: DEMO_GUIDED_EMAIL, ready: true };
  }
  if (r === "resident") {
    return { userId: DEMO_RESIDENT_USER_ID, email: residentIdentity?.email ?? DEMO_RESIDENT_EMAIL, ready: true };
  }
  if (r === "vendor") {
    return { userId: DEMO_VENDOR_USER_ID, email: DEMO_VENDOR_EMAIL, ready: true };
  }
  return { userId: DEMO_MANAGER_USER_ID, email: DEMO_MANAGER_EMAIL, ready: true };
}

/** Manager-scoped demo user id — guided tour uses the everything test account. */
export function resolveDemoManagerScopeUserId(): string {
  return getDemoSessionSnapshot().userId ?? DEMO_MANAGER_USER_ID;
}

/**
 * Scope key for the demo PORTFOLIO — the listings, charges and tenancies the
 * manager owns. Unlike `resolveDemoManagerScopeUserId()` this does NOT vary with
 * the role the visitor is currently viewing: those rows are only ever written
 * under the manager scope (`demo-manager` idle, the guided id during a tour), so
 * a resident- or vendor-scoped read of them always finds nothing. Use this for
 * any read of manager-owned data from a surface that can render in another role.
 */
export function resolveDemoPortfolioScopeUserId(): string {
  return isGuidedDemoActive() ? DEMO_GUIDED_USER_ID : DEMO_MANAGER_USER_ID;
}

/** Current demo session snapshot (role-aware). */
export function getDemoSessionSnapshot(): DemoSessionSnapshot {
  return demoSessionForRole(role);
}
