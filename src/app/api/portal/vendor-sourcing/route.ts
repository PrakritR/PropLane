import { resolveRequestOrigin } from "@/lib/app-url";
import { NextResponse, after } from "next/server";
import { getPortalAccessContext } from "@/lib/auth/portal-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import { sweepVendorSourcing } from "@/lib/vendor-sourcing.server";
import { createVendorQuoteResponseLink } from "@/lib/vendor-quote-contact.server";
import { loadVendorDispatchSettings } from "@/lib/vendor-dispatch-settings";
export const runtime = "nodejs";
async function authorized(workOrderId: string) {
  const access = await getPortalAccessContext();
  if (!access.user) throw new Error("Unauthorized.");
  if (access.effectiveRole !== "manager") throw new Error("Forbidden.");
  const db = createSupabaseServiceRoleClient();
  if ((await resolveAuthenticatedBusinessAccess(access.user.id, db)).kind === "denied") throw new Error("Forbidden.");
  const { data: work, error } = await db.from("portal_work_order_records").select("id,manager_user_id,resident_email,row_data").eq("id", workOrderId).eq("manager_user_id", access.user.id).maybeSingle();
  if (error) throw new Error("Service unavailable.");
  if (!work) throw new Error("Forbidden.");
  return { db, work, userId: access.user.id };
}
async function view(db: ReturnType<typeof createSupabaseServiceRoleClient>, workOrderId: string, owner: string) {
  const { data: job, error } = await db.from("vendor_sourcing_jobs").select("id,state,stage,reason").eq("work_order_id", workOrderId).eq("manager_user_id", owner).maybeSingle();
  if (error) throw new Error("Vendor sourcing unavailable.");
  const { data, error: candidateError } = job ? await db.from("vendor_sourcing_candidates").select("id,source,contact,status,reason,proposal_id").eq("job_id", job.id).eq("manager_user_id", owner).order("created_at") : { data: [], error: null };
  if (candidateError) throw new Error("Vendor sourcing unavailable.");
  return { job: job ? { state: job.state, stage: ["Your vendors", "Shared PropLane vendors", "Web search"][job.stage], reason: job.reason } : null, candidates: (data ?? []).map((c) => ({ id: c.id, source: c.source, name: c.contact?.name || "Vendor", status: c.status, reason: c.reason, sourceUrl: c.contact?.sourceUrl || null, proposal_id: c.proposal_id, coverage: c.contact?.coverage || "Service area unknown" })) };
}
function failure(e: unknown) { const message = e instanceof Error ? e.message : "Vendor sourcing unavailable."; return NextResponse.json({ error: message }, { status: message === "Unauthorized." ? 401 : message === "Forbidden." ? 403 : 409 }); }
export async function GET(req: Request) {
  try { const id = new URL(req.url).searchParams.get("workOrderId")?.trim(); if (!id) throw new Error("Service required."); const { db, userId } = await authorized(id); return NextResponse.json(await view(db, id, userId)); } catch (e) { return failure(e); }
}
export async function POST(req: Request) {
  try {
    const body = await req.json(); const id = typeof body.workOrderId === "string" ? body.workOrderId.trim() : "";
    if (!id || !["start", "pause", "resume", "response_link"].includes(body.action)) throw new Error("Choose a service and sourcing action.");
    const { db, work, userId } = await authorized(id);
    if (body.action === "response_link") {
      if (req.headers.get("sec-fetch-site") === "cross-site" || req.headers.get("origin") !== resolveRequestOrigin(req)) throw new Error("Forbidden.");
      if (typeof body.candidateId !== "string") throw new Error("Choose a vendor.");
      return NextResponse.json(await createVendorQuoteResponseLink(db, { managerUserId: userId, workOrderId: id, candidateId: body.candidateId }), { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action !== "pause") {
      if (!(await loadVendorDispatchSettings(db, userId)).quoteSourcingEnabled) throw new Error("Turn on Find vendors and collect quotes in Services settings.");
      if (!work.resident_email || work.row_data?.managerInitiated || work.row_data?.bucket !== "open" || work.row_data?.vendorId || work.row_data?.selfAssigned) throw new Error("Only open, unassigned resident maintenance services can start sourcing.");
    }
    const { error: insertError } = await db.from("vendor_sourcing_jobs").upsert({ work_order_id: id, manager_user_id: userId }, { onConflict: "work_order_id", ignoreDuplicates: true });
    if (insertError) throw new Error("Vendor sourcing unavailable.");
    const { data: changed, error } = await db.rpc("control_vendor_sourcing", { p_work_order_id: id, p_manager_user_id: userId, p_action: body.action });
    if (error) throw new Error("Vendor sourcing unavailable.");
    if (!changed) throw new Error("This sourcing action is no longer available. Refresh the service.");
    if (body.action !== "pause") after(() => sweepVendorSourcing(db, id).catch(() => console.error("Vendor sourcing wakeup deferred")));
    return NextResponse.json(await view(db, id, userId));
  } catch (e) { return failure(e); }
}
