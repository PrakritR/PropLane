import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/one-number/admin-leads-guard.server";
import { sendAdminLeadReply } from "@/lib/one-number/admin-lead-reply.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST `{ text }`: admin answers an Unassigned lead from the PropLane line. Admin only. The lead's phone is resolved
 * server-side from the lead id (the browser holds only the masked number) and the send honours STOP/opt-out.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const admin = await requirePlatformAdmin();
  if ("status" in admin) return NextResponse.json({ error: admin.status === 401 ? "Unauthorized." : "Forbidden." }, { status: admin.status });
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Lead not found." }, { status: 404 });
  let body: { text?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const result = await sendAdminLeadReply(createSupabaseServiceRoleClient(), { leadId: id, text: typeof body.text === "string" ? body.text : "" });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}
