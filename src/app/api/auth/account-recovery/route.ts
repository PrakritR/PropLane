import { NextRequest, NextResponse } from "next/server";
import { getRequestAuthUser } from "@/lib/auth/request-auth-user";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { pendingAccountRecovery, sendAccountRecoveryChallenge, chooseAccountRecovery } from "@/lib/auth/account-recovery.server";
import { track } from "@/lib/analytics/posthog";

export const runtime = "nodejs";
const privateHeaders = { "Cache-Control": "private, no-store" };

export async function GET(req: NextRequest) {
  const auth = await createSupabaseServerClient();
  const user = await getRequestAuthUser(auth, req);
  if (!user) return NextResponse.json({ error: "Sign in to manage your saved data." }, { status: 401, headers: privateHeaders });
  try {
    const request = await pendingAccountRecovery(createSupabaseServiceRoleClient(), user.id, new URL(req.url).searchParams.get("portal") ?? undefined);
    return NextResponse.json({ request: request ? {
      id: request.id, portal: request.portal, state: request.state, expiresAt: request.expires_at,
      expired: Date.parse(request.expires_at) <= Date.now(),
    } : null }, { headers: privateHeaders });
  } catch {
    return NextResponse.json({ error: "We couldn't check your saved data. Please try again." }, { status: 503, headers: privateHeaders });
  }
}

export async function POST(req: NextRequest) {
  if (req.headers.get("origin") && req.headers.get("origin") !== new URL(req.url).origin) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403, headers: privateHeaders });
  }
  const auth = await createSupabaseServerClient();
  const user = await getRequestAuthUser(auth, req);
  if (!user) return NextResponse.json({ error: "Sign in to manage your saved data." }, { status: 401, headers: privateHeaders });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: privateHeaders }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: privateHeaders });
  try {
    const db = createSupabaseServiceRoleClient();
    if (body.action === "verify") {
      const result = await sendAccountRecoveryChallenge(db, user.id, typeof body.portal === "string" ? body.portal : undefined);
      return NextResponse.json(result, { headers: privateHeaders });
    }
    if (body.action !== "recover" && body.action !== "fresh") return NextResponse.json({ error: "Choose recover or start fresh." }, { status: 400, headers: privateHeaders });
    if (typeof body.requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(body.requestId) || typeof body.token !== "string" || (body.action === "fresh" && body.confirm !== "DELETE")) {
      return NextResponse.json({ error: "A verified recovery link and explicit confirmation are required." }, { status: 400, headers: privateHeaders });
    }
    const result = await chooseAccountRecovery(db, user.id, body.requestId, body.token, body.action);
    if ("signedOut" in result && result.signedOut) await auth.auth.signOut();
    track(body.action === "recover" ? "account_recovery_completed" : "account_fresh_start_completed", user.id, {});
    return NextResponse.json(result, { headers: privateHeaders });
  } catch {
    return NextResponse.json({ error: "We couldn't complete that request. Check that your verification link is current, or request a new one and try again." }, { status: 409, headers: privateHeaders });
  }
}
