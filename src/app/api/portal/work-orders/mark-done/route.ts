import { projectWorkOrderForHiredVendor } from "@/lib/work-order-vendor-privacy";
import { NextResponse } from "next/server";
import { resolveSessionActorRole } from "@/lib/auth/vendor-api-access";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import { markWorkOrderDoneByVendor } from "@/lib/work-order-bids.server";
import { validateCompletionPhotos } from "@/lib/completion-photos";

export const runtime = "nodejs";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

async function sessionActor(db: Db) {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return null;
  if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") return null;
  const admin = await isAdminUser(user.id);
  const { data: profile } = await db.from("profiles").select("email, role, full_name").eq("id", user.id).maybeSingle();
  const role = await resolveSessionActorRole(profile?.role ?? user.user_metadata?.role);
  return {
    userId: user.id,
    email: (profile?.email ?? user.email ?? "").trim().toLowerCase(),
    fullName: profile?.full_name?.trim() || "",
    admin,
    role,
  };
}

/** Vendor's one-tap "job done" signal — sets automationStatus only, never touches
 * bucket/status. The manager still owns the completion + expense-logging transition
 * via /api/portal/work-orders/approve-pay. */
export async function POST(req: Request) {
  try {
    const db = createSupabaseServiceRoleClient();
    const actor = await sessionActor(db);
    if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as {
      workOrderId?: string;
      note?: string;
      completionPhotoDataUrls?: unknown;
    };

    // N010: at least one completion photo, an image, each under 2 MB decoded. 400 for a missing or
    // non-image photo, 413 for an oversize one - never a bare 500.
    const photos = validateCompletionPhotos(body.completionPhotoDataUrls);
    if (!photos.ok) return NextResponse.json({ error: photos.error }, { status: photos.status });

    // Status and photos land in ONE update inside markWorkOrderDoneByVendor.
    const result = await markWorkOrderDoneByVendor(db, actor, {
      workOrderId: body.workOrderId,
      note: body.note,
      completionPhotoDataUrls: photos.photos,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({ ok: true, workOrder: projectWorkOrderForHiredVendor(result.workOrder) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not mark done.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
