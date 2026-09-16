import { isUnsafeRedirectPath } from "@/lib/auth/normalize-post-auth-path";

/** Optional Google service setup shown after a manager account is created. */
export const MANAGER_GOOGLE_SERVICES_PATH = "/auth/manager/connect-google";

/** Keep service OAuth callbacks on this app even when a return path is supplied by the browser. */
export function normalizeGoogleServiceReturnPath(value: string | null | undefined, fallback: string): string {
  const candidate = value?.trim() ?? "";
  if (!candidate || isUnsafeRedirectPath(candidate)) return fallback;
  return candidate;
}

export function googleServiceResultPath(
  returnPath: string,
  service: "calendar",
  result: "connected" | "error",
  reason?: string,
): string {
  const url = new URL(returnPath, "https://proplane-internal.invalid");
  const onboarding = url.pathname === MANAGER_GOOGLE_SERVICES_PATH;
  const resultKey = onboarding ? service : "gcal";
  const reasonKey = onboarding ? `${service}Reason` : "reason";
  url.searchParams.set(resultKey, result);
  if (reason) url.searchParams.set(reasonKey, reason);
  else url.searchParams.delete(reasonKey);
  return `${url.pathname}${url.search}${url.hash}`;
}
