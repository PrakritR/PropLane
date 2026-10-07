import "server-only";

import { cookies, headers } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { filterAdminUserIds, userHoldsAdminRole } from "@/lib/auth/admin-role";
import { normalizePortalRoles } from "@/lib/auth/portal-roles";
import {
  isViewAsOperatorId,
  readViewAsSecret,
  VIEW_AS_COOKIE,
  VIEW_AS_COOKIE_GRACE_SECONDS,
  VIEW_AS_TTL_SECONDS,
  verifyViewAsToken,
  viewAsKeepsRealIdentity,
  type ViewAsPayload,
  type ViewAsPortal,
} from "@/lib/auth/view-as-token";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { writeAuditLog } from "@/lib/tools/audit";

/**
 * Server half of "View as" (read-only support mode). The cookie format and the
 * read-only request policy are in `view-as-token.ts`; this file decides whether
 * a cookie is still honoured RIGHT NOW and writes the audit trail.
 *
 * A cookie is honoured only when ALL of these hold on this request:
 *   1. it carries a valid HMAC and has not expired (30 minutes, fixed);
 *   2. the real signed-in user is the admin who started it;
 *   3. that user still holds the admin role AND is still on the operator
 *      allowlist (`PROPLANE_VIEW_AS_OPERATOR_IDS`);
 *   4. the viewed account still exists, still holds the portal, and is not an
 *      admin.
 * Anything else behaves as if there were no cookie.
 */

export const VIEW_AS_STARTED_ACTION = "admin_view_as_started";
export const VIEW_AS_ENDED_ACTION = "admin_view_as_ended";
export const VIEW_AS_AUDIT_TOOL = "admin_view_as";

export type ViewAsTarget = {
  id: string;
  email: string | null;
  fullName: string | null;
  /** Legacy single role on `profiles`. Authorization uses `roles`. */
  role: string;
  /** Roles from `profile_roles` (legacy fallback applied), admin excluded from what the viewed side sees. */
  roles: string[];
  managerId: string | null;
};

export type ActiveViewAs = {
  adminId: string;
  targetUserId: string;
  portal: ViewAsPortal;
  sid: string;
  iat: number;
  exp: number;
  target: ViewAsTarget;
};

/* -------------------------------------------------------------------------- */
/* Cookie options                                                              */
/* -------------------------------------------------------------------------- */

export function viewAsCookieOptions(): {
  path: string;
  maxAge: number;
  sameSite: "lax";
  secure: boolean;
  httpOnly: true;
} {
  return {
    path: "/",
    maxAge: VIEW_AS_TTL_SECONDS + VIEW_AS_COOKIE_GRACE_SECONDS,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
  };
}

export async function readViewAsCookieValue(): Promise<string | null> {
  try {
    const c = await cookies();
    return c.get(VIEW_AS_COOKIE)?.value?.trim() || null;
  } catch {
    return null;
  }
}

/** Verified-but-not-yet-authorised payload from this request's cookie (expired tokens rejected). */
export async function readVerifiedViewAsPayload(
  opts: { allowExpired?: boolean } = {},
): Promise<ViewAsPayload | null> {
  const raw = await readViewAsCookieValue();
  if (!raw) return null;
  return verifyViewAsToken(raw, readViewAsSecret(), { allowExpired: opts.allowExpired });
}

/* -------------------------------------------------------------------------- */
/* Current-request resolution                                                  */
/* -------------------------------------------------------------------------- */

type CacheEntry = { at: number; value: ActiveViewAs | null };
const CACHE_TTL_MS = 10_000;
const resolutionCache = new Map<string, CacheEntry>();

/** Test hook: forget memoised resolutions. */
export function resetViewAsResolutionCache(): void {
  resolutionCache.clear();
}

async function loadTarget(db: SupabaseClient, targetId: string): Promise<ViewAsTarget | null> {
  const [{ data: profile }, { data: roleRows }] = await Promise.all([
    db.from("profiles").select("id, email, full_name, role, manager_id").eq("id", targetId).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", targetId),
  ]);
  if (!profile) return null;
  const p = profile as { id: string; email: string | null; full_name: string | null; role: string | null; manager_id: string | null };
  const roles = normalizePortalRoles(roleRows as { role: string }[] | null, p.role);
  return {
    id: String(p.id),
    email: p.email ?? null,
    fullName: p.full_name?.trim() || null,
    role: String(p.role ?? ""),
    roles: roles as string[],
    managerId: p.manager_id ? String(p.manager_id) : null,
  };
}

