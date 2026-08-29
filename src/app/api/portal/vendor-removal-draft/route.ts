import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { buildVendorRemovedEmailBody, vendorRemovedSubject } from "@/lib/vendor-invite-email";

export const runtime = "nodejs";

function canManageVendors(role: string | null | undefined): boolean {
  return role === "admin" || role === "manager" || role === "owner" || role === "pro";
}

/** Build vendor-removal notification copy without deleting the row. */
export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as {
      vendorId?: string;
      vendorName?: string;
    };
    const vendorId = String(body.vendorId ?? "").trim();
    const vendorName = String(body.vendorName ?? "").trim();

    if (!vendorId) return NextResponse.json({ error: "vendorId is required." }, { status: 400 });

    const db = createSupabaseServiceRoleClient();
    const { data: profile } = await db.from("profiles").select("role, full_name, email").eq("id", user.id).maybeSingle();
    if (!canManageVendors(profile?.role)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const { data: vendorRow } = await db
      .from("manager_vendor_records")
      .select("id, manager_user_id")
      .eq("id", vendorId)
      .maybeSingle();
    if (!vendorRow || vendorRow.manager_user_id !== user.id) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const managerName = profile?.full_name?.trim() || profile?.email?.trim() || "Your property manager";
    const subject = vendorRemovedSubject(managerName);
    const text = buildVendorRemovedEmailBody({ vendorName, managerName });

    return NextResponse.json({ ok: true, subject, body: text });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to prepare vendor removal message." },
      { status: 500 },
    );
  }
}
