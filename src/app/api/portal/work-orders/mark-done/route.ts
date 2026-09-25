import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import { markWorkOrderDoneByVendor } from "@/lib/work-order-bids.server";
import { stampSmsTestProvenance } from "@/lib/sms/sms-test-provenance.server";

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
  const role = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
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

    // N010: require at least one completion photo before a vendor can mark a
    // service done — mirrors the resident's own required-photo rule on
    // submission. A missing/empty field is a clear 4xx, never a bare 500.
    const completionPhotos = Array.isArray(body.completionPhotoDataUrls)
      ? body.completionPhotoDataUrls.filter(
          (url): url is string => typeof url === "string" && url.trim() !== "",
        )
      : [];
    if (completionPhotos.length === 0) {
      return NextResponse.json(
        { error: "Add at least one completion photo before marking this service done." },
        { status: 400 },
      );
    }

    const result = await markWorkOrderDoneByVendor(db, actor, body);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

    // markWorkOrderDoneByVendor owns the automation-status transition; this
    // route layers the completion photo onto the same row right after, so the
    // shared server lib (out of this task's owned files) stays untouched.
    const workOrderId = String(body.workOrderId ?? "").trim();
    const nextRowData: Record<string, unknown> = {
      ...(result.workOrder as unknown as Record<string, unknown>),
      completionPhotoDataUrls: completionPhotos,
    };
    const { error: photoError } = await db
      .from("portal_work_order_records")
      .update({ row_data: stampSmsTestProvenance(nextRowData) })
      .eq("id", workOrderId);
    if (photoError) {
      return NextResponse.json({ error: photoError.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, workOrder: nextRowData });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not mark done.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
