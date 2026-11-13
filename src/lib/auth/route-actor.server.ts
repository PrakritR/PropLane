import "server-only";

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { userHoldsAdminRoleStrict } from "@/lib/auth/admin-role";
import { getRequestUserFast } from "@/lib/auth/request-user-fast.server";
import { withholdManagerSurface } from "@/lib/property-owner/access.server";
import { loadServiceStaffWorkspaces } from "@/lib/service/service-mode.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

/**
 * A route actor answers "who is calling, and may they use a manager route?" WITHOUT turning a failed READ into an
 * authorization answer. A timeout or 5xx from the auth service, or an unreadable role row, is a 503 the client can
 * retry, never a 401/403 that signs staff out or tells them a workspace is not theirs.
 */
export type RouteActor =
  | { ok: true; userId: string; db: SupabaseClient }
  | { ok: false; status: 401; error: "Sign in again." }
  | { ok: false; status: 403; error: string }
  | { ok: false; status: 503; error: "PropLane could not check your sign-in. Try again." };

const SIGN_IN_AGAIN = "Sign in again." as const;
const UNAVAILABLE = "PropLane could not check your sign-in. Try again." as const;

/** One log line per refusal. Ids and reasons only: never an email, phone or message body. */
export function logRouteActorRefusal(route: string | undefined, userId: string | null, reason: string): void {
  console.error("[route-actor]", { route: route ?? "unknown", userId, reason });
}

function isRetryableAuthError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { status?: unknown; name?: unknown; code?: unknown };
  if (e.name === "AuthRetryableFetchError" || e.code === "AuthRetryableFetchError") return true;
  if (typeof e.status !== "number") return true;
  return e.status >= 500;
}

type SessionUser = User;
type SessionRead =
  | { kind: "user"; user: SessionUser }
  | { kind: "none" }
  | { kind: "unavailable" };

async function readSessionUser(auth: Awaited<ReturnType<typeof createSupabaseServerClient>>): Promise<SessionRead> {
  try {
    const { data, error } = await auth.auth.getUser();
    if (error) return isRetryableAuthError(error) ? { kind: "unavailable" } : { kind: "none" };
    return data?.user?.id ? { kind: "user", user: data.user } : { kind: "none" };
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * The signed-in user from the session, retrying one transient auth-service failure. A real "no session" (no user,
 * or a 4xx auth error) is `none` (401); a failure to ASK is `unavailable` (503).
 */
export async function resolveRouteSessionUser(opts?: { fast?: boolean; route?: string }): Promise<
  | { ok: true; userId: string; user: Pick<User, "id" | "email"> }
  | { ok: false; status: 401; error: typeof SIGN_IN_AGAIN }
  | { ok: false; status: 503; error: typeof UNAVAILABLE }
> {
  let auth: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  try {
    auth = await createSupabaseServerClient();
  } catch {
    logRouteActorRefusal(opts?.route, null, "auth_client_unavailable");
    return { ok: false, status: 503, error: UNAVAILABLE };
  }
  if (opts?.fast === true) {
    try {
      const fast = await getRequestUserFast(auth);
      if (fast?.id) return { ok: true, userId: fast.id, user: fast as Pick<User, "id" | "email"> };
    } catch {
      // fall through to getUser()
    }
  }
  let read = await readSessionUser(auth);
  if (read.kind === "unavailable") read = await readSessionUser(auth);
  if (read.kind === "user") return { ok: true, userId: read.user.id, user: read.user };
  if (read.kind === "none") {
    logRouteActorRefusal(opts?.route, null, "no_session");
    return { ok: false, status: 401, error: SIGN_IN_AGAIN };
  }
  logRouteActorRefusal(opts?.route, null, "auth_service_unavailable");
  return { ok: false, status: 503, error: UNAVAILABLE };
}

/** Strict twin of `userHoldsManagerRole`: a read error THROWS instead of reading as "not a manager". */
export async function userHoldsManagerRoleStrict(db: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await db
    .from("profile_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "manager")
    .maybeSingle();
  if (error) throw new Error("Could not read manager role.");
  return Boolean(data);
}

export async function resolveManagerRouteActor(opts?: { fast?: boolean; route?: string }): Promise<RouteActor> {
  const route = opts?.route;
  const session = await resolveRouteSessionUser(opts);
  if (!session.ok) return session;
  const userId = session.userId;
  const unavailable = (reason: string): RouteActor => {
    logRouteActorRefusal(route, userId, reason);
    return { ok: false, status: 503, error: UNAVAILABLE };
  };

  let db: SupabaseClient;
  try {
    db = createSupabaseServiceRoleClient();
  } catch {
    return unavailable("service_client_unavailable");
  }

  try {
    if ((await resolveAuthenticatedBusinessAccess(userId, db)).kind === "denied") {
      logRouteActorRefusal(route, userId, "business_access_denied");
      return { ok: false, status: 403, error: "This account cannot use that feature right now." };
    }
  } catch {
    return unavailable("business_access_unreadable");
  }

  try {
    if (await userHoldsManagerRoleStrict(db, userId)) {
      if (await withholdManagerSurface(db, userId)) {
        logRouteActorRefusal(route, userId, "manager_surface_withheld");
        return { ok: false, status: 403, error: "Manager access required." };
      }
      return { ok: true, userId, db };
    }
    // No manager row: PropLane's own people act in service workspaces without one.
    if (await userHoldsAdminRoleStrict(db, userId)) return { ok: true, userId, db };
    const staff = await loadServiceStaffWorkspaces(db, userId);
    if (staff.length > 0) return { ok: true, userId, db };
  } catch {
    return unavailable("role_unreadable");
  }
  logRouteActorRefusal(route, userId, "not_manager");
  return { ok: false, status: 403, error: "Manager access required." };
}
