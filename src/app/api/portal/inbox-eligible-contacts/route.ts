import { NextResponse } from "next/server";
import { getEffectiveUserIdForPortal } from "@/lib/auth/effective-session";
import { listEligibleInboxContacts } from "@/lib/inbox-recipient-scope";
import { resolveInboxSenderRoleForPortal } from "@/lib/inbox-portal-sender";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { assertTestWorkspacePrincipalCompatibility, resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

/**
 * Role-scoped contacts a signed-in portal user may individually message in the
 * compose modal. This is the SAME scoping the send endpoint enforces, so the
 * picker can never surface anyone the server would reject.
 */
export async function GET(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ contacts: [] }, { status: 401 });

    const url = new URL(req.url);
    const portalParam = url.searchParams.get("portal");
    const portal = portalParam === "manager" || portalParam === "vendor" ? portalParam : "resident";

    const db = createSupabaseServiceRoleClient();
    if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") {
      return NextResponse.json({ contacts: [] }, { status: 403 });
    }
    const { data: roleRows, error: roleError } = await db.from("profile_roles").select("role").eq("user_id", user.id);
    if (roleError) return NextResponse.json({ contacts: [] }, { status: 503 });
    const admin = (roleRows ?? []).some((row) => row.role === "admin");

    let actorId = user.id;
    let actorEmail = user.email_confirmed_at ? (user.email ?? "").trim().toLowerCase() : "";
    let actorRole = admin ? "admin" : null;

    // Admin previewing a portal acts as the previewed user, so the picker shows
    // that user's own eligible contacts (matches inbox scope resolution).
    if (admin) {
      const effectiveId = await getEffectiveUserIdForPortal(portal);
      if (effectiveId && effectiveId !== user.id) {
        await assertTestWorkspacePrincipalCompatibility({ actorUserId: user.id, relatedUserIds: [effectiveId], db });
        actorId = effectiveId;
        const { data: effectiveAuth, error: effectiveAuthError } = await db.auth.admin.getUserById(effectiveId);
        if (effectiveAuthError) return NextResponse.json({ contacts: [] }, { status: 503 });
        actorEmail = effectiveAuth.user?.email_confirmed_at
          ? (effectiveAuth.user.email ?? "").trim().toLowerCase()
          : "";
        const { error: effectiveRoleError } = await db.from("profile_roles").select("role").eq("user_id", effectiveId);
        if (effectiveRoleError) return NextResponse.json({ contacts: [] }, { status: 503 });
        actorRole = null;
      }
    }

    actorRole = await resolveInboxSenderRoleForPortal(db, {
      userId: actorId,
      legacyRole: actorRole,
      portal,
      isAdmin: admin && actorId === user.id,
    });

    if (!actorRole) return NextResponse.json({ contacts: [] }, { status: 403 });

    const contacts = await listEligibleInboxContacts(db, {
      id: actorId,
      email: actorEmail ?? "",
      role: actorRole,
      isAdmin: admin && actorId === user.id,
    });

    return NextResponse.json({ contacts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load contacts.";
    return NextResponse.json({ contacts: [], error: message }, { status: 500 });
  }
}
