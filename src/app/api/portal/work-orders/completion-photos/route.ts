import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import { signCompletionPhotoPaths, COMPLETION_PHOTO_SIGNED_URL_TTL_SECONDS } from "@/lib/completion-photo-storage.server";
import { mayReadWorkOrderRecord } from "@/lib/work-order-record-access.server";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

export const runtime = "nodejs";

/**
 * Signed URLs for a service's completion photos. Readable by exactly who may read the record
 * itself: the owning manager, the vendor who did the work, and a co-manager holding the house
 * with Services access — anyone else gets the same 404 the record read gives them.
 */
export async function GET(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const workOrderId = new URL(req.url).searchParams.get("workOrderId")?.trim();
    if (!workOrderId) return NextResponse.json({ error: "workOrderId required." }, { status: 400 });

    const db = createSupabaseServiceRoleClient();
    if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    const { data: wo } = await db
      .from("portal_work_order_records")
      .select("manager_user_id, vendor_user_id, row_data")
      .eq("id", workOrderId)
      .maybeSingle();
    const rowData = (wo?.row_data as DemoManagerWorkOrderRow | null) ?? null;
    const allowed =
      Boolean(wo) &&
      (await mayReadWorkOrderRecord(db, user.id, {
        managerUserId: wo!.manager_user_id as string | null,
        vendorUserId: wo!.vendor_user_id as string | null,
        rowData,
      }));
    if (!allowed) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const paths = (rowData?.completionPhotoPaths ?? []).filter((p): p is string => typeof p === "string");
    const urls = await signCompletionPhotoPaths(db, { managerUserId: String(wo!.manager_user_id), workOrderId, paths });
    return NextResponse.json({ urls, expiresInSeconds: COMPLETION_PHOTO_SIGNED_URL_TTL_SECONDS });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not load photos." }, { status: 500 });
  }
}
