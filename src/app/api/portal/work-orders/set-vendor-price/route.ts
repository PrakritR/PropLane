import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import { setVendorPriceForWorkOrder } from "@/lib/work-order-bids.server";

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
  const { data: profile } = await db.from("profiles").select("email, role").eq("id", user.id).maybeSingle();
  const role = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  return { userId: user.id, email: "", fullName: "", admin, role };
}

/** Vendor sets labor + materials on a scheduled work order before marking done.
 * Updates the work order row the manager uses for outgoing vendor payment. */
export async function POST(req: Request) {
  try {
    const db = createSupabaseServiceRoleClient();
    const actor = await sessionActor(db);
    if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as {
      workOrderId?: string;
      amountCents?: number;
      materialsCents?: number;
    };

    const result = await setVendorPriceForWorkOrder(db, actor, body);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, workOrder: result.workOrder });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not save price.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
