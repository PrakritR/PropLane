import { nativeAwarePath } from "@/lib/auth/native-auth-entry";

/** Post-signup onboarding: progressive Google Calendar + Gmail consent (not bundled into sign-in). */
export const MANAGER_GOOGLE_SERVICES_ONBOARDING_PATH = "/auth/connect-google-services";

/** Client redirect after pricing / account creation — onboarding page decides skip vs show. */
export function managerPortalEntryPath(fallback = "/portal/dashboard"): string {
  void fallback;
  return MANAGER_GOOGLE_SERVICES_ONBOARDING_PATH;
}

/** Land new managers on the one-time account setup screen (phone, work number, calendar, …). */
export function goToManagerAccountSetup(): void {
  if (typeof window === "undefined") return;
  window.location.replace(nativeAwarePath(MANAGER_GOOGLE_SERVICES_ONBOARDING_PATH));
}
