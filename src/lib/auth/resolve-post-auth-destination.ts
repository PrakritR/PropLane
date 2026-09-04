import { GET_STARTED_PATH } from "@/lib/auth/get-started-path";
import { normalizePostAuthPath } from "@/lib/auth/normalize-post-auth-path";
import { normalizePortalRoles, portalDashboardPath } from "@/lib/auth/portal-roles";
import { isPrimaryAdminEmail } from "@/lib/auth/primary-admin";
import type { SupabaseClient } from "@supabase/supabase-js";

const RESOLVE_ATTEMPTS = 16;
const RESOLVE_BASE_DELAY_MS = 300;

const VALID_CONTINUE_DESTINATIONS = new Set([
  GET_STARTED_PATH,
  "/auth/choose-portal",
  "/auth/manager-register-oauth",
  "/auth/connect-google-services",
]);

function isValidPostAuthDestination(path: string): boolean {
  if (path === "/auth/continue") return false;
  if (VALID_CONTINUE_DESTINATIONS.has(path)) return true;
  if (path.startsWith("/auth/manager-") || path.startsWith("/auth/resident-")) return true;
  if (path.startsWith("/mcp/authorize")) return true;
  if (path.startsWith("/partner/pricing")) return true;
  return (
    path.startsWith("/portal") ||
    path.startsWith("/pro") ||
    path.startsWith("/resident") ||
    path.startsWith("/admin") ||
    path.startsWith("/vendor")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Client-side fallback when the server resolver is unreachable or cookies lag. */
export async function resolveClientPostAuthDestination(
  supabase: SupabaseClient,
  nextPath: string,
): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const safeNext = nextPath.startsWith("/") ? normalizePostAuthPath(nextPath) : "";
  if (safeNext && isValidPostAuthDestination(safeNext)) return safeNext;

  const email = user.email?.trim().toLowerCase() ?? "";
  const [{ data: roleRows }, { data: profile }] = await Promise.all([
    supabase.from("profile_roles").select("role").eq("user_id", user.id),
    supabase.from("profiles").select("role").eq("id", user.id).maybeSingle(),
  ]);
  const roles = normalizePortalRoles(roleRows, profile?.role);
  if (roles.length === 1) return portalDashboardPath(roles[0]!);
  if (roles.length > 1) return "/auth/choose-portal";
  if (isPrimaryAdminEmail(email)) return portalDashboardPath("admin");
  return GET_STARTED_PATH;
}

/** Client-side: ask the server where a signed-in user should land after auth. */
export async function resolvePostAuthDestination(
  nextPath: string,
  accessToken?: string | null,
): Promise<{
  redirectTo: string | null;
  resolutionFailed: boolean;
}> {
  const next = nextPath.startsWith("/") ? nextPath : "/auth/continue";
  const authHeaders: Record<string, string> = {};
  if (accessToken?.trim()) authHeaders.Authorization = `Bearer ${accessToken.trim()}`;

  for (let attempt = 0; attempt < RESOLVE_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`/api/auth/oauth-portal-access?next=${encodeURIComponent(next)}`, {
        credentials: "include",
        cache: "no-store",
        headers: authHeaders,
      });

      if (res.status === 401 && attempt < RESOLVE_ATTEMPTS - 1) {
        await sleep(RESOLVE_BASE_DELAY_MS + attempt * 250);
        continue;
      }

      if (!res.ok) {
        if (attempt < RESOLVE_ATTEMPTS - 1) {
          await sleep(RESOLVE_BASE_DELAY_MS + attempt * 250);
          continue;
        }
        return { redirectTo: null, resolutionFailed: true };
      }

      const body = (await res.json()) as { redirectTo?: string };
      const candidate = body.redirectTo?.startsWith("/") ? normalizePostAuthPath(body.redirectTo) : null;
      if (!candidate || !isValidPostAuthDestination(candidate)) {
        if (attempt < RESOLVE_ATTEMPTS - 1) {
          await sleep(RESOLVE_BASE_DELAY_MS + attempt * 250);
          continue;
        }
        return { redirectTo: null, resolutionFailed: true };
      }

      return { redirectTo: candidate, resolutionFailed: false };
    } catch {
      if (attempt < RESOLVE_ATTEMPTS - 1) {
        await sleep(RESOLVE_BASE_DELAY_MS + attempt * 250);
        continue;
      }
      return { redirectTo: null, resolutionFailed: true };
    }
  }

  return { redirectTo: null, resolutionFailed: true };
}

export function isGetStartedDestination(path: string): boolean {
  return path === GET_STARTED_PATH || path.startsWith(`${GET_STARTED_PATH}?`);
}
