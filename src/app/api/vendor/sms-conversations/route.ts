import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { fetchVendorSmsConversation } from "@/lib/manager-sms-messages.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/** The vendor's texts with each manager workspace (linked by account or verified phone), one conversation per workspace. */
export async function GET() {
  // Role comes from profile_roles (multi-role accounts), never the legacy profiles.role.
  const access = await requireVendorApiAccess();
  if (!access.ok) {
    return NextResponse.json(
      { error: access.status === 401 ? "Unauthorized." : "Vendor access required." },
      { status: access.status },
    );
  }

  try {
    const payload = await fetchVendorSmsConversation(createSupabaseServiceRoleClient(), access.actor.userId);
    return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load SMS.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
