import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import { signCompletionPhotoPaths } from "@/lib/completion-photo-storage.server";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

export const runtime = "nodejs";

/** Signed URLs for a service's completion photos. Readable by the owning manager and the vendor who did the work. */
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
    if (!wo || (wo.manager_user_id !== user.id && wo.vendor_user_id !== user.id)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const paths = ((wo.row_data as DemoManagerWorkOrderRow | null)?.completionPhotoPaths ?? []).filter(
      (p): p is string => typeof p === "string",
    );
    const urls = await signCompletionPhotoPaths(db, { managerUserId: String(wo.manager_user_id), workOrderId, paths });
    return NextResponse.json({ urls });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not load photos." }, { status: 500 });
  }
}
