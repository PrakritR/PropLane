import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { loadDirectoryListedVendors } from "@/lib/vendor-directory.server";

export const runtime = "nodejs";

/** Directory-listed self-serve vendors, public-safe fields only — merged into the manager "PropLane vendors" tab. */
export async function GET(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const admin = await isAdminUser(user.id);
    const { data: profile } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
    const role = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
    if (!admin && role !== "manager" && role !== "pro") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const url = new URL(req.url);
    const rows = await loadDirectoryListedVendors(db, {
      trade: url.searchParams.get("trade") ?? undefined,
      area: url.searchParams.get("area") ?? undefined,
    });
    return NextResponse.json({ rows });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load vendor directory.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
