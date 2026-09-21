import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
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
    const { data: profile } = await db
      .from("profiles")
      .select("email, role")
      .eq("id", user.id)
      .maybeSingle();
    const admin = await isAdminUser(user.id);

    let actorId = user.id;
    let actorEmail = (profile?.email ?? user.email ?? "").trim().toLowerCase() || null;
    let actorRole = admin ? "admin" : String(profile?.role ?? "").trim().toLowerCase() || null;

    // Admin previewing a portal acts as the previewed user, so the picker shows
    // that user's own eligible contacts (matches inbox scope resolution).
    if (admin) {
      const effectiveId = await getEffectiveUserIdForPortal(portal);
      if (effectiveId && effectiveId !== user.id) {
        await assertTestWorkspacePrincipalCompatibility({ actorUserId: user.id, relatedUserIds: [effectiveId], db });
        actorId = effectiveId;
        const { data: effectiveProfile } = await db
          .from("profiles")
          .select("email, role")
          .eq("id", effectiveId)
          .maybeSingle();
        actorEmail = (effectiveProfile?.email ?? "").trim().toLowerCase() || null;
        actorRole = String(effectiveProfile?.role ?? "").trim().toLowerCase() || portal;
      }
    }

    actorRole = await resolveInboxSenderRoleForPortal(db, {
      userId: actorId,
      legacyRole: actorRole,
      portal,
      isAdmin: admin && actorId === user.id,
    });

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
