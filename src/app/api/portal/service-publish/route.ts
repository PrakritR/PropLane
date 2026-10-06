import { NextResponse } from "next/server";
import { publishServiceToBoard, unpublishServiceFromBoard } from "@/lib/service-work-board.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

/**
 * Publish a service to the vendor work board, or take it off (vendor-work-share-1006). The manager
 * is the session user and owns the service by its row, never by the body. A published service is
 * shown to signed-in vendors only, through `publicServiceProjection`.
 */
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const db = createSupabaseServiceRoleClient();
    if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind !== "normal") {
      return NextResponse.json({ error: "Publishing is unavailable for this account." }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      workOrderId?: string;
      action?: "publish" | "unpublish";
      budgetCents?: number | null;
      sharePhotos?: boolean;
    };
    const workOrderId = typeof body.workOrderId === "string" ? body.workOrderId.trim() : "";
    const actor = { userId: user.id, role: "manager", admin: false };

    if (body.action === "unpublish") {
      const result = await unpublishServiceFromBoard(db, actor, { workOrderId });
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
      return NextResponse.json({ ok: true, published: false });
    }
    const result = await publishServiceToBoard(db, actor, {
      workOrderId,
      budgetCents: typeof body.budgetCents === "number" ? body.budgetCents : null,
      sharePhotos: body.sharePhotos === true,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, published: true, patch: result.patch });
  } catch {
    return NextResponse.json({ error: "Failed to update the service." }, { status: 500 });
  }
}