/**
 * The live view-as session for this request, or null. `realUserId` MUST be the
 * REAL signed-in user (never an already-substituted identity).
 */
export async function resolveActiveViewAs(realUserId: string): Promise<ActiveViewAs | null> {
  const real = realUserId.trim();
  if (!real) return null;
  const raw = await readViewAsCookieValue();
  if (!raw) return null;
  const secret = readViewAsSecret();
  const payload = await verifyViewAsToken(raw, secret);
  if (!payload) return null;
  if (payload.adminId !== real) return null;
  if (!isViewAsOperatorId(real)) return null;

  const key = `${raw}|${real}`;
  const hit = resolutionCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let value: ActiveViewAs | null = null;
  try {
    const db = createSupabaseServiceRoleClient();
    if (await userHoldsAdminRole(db, real)) {
      const target = await loadTarget(db, payload.targetId);
      if (target && target.roles.includes(payload.portal)) {
        const admins = await filterAdminUserIds(db, [target.id]);
        if (!admins.has(target.id)) {
          value = {
            adminId: payload.adminId,
            targetUserId: payload.targetId,
            portal: payload.portal,
            sid: payload.sid,
            iat: payload.iat,
            exp: payload.exp,
            target,
          };
        }
      }
    }
  } catch {
    value = null; // fail closed: any lookup failure means "not viewing"
  }
  resolutionCache.set(key, { at: Date.now(), value });
  if (resolutionCache.size > 200) {
    const oldest = resolutionCache.keys().next().value;
    if (oldest !== undefined) resolutionCache.delete(oldest);
  }
  return value;
}

/** The request path the middleware stamped, or null when unknown. */
export async function requestPathname(): Promise<string | null> {
  try {
    return (await headers()).get("x-pathname");
  } catch {
    return null;
  }
}

/**
 * The view-as session whose identity this request should resolve as. Null on
 * the admin console and the auth routes, where the operator is still themselves.
 */
export async function resolveViewAsIdentity(realUserId: string): Promise<ActiveViewAs | null> {
  const session = await resolveActiveViewAs(realUserId);
  if (!session) return null;
  if (viewAsKeepsRealIdentity(await requestPathname())) return null;
  return session;
}

/* -------------------------------------------------------------------------- */
/* Audit trail                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `audit_log.landlord_id` is the VIEWED account (the table's "account the row
 * is about" scope), `actor_user_id` the operator, so
 * `audit_log_landlord_idx` answers "who has looked at this account" in one
 * query. This is the only record: the viewed user is never notified (approved).
 * `dedupe_key` pins one started row and one ended row per session id.
 */
export async function recordViewAsStarted(
  db: SupabaseClient,
  args: { adminId: string; targetId: string; portal: ViewAsPortal; reason: string; sid: string; iat: number; exp: number },
): Promise<boolean> {
  const outcome = await writeAuditLog(
    { db, landlordId: args.targetId, userId: args.adminId },
    {
      action: VIEW_AS_STARTED_ACTION,
      toolName: VIEW_AS_AUDIT_TOOL,
      inputSummary: {
        sid: args.sid,
        portal: args.portal,
        targetUserId: args.targetId,
        reason: args.reason,
        startedAt: new Date(args.iat * 1000).toISOString(),
        expiresAt: new Date(args.exp * 1000).toISOString(),
        durationSeconds: args.exp - args.iat,
      },
      resultSummary: { readOnly: true },
      dedupeKey: `view_as_started:${args.sid}`,
    },
  );
  return outcome.recorded === true;
}

export async function recordViewAsEnded(
  db: SupabaseClient,
  payload: ViewAsPayload,
  how: "ended" | "expired",
  nowMs: number = Date.now(),
): Promise<boolean> {
  const endSec = Math.min(Math.floor(nowMs / 1000), payload.exp);
  const outcome = await writeAuditLog(
    { db, landlordId: payload.targetId, userId: payload.adminId },
    {
      action: VIEW_AS_ENDED_ACTION,
      toolName: VIEW_AS_AUDIT_TOOL,
      inputSummary: {
        sid: payload.sid,
        portal: payload.portal,
        targetUserId: payload.targetId,
        how,
        endedAt: new Date(endSec * 1000).toISOString(),
        durationSeconds: Math.max(0, endSec - payload.iat),
      },
      resultSummary: { readOnly: true },
      dedupeKey: `view_as_ended:${payload.sid}`,
    },
  );
  // A duplicate means this session was already closed: that is success.
  return outcome.recorded === true || (outcome.recorded === false && outcome.duplicate === true);
}
