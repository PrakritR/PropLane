import { NextResponse } from "next/server";
import { getPortalAccessContext, hasAdminRole, hasRole } from "@/lib/auth/portal-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { buildVendorRemovedEmailBody, vendorRemovedSubject } from "@/lib/vendor-invite-email";

export const runtime = "nodejs";

function vendorNameFromRowData(rowData: unknown): string {
  const row = (rowData && typeof rowData === "object" && !Array.isArray(rowData) ? rowData : {}) as Record<
    string,
    unknown
  >;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  return name;
}

/** Build vendor-removal notification copy without deleting the row. */
export async function POST(req: Request) {
  try {
    const ctx = await getPortalAccessContext();
    if (!ctx.user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (!hasRole(ctx, "manager") && !hasAdminRole(ctx)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      vendorId?: string;
      vendorName?: string;
    };
    const vendorId = String(body.vendorId ?? "").trim();

    if (!vendorId) return NextResponse.json({ error: "vendorId is required." }, { status: 400 });

    const db = createSupabaseServiceRoleClient();
    const { data: vendorRow } = await db
      .from("manager_vendor_records")
      .select("id, manager_user_id, row_data")
      .eq("id", vendorId)
      .maybeSingle();
    if (!vendorRow || vendorRow.manager_user_id !== ctx.user.id) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const vendorName =
      vendorNameFromRowData(vendorRow.row_data) || String(body.vendorName ?? "").trim() || "Vendor";
    const managerName =
      ctx.profile?.full_name?.trim() || ctx.profile?.email?.trim() || ctx.user.email?.trim() || "Your property manager";
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
