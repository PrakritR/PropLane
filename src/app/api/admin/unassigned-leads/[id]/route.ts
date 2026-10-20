import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/one-number/admin-leads-guard.server";
import { assignLeadToHouse, closeLead } from "@/lib/one-number/unassigned-leads.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadServiceInboxScope } from "@/lib/manager-sms-messages.server";
import { writeAuditLog } from "@/lib/tools/audit";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ASSIGN_STATUS = { lead_not_open: 409, house_not_found: 404, workspace_not_found: 404, unavailable: 503 } as const;

const ADMIN_LEAD_ASSIGN_AUDIT_ACTION = "admin_lead_assign_workspace";

/**
 * PATCH `{ action: "assign", propertyId }`, `{ action: "assign", workspaceId }` or `{ action: "close" }`. Admin only.
 * Assign is the same path the prospect's own pick takes; a `workspaceId` places the thread straight into one PropLane
 * Service workspace (admin Communication's "Assign to a workspace") and writes one audit row.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const admin = await requirePlatformAdmin();
  if ("status" in admin) return NextResponse.json({ error: admin.status === 401 ? "Unauthorized." : "Forbidden." }, { status: admin.status });
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Lead not found." }, { status: 404 });
  let body: { action?: unknown; propertyId?: unknown; workspaceId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const db = createSupabaseServiceRoleClient();
  if (body.action === "close") {
    const closed = await closeLead(db, id);
    return closed ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Lead is not open." }, { status: 409 });
  }
  if (body.action === "assign" && typeof body.workspaceId === "string" && body.workspaceId.trim()) {
    const workspaceId = body.workspaceId.trim().toLowerCase();
    // A body id is a name, not authorization: it must be a PropLane Service workspace.
    const scope = await loadServiceInboxScope(db);
    if (!UUID.test(workspaceId) || !scope.workspaceIds.map((w) => w.toLowerCase()).includes(workspaceId)) {
      return NextResponse.json({ error: "Pick a PropLane Service workspace." }, { status: 404 });
    }
    const result = await assignLeadToHouse(db, { leadId: id, workspaceId, by: "admin" });
    if (!result.ok) return NextResponse.json({ error: result.error === "lead_not_open" ? "Lead is not open." : "Could not assign to that workspace.", reason: result.error }, { status: ASSIGN_STATUS[result.error] });
    const audit = await writeAuditLog(
      { db, landlordId: result.ownerUserId, userId: admin.userId },
      {
        action: ADMIN_LEAD_ASSIGN_AUDIT_ACTION,
        toolName: ADMIN_LEAD_ASSIGN_AUDIT_ACTION,
        inputSummary: { leadId: id, workspaceId: result.workspaceId },
        resultSummary: { applied: true },
        dedupeKey: `${ADMIN_LEAD_ASSIGN_AUDIT_ACTION}:${id}`,
      },
    );
    if (!audit.recorded && !audit.duplicate) console.error("[unassigned-leads] audit row for the workspace assignment was not recorded");
    return NextResponse.json({ ok: true, label: result.label, workspaceId: result.workspaceId, auditRecorded: audit.recorded });
  }
  if (body.action === "assign") {
    const propertyId = typeof body.propertyId === "string" ? body.propertyId.trim() : "";
    if (!propertyId) return NextResponse.json({ error: "Pick a house." }, { status: 400 });
    const result = await assignLeadToHouse(db, { leadId: id, propertyId, by: "admin" });
    if (!result.ok) return NextResponse.json({ error: result.error === "lead_not_open" ? "Lead is not open." : "Could not assign to that house.", reason: result.error }, { status: ASSIGN_STATUS[result.error] });
    return NextResponse.json({ ok: true, label: result.label });
  }
  return NextResponse.json({ error: "Action must be assign or close." }, { status: 400 });
}
