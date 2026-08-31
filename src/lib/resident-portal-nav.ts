import type { ResidentPortalAccessState } from "@/lib/resident-portal-access-types";

/** Resident mobile bottom bar + sidebar lock stages. */
export type ResidentPortalNavStage =
  | "pre_approval"
  | "application_submitted"
  | "post_approval_pre_lease"
  | "post_lease";

export function resolveResidentPortalNavStage(
  access: Pick<
    ResidentPortalAccessState,
    "leaseAccessUnlocked" | "applicationApproved" | "hasCompletedApplicationSubmission"
  >,
): ResidentPortalNavStage {
  if (access.leaseAccessUnlocked) return "post_lease";
  if (access.applicationApproved) return "post_approval_pre_lease";
  if (access.hasCompletedApplicationSubmission) return "application_submitted";
  return "pre_approval";
}

/**
 * Fixed native bottom bar tabs per stage (Settings stays in the profile menu).
 *
 * INVARIANT: every section here must be unlocked at that stage in
 * `STAGE_UNLOCKED_SECTIONS` below. The bottom bar is the resident's whole
 * navigation on a phone, so a primary tab that is locked is a dead tab — which
 * is exactly what `application_submitted` shipped: it promoted Lease and
 * Payments a stage early, so a resident who had submitted an application got a
 * bar whose first two tabs did nothing. Approval is what unlocks Lease and
 * Payments; a signed lease is what unlocks Services.
 * Enforced by `tests/unit/resident-portal-nav.test.ts`.
 */
export const RESIDENT_BOTTOM_NAV_PRIMARY: Record<ResidentPortalNavStage, readonly string[]> = {
  pre_approval: ["tour", "applications", "dashboard", "communication"],
  application_submitted: ["tour", "applications", "dashboard", "communication"],
  post_approval_pre_lease: ["lease", "payments", "dashboard", "communication"],
  post_lease: ["services", "payments", "dashboard", "communication"],
};

const STAGE_UNLOCKED_SECTIONS: Record<ResidentPortalNavStage, readonly string[]> = {
  pre_approval: ["tour", "applications", "dashboard", "communication", "profile"],
  application_submitted: ["tour", "applications", "dashboard", "communication", "profile"],
  post_approval_pre_lease: [
    "tour",
    "applications",
    "lease",
    "payments",
    "dashboard",
    "communication",
    "documents",
    "profile",
  ],
  post_lease: [
    "tour",
    "applications",
    "services",
    "payments",
    "dashboard",
    "communication",
    "lease",
    "move-in",
    "documents",
    "profile",
  ],
};

export function residentBottomNavPrimarySections(stage: ResidentPortalNavStage): readonly string[] {
  return RESIDENT_BOTTOM_NAV_PRIMARY[stage];
}

export function residentSectionUnlockedForStage(section: string, stage: ResidentPortalNavStage): boolean {
  return STAGE_UNLOCKED_SECTIONS[stage].includes(section);
}

export function residentSectionLockedForStage(section: string, stage: ResidentPortalNavStage): boolean {
  return !residentSectionUnlockedForStage(section, stage);
}

/** Resident sections that stay out of nav until unlocked — no inert padlock row. */
const RESIDENT_NAV_HIDDEN_UNTIL_UNLOCKED = new Set(["move-in"]);

export function residentNavSectionVisibleInNav(section: string, stage: ResidentPortalNavStage): boolean {
  if (RESIDENT_NAV_HIDDEN_UNTIL_UNLOCKED.has(section) && residentSectionLockedForStage(section, stage)) {
    return false;
  }
  return true;
}

function residentPathSection(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  return parts[1] ?? "";
}

/**
 * Legacy section aliases. None of these is a resident nav section — every one is
 * rewritten by `renderPortalSection` to a real destination (`finances` /
 * `financials` → Payments, `inbox` → Communication, `bugs-feedback` → Settings),
 * and the guard then judges THAT path.
 *
 * They must be allowed through here, in the SHARED guard, for two reasons:
 *  - the server guard runs after the rewrites, so an alias never reaches it;
 *  - the CLIENT guard (`ResidentPreApplicationGuard`) runs on the ORIGINAL
 *    pathname while the server redirect is still in flight. Treating an alias
 *    as forbidden made it `router.replace()` to the home page and the redirect
 *    never landed — this is why the fix looked correct in unit tests and was
 *    still broken in the browser.
 */
const RESIDENT_LEGACY_SECTION_ALIASES = new Set(["inbox", "financials", "finances", "bugs-feedback"]);

/** Client + server route guard — whether the resident may open this path at their stage. */
export function isResidentPathAllowedForAccess(
  pathname: string,
  access: Pick<
    ResidentPortalAccessState,
    "leaseAccessUnlocked" | "applicationApproved" | "hasCompletedApplicationSubmission"
  >,
): boolean {
  const stage = resolveResidentPortalNavStage(access);
  if (pathname === "/resident/profile" || pathname.startsWith("/resident/profile/")) return true;

  const section = residentPathSection(pathname);
  if (!section) return false;

  if (RESIDENT_LEGACY_SECTION_ALIASES.has(section)) return true;

  if (section === "communication" || pathname.startsWith("/resident/communication/")) {
    return residentSectionUnlockedForStage("communication", stage);
  }

  if (section === "applications" || pathname.startsWith("/resident/applications/")) {
    return residentSectionUnlockedForStage("applications", stage);
  }

  return residentSectionUnlockedForStage(section, stage);
}

export function residentNavLockReason(
  section: string,
  stage: ResidentPortalNavStage,
): string | null {
  if (!residentSectionLockedForStage(section, stage)) return null;
  if (stage === "pre_approval" || stage === "application_submitted") {
    return "Available after your application is approved";
  }
  if (stage === "post_approval_pre_lease") {
    return "Available after your lease is signed";
  }
  return "Unavailable";
}

/** Default resident landing route after sign-in / account creation. */
export function residentPortalHomePath(
  access: Pick<
    ResidentPortalAccessState,
    "leaseAccessUnlocked" | "applicationApproved" | "hasTourLink" | "hasSubmittedApplication"
  >,
): string {
  if (access.leaseAccessUnlocked) return "/resident/dashboard";
  if (access.applicationApproved) return "/resident/dashboard";
  if (access.hasTourLink && !access.hasSubmittedApplication) return "/resident/tour";
  // A resident who has submitted nothing and has no tour signed up to APPLY.
  // Their dashboard is empty by construction, so landing them there reads as a
  // broken account; the apply wizard is the only thing they can act on.
  if (!access.hasSubmittedApplication) return "/resident/applications/apply";
  return "/resident/dashboard";
}
