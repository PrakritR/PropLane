import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/one-number/admin-leads-guard.server";
import { setVendorLeadStatus } from "@/lib/one-number/onboarding/vendor-intake.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/** PATCH `{ action: "approve" | "decline" }`: only a pending lead moves, once. Admin only. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requirePlatformAdmin();
  if ("status" in admin) return NextResponse.json({ error: admin.status === 401 ? "Unauthorized." : "Forbidden." }, { status: admin.status });
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  if (body?.action !== "approve" && body?.action !== "decline") return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
  const ok = await setVendorLeadStatus(createSupabaseServiceRoleClient(), id, body.action === "approve" ? "approved" : "declined");
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not found." }, { status: 404 });
}
