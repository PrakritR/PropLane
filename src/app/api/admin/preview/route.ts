import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { portalDashboardPath } from "@/lib/auth/portal-roles";
import { decideViewAsStart, listViewablePortals } from "@/lib/auth/view-as-start.server";
import {
  isSameOrigin,
  isViewAsOperatorId,
  normalizeViewAsReason,
  readViewAsSecret,
  signViewAsToken,
  VIEW_AS_COOKIE,
  VIEW_AS_TTL_SECONDS,
  verifyViewAsToken,
  type ViewAsPayload,
  type ViewAsPortal,
} from "@/lib/auth/view-as-token";
import {
  readViewAsCookieValue,
  recordViewAsEnded,
  recordViewAsStarted,
  viewAsCookieOptions,
} from "@/lib/auth/view-as.server";
import { createRealIdentitySupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * "View as": read-only support mode for named PropLane operators.
 *
 *   POST   start   (reason required, 30 minutes, audited BEFORE the cookie is set)
 *   DELETE end     (audited, cookie cleared; reachable while the session is read-only)
 *   GET    state   (does the admin UI offer the button; the open session, if any)
 *
 * Every handler identifies the caller with the REAL-identity client: while a
 * session is open the normal server client answers as the viewed account, which
 * is exactly the wrong answer for "who is the operator".
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PORTALS: ViewAsPortal[] = ["manager", "resident", "vendor"];

type Body = { targetUserId?: unknown; portal?: unknown; reason?: unknown };

function deny(status = 403) {
  return NextResponse.json({ error: "Forbidden." }, { status });
}

function clearCookie(res: NextResponse) {
  res.cookies.set(VIEW_AS_COOKIE, "", { ...viewAsCookieOptions(), maxAge: 0 });
}

function isSameOriginRequest(req: Request): boolean {
  return isSameOrigin(req.headers);
}

async function realOperator(): Promise<{ id: string; isAdmin: boolean; allowlisted: boolean } | null> {
  const supabase = await createRealIdentitySupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const allowlisted = isViewAsOperatorId(user.id);
  // Admin lookup only when allowlisted: a stranger never costs a query.
  const isAdmin = allowlisted ? await isAdminUser(user.id) : false;
  return { id: user.id, isAdmin, allowlisted };
}

export async function GET(req: Request) {
  try {
    const operator = await realOperator();
    if (!operator) return NextResponse.json({ canViewAs: false, portals: [], active: null });
    const secret = readViewAsSecret();
    const canViewAs = Boolean(secret) && operator.allowlisted && operator.isAdmin;
    if (!canViewAs) return NextResponse.json({ canViewAs: false, portals: [], active: null });

    const payload = await verifyViewAsToken(await readViewAsCookieValue(), secret);
    const active =
      payload && payload.adminId === operator.id
        ? { portal: payload.portal, targetUserId: payload.targetId, exp: payload.exp }
        : null;

    const targetUserId = new URL(req.url).searchParams.get("targetUserId")?.trim() ?? "";
    let portals: ViewAsPortal[] = [];
    if (targetUserId && UUID_RE.test(targetUserId)) {
      const viewable = await listViewablePortals(createSupabaseServiceRoleClient(), {
        operatorId: operator.id,
        targetId: targetUserId,
      });
      if (viewable.ok) portals = viewable.portals;
    }
    return NextResponse.json({ canViewAs: true, portals, active });
  } catch {
    return NextResponse.json({ canViewAs: false, portals: [], active: null });
  }
}

export async function POST(req: Request) {
  try {
    if (!isSameOriginRequest(req)) return deny();

    const secret = readViewAsSecret();
    if (!secret) {
      // Fail closed: no secret, no feature. Same shape as any other refusal.
      return deny(503);
    }

    const operator = await realOperator();
    if (!operator || !operator.allowlisted || !operator.isAdmin) return deny();

    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }
    const targetUserId = typeof body.targetUserId === "string" ? body.targetUserId.trim() : "";
    const portal = body.portal;
    if (!targetUserId || !UUID_RE.test(targetUserId) || typeof portal !== "string" || !PORTALS.includes(portal as ViewAsPortal)) {
      return NextResponse.json({ error: "targetUserId and portal are required." }, { status: 400 });
    }
    const reason = normalizeViewAsReason(body.reason);
    if (!reason) {
      return NextResponse.json({ error: "A reason of 3 to 300 characters is required." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const decision = await decideViewAsStart(db, {
      operatorId: operator.id,
      targetId: targetUserId,
      portal: portal as ViewAsPortal,
    });
    if (!decision.ok) return NextResponse.json({ error: decision.error }, { status: decision.status });

    const nowSec = Math.floor(Date.now() / 1000);
    const payload: ViewAsPayload = {
      v: 1,
      adminId: operator.id,
      targetId: targetUserId,
      portal: portal as ViewAsPortal,
      iat: nowSec,
      exp: nowSec + VIEW_AS_TTL_SECONDS,
      sid: crypto.randomUUID(),
    };

    // Audit FIRST. If the trail cannot be written, there is no session.
    const recorded = await recordViewAsStarted(db, {
      adminId: payload.adminId,
      targetId: payload.targetId,
      portal: payload.portal,
      reason,
      sid: payload.sid,
      iat: payload.iat,
      exp: payload.exp,
    });
    if (!recorded) {
      return NextResponse.json({ error: "Could not record the audit entry, so viewing was not started." }, { status: 500 });
    }

    const res = NextResponse.json({
      ok: true,
      redirectTo: portalDashboardPath(payload.portal),
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    });
    res.cookies.set(VIEW_AS_COOKIE, await signViewAsToken(payload, secret), viewAsCookieOptions());
    return res;
  } catch {
    return NextResponse.json({ error: "Could not start viewing." }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    // A cross-site request cannot carry the SameSite=Lax cookie anyway; when an
    // Origin is sent it must still be ours.
    if (req.headers.get("origin") && !isSameOriginRequest(req)) return deny();

    const operator = await (async () => {
      try {
        const supabase = await createRealIdentitySupabaseServerClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        return user ?? null;
      } catch {
        return null;
      }
    })();

    // Expired-but-signed tokens still prove WHICH session to close.
    const payload = await verifyViewAsToken(await readViewAsCookieValue(), readViewAsSecret(), { allowExpired: true });
    let audited = false;
    if (payload && operator && payload.adminId === operator.id) {
      const expired = Math.floor(Date.now() / 1000) >= payload.exp;
      audited = await recordViewAsEnded(createSupabaseServiceRoleClient(), payload, expired ? "expired" : "ended").catch(
        () => false,
      );
    }
    // The cookie is cleared whatever happened above: ending must never trap a session open.
    const res = NextResponse.json({ ok: true, audited });
    clearCookie(res);
    return res;
  } catch {
    const res = NextResponse.json({ ok: true, audited: false });
    clearCookie(res);
    return res;
  }
}
