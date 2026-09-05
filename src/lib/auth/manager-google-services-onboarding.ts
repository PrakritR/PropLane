import { nativeAwarePath } from "@/lib/auth/native-auth-entry";

/** Default landing path after manager signup or plan selection. */
export const MANAGER_PORTAL_ENTRY_PATH = "/portal/dashboard";

/** Post-signup onboarding: progressive Google Calendar + Gmail consent (not bundled into sign-in). */
export const MANAGER_GOOGLE_SERVICES_ONBOARDING_PATH = "/auth/connect-google-services";

/** Client redirect after pricing / account creation. */
export function managerPortalEntryPath(fallback = MANAGER_PORTAL_ENTRY_PATH): string {
  return fallback;
}

/** First-time signup lands in the portal; optional setup lives in Settings. */
export function goToManagerAccountSetup(): void {
  if (typeof window === "undefined") return;
  window.location.replace(nativeAwarePath(MANAGER_PORTAL_ENTRY_PATH));
}
