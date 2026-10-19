import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/one-number/admin-leads-guard.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  attestPolicy,
  endPolicy,
  loadPolicy,
  sendPolicyForSignature,
  updateDraftPolicy,
} from "@/lib/owner-management/policies.server";
import { parseTermsBody, policyErrorResponse, presentPolicy } from "@/lib/owner-management/policies-api.server";

export const runtime = "nodejs";

/** PATCH { action: "update" | "send" | "attest" | "end", ... }. Admin only; the workspace comes from the stored row. */
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const admin = await requirePlatformAdmin();
  if ("status" in admin) return NextResponse.json({ error: admin.status === 401 ? "Unauthorized." : "Forbidden." }, { status: admin.status });
  const actor = { role: "admin" as const, userId: admin.userId };
  const { id } = await context.params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const db = createSupabaseServiceRoleClient();
  try {
    if (body.action === "send") {
      const result = await sendPolicyForSignature(db, actor, id);
      return NextResponse.json({ policy: presentPolicy(result.policy), emailed: result.emailed, texted: result.texted });
    }
    if (body.action === "attest") {
      return NextResponse.json({ policy: presentPolicy(await attestPolicy(db, actor, id, String(body.note ?? ""))) });
    }
    if (body.action === "end") {
      return NextResponse.json({ policy: presentPolicy(await endPolicy(db, actor, id)) });
    }
    if (body.action === "update") {
      const current = await loadPolicy(db, id);
      if (!current) return NextResponse.json({ error: "Fee policy not found." }, { status: 404 });
      const terms = parseTermsBody(body, current.terms);
      if (!terms) return NextResponse.json({ error: "Check the fee amounts." }, { status: 400 });
      const row = await updateDraftPolicy(db, actor, id, {
        terms,
        ...(typeof body.effectiveFrom === "string" ? { effectiveFrom: body.effectiveFrom.trim() } : {}),
        ...(typeof body.ownerUserId === "string" ? { ownerUserId: body.ownerUserId.trim() } : {}),
      });
      return NextResponse.json({ policy: presentPolicy(row) });
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (e) {
    return policyErrorResponse(e, "Could not update the fee policy.");
  }
}
