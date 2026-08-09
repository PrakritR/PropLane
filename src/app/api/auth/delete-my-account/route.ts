import { NextResponse } from "next/server";
import { track } from "@/lib/analytics/posthog";
import {
  deleteOwnPortalAccount,
  type SelfDeletePortal,
} from "@/lib/auth/delete-portal-account";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const SELF_DELETE_PORTALS = new Set<SelfDeletePortal>(["resident", "manager", "pro", "vendor", "admin"]);

function parsePortal(value: unknown): SelfDeletePortal | null {
  if (typeof value !== "string") return null;
  const portal = value.trim().toLowerCase() as SelfDeletePortal;
  return SELF_DELETE_PORTALS.has(portal) ? portal : null;
}

/**
 * Self-service portal account deletion (App Store Guideline 5.1.1(v)).
 *
 * The target is ALWAYS the authenticated caller resolved from their own session
 * cookie/JWT — a user id/email is never accepted from the request body, so no one
 * can delete another account. Requires an explicit { "confirm": "DELETE", "portal": "…" }
 * body. The service-role client is used only inside this route.
 */
export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: { confirm?: unknown; portal?: unknown } = {};
  try {
    body = (await req.json()) as { confirm?: unknown; portal?: unknown };
  } catch {
    /* empty/invalid body → confirmation check below fails */
  }
  if (body.confirm !== "DELETE") {
    return NextResponse.json(
      { error: 'Confirmation required. Send { "confirm": "DELETE" } to permanently delete your account.' },
      { status: 400 },
    );
  }

  const portal = parsePortal(body.portal);
  if (!portal) {
    return NextResponse.json(
      { error: 'Portal is required. Send { "portal": "resident" | "manager" | "vendor" | … }.' },
      { status: 400 },
    );
  }

  // The canonical sandbox accounts back /demo and the guided tour in every
  // environment — deleting one would brick those surfaces.
  if (String(user.email ?? "").trim().toLowerCase().endsWith("@test.proplane.local")) {
    return NextResponse.json({ error: "Sandbox accounts cannot be deleted." }, { status: 403 });
  }

  const svc = createSupabaseServiceRoleClient();
  try {
    const result = await deleteOwnPortalAccount(svc, user.id, portal);

    track("portal_account_deleted", user.id, { portal });

    if (result.signedOut) {
      await supabase.auth.signOut().catch(() => undefined);
    }

    return NextResponse.json(result);
  } catch (e) {
    console.error("delete-my-account failed", e);
    const message = e instanceof Error ? e.message : "";
    if (message.includes("does not have access")) {
      return NextResponse.json({ error: message }, { status: 403 });
    }
    return NextResponse.json(
      { error: "We couldn't delete your account. Please try again, or contact support if it keeps happening." },
      { status: 500 },
    );
  }
}
