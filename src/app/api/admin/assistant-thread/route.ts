import { NextResponse } from "next/server";
import { loadAdminOwnAssistantThread } from "@/lib/communication/admin-assistant-thread.server";
import { requirePlatformAdmin } from "@/lib/one-number/admin-leads-guard.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * The signed-in admin's OWN PropLane Assistant chat (where texts from their verified phone to the PropLane line land).
 * Admin only; the thread is derived from the session, never from the request, so it can only ever be the viewer's.
 */
export async function GET() {
  const admin = await requirePlatformAdmin();
  if ("status" in admin) return NextResponse.json({ error: admin.status === 401 ? "Unauthorized." : "Forbidden." }, { status: admin.status });
  const thread = await loadAdminOwnAssistantThread(createSupabaseServiceRoleClient(), admin.userId);
  return NextResponse.json({ thread }, { headers: { "Cache-Control": "private, no-store" } });
}
