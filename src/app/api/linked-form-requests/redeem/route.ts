import { NextResponse } from "next/server";
import {
  loadApplicationAccessRow,
  redeemLinkedFormToken,
  toLinkedFormRequestViews,
} from "@/lib/application-linked-form-requests.server";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { linkedFormOpenPath } from "@/lib/linked-form-path";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/** One answer for every link that cannot be used: wrong, expired, finished, already taken, not a resident. */
const REFUSED = { ok: false, error: "This link can't be used." } as const;

/**
 * A share link is opened by a signed-in RESIDENT account. Redeeming links that account to the applicant for
 * this one form and returns where to fill it in. The request body carries only the token; everything else is
 * re-derived from the stored request. A refusal never says whether the token existed, had expired or had
 * been used.
 */
export async function POST(req: Request) {
  try {
    if (!(await rateLimit(`linked-form-redeem:${clientIpFrom(req)}`, 20, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
    }
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
    if (!(await rateLimit(`linked-form-redeem-user:${user.id}`, 10, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
    }

    const body = (await req.json().catch(() => ({}))) as { token?: unknown };
    const token = typeof body.token === "string" ? body.token : "";

    const db = createSupabaseServiceRoleClient();
    const { data: profile } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
    const isResidentAccount = await authorizeResidentRole(db, {
      userId: user.id,
      legacyRole: (profile as { role?: string } | null)?.role,
    });
    // The same body as a bad link, so a visitor learns nothing about whether the link was real.
    if (!isResidentAccount) return NextResponse.json(REFUSED, { status: 404 });

    const redeemed = await redeemLinkedFormToken(db, token, { id: user.id, email: user.email });
    if (!redeemed.ok) return NextResponse.json(REFUSED, { status: 404 });

    const app = await loadApplicationAccessRow(db, redeemed.request.application_id);
    if (!app) return NextResponse.json(REFUSED, { status: 404 });
    const [view] = await toLinkedFormRequestViews(db, [{ request: redeemed.request, viewerRole: redeemed.role, app }]);
    return NextResponse.json({
      ok: true,
      requestId: redeemed.request.id,
      role: redeemed.role,
      formLabel: view?.formLabel ?? "Form",
      path: linkedFormOpenPath(redeemed.request.id),
    });
  } catch {
    return NextResponse.json(REFUSED, { status: 404 });
  }
}
