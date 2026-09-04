/**
 * The vendor agent's ENTIRE capability surface: three reads pinned to the one
 * work order the session was created for, plus escalate_to_manager — the only
 * write, autonomously callable (allowlisted) because its sole side effect is
 * messaging the owning manager. No reschedule or pricing tools exist on
 * purpose: answer-only v1 is enforced structurally, not by prompt.
 */
import { z } from "zod";
import { defineTool, defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { track } from "@/lib/analytics/posthog";
import { resolveWorkOrderAccessInfo } from "@/lib/property-access-info";
import { loadVendorDispatchSettings } from "@/lib/vendor-dispatch-settings";
import type { WorkOrderRowWithDispatch } from "@/lib/work-order-dispatch";

export const ESCALATE_TOOL_NAME = "escalate_to_manager";

/** The one work order this session may see, re-verified against the landlord scope. */
async function loadScopedWorkOrder(
  ctx: AgentContext,
): Promise<{ row: WorkOrderRowWithDispatch; vendorUserId: string | null } | null> {
  const scope = ctx.vendorScope;
  if (!scope) return null;
  const { data } = await ctx.db
    .from("portal_work_order_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .eq("id", scope.workOrderId)
    .eq("manager_user_id", ctx.landlordId)
    .maybeSingle();
  const row = (data?.row_data ?? null) as WorkOrderRowWithDispatch | null;
  if (!row) return null;
  // A vendor loses read access the moment the manager reassigns the work order
  // to someone else (mirrors the portal GET route's vendor_user_id scoping).
  if (row.vendorId !== scope.vendorDirectoryId || row.selfAssigned) return null;
  return { row, vendorUserId: (data?.vendor_user_id as string | null) ?? null };
}

function firstName(full: string | undefined): string | null {
  const name = (full ?? "").trim().split(/\s+/)[0];
  return name || null;
}

export const getJobDetailsTool = defineTool({
  name: "get_job_details",
  description:
    "Details of THIS job: title, problem description, category, priority, status, property and unit, street address, scheduled visit time, and the resident's arrival preference. Use this before answering any question about the job.",
  kind: "read",
  inputSchema: z.object({}).strict(),
  handler: async (ctx) => {
    const scoped = await loadScopedWorkOrder(ctx);
    if (!scoped) return { found: false };
    const { row } = scoped;
    const { data: managerProfile } = await ctx.db
      .from("profiles")
      .select("full_name")
      .eq("id", ctx.landlordId)
      .maybeSingle();
    // Deliberately excluded: resident contact info, photos, costs/financials,
    // and entry codes (those come only from get_job_access_info).
    return {
      found: true,
      job: {
        id: row.id,
        reference: row.reference || null,
        title: row.title || null,
        description: row.description || null,
        category: row.category ?? null,
        priority: row.priority || null,
        status: row.status || null,
        stage: row.bucket,
        property: row.propertyName || null,
        unit: row.unit && row.unit !== "—" ? row.unit : null,
        address: row.propertyAddress ?? null,
        scheduledAtIso: row.scheduledAtIso ?? null,
        scheduledLabel: row.scheduled || null,
        residentArrivalPreference: row.preferredArrival ?? null,
        residentFirstName: firstName(row.residentName),
        managerName: (managerProfile?.full_name as string | null)?.trim() || "the property manager",
        vendorMarkedDone: row.automationStatus === "vendor_marked_done" || row.automationStatus === "paid",
      },
    };
  },
});

export const getJobAccessInfoTool = defineTool({
  name: "get_job_access_info",
  description:
    "Entry and access details for THIS job (gate code, lockbox code and location, entry notes, permission to enter). Only available once the vendor is assigned AND the visit is scheduled — otherwise it returns available: false and you must escalate instead of guessing.",
  kind: "read",
  inputSchema: z.object({}).strict(),
  handler: async (ctx) => {
    const scope = ctx.vendorScope;
    const scoped = await loadScopedWorkOrder(ctx);
    if (!scope || !scoped) return { available: false, reason: "job_not_found" };
    const { row } = scoped;
    const isAssignedVendor = row.vendorId === scope.vendorDirectoryId && !row.selfAssigned;
    if (!isAssignedVendor || row.bucket !== "scheduled") {
      return { available: false, reason: "not_assigned_or_not_scheduled" };
    }
    const access = await resolveWorkOrderAccessInfo(ctx.db, row);
    const hasAnything = Boolean(
      access.gateCode || access.lockboxCode || access.lockboxLocation || access.entryNotes || access.residentEntryNotes || access.permissionToEnter,
    );
    if (!hasAnything) return { available: false, reason: "no_access_info_on_file" };
    return { available: true, access };
  },
});

export const listMyJobsWithThisManagerTool = defineTool({
  name: "list_my_jobs_with_this_manager",
  description:
    "The vendor's other active jobs under this same manager (id, title, property, stage, scheduled time). Use only to disambiguate when the vendor seems to be asking about a different job than this conversation's.",
  kind: "read",
  inputSchema: z.object({}).strict(),
  handler: async (ctx) => {
    const scope = ctx.vendorScope;
    if (!scope) return { jobs: [] };
    const { data } = await ctx.db
      .from("portal_work_order_records")
      .select("id, vendor_user_id, row_data")
      .eq("manager_user_id", ctx.landlordId)
      .order("updated_at", { ascending: false })
      .limit(100);
    const jobs = ((data ?? []) as { vendor_user_id: string | null; row_data: WorkOrderRowWithDispatch }[])
      .map((r) => r.row_data)
      .filter(Boolean)
      .filter((row) => row.vendorId === scope.vendorDirectoryId && !row.selfAssigned)
      .filter((row) => row.bucket !== "completed")
      .slice(0, 10)
      .map((row) => ({
        id: row.id,
        reference: row.reference || null,
        title: row.title || null,
        property: row.propertyName || null,
        stage: row.bucket,
        scheduledLabel: row.scheduled || null,
      }));
    return { jobs };
  },
});

export const escalateToManagerTool = defineWriteTool({
  name: ESCALATE_TOOL_NAME,
  description:
    "Notify the property manager that the vendor needs something you cannot decide: a schedule change, price or scope change, missing access info, a cancellation, or anything else needing a human decision. Call at most once per issue, with a short factual summary of what the vendor asked.",
  inputSchema: z
    .object({
      summary: z.string().min(1).max(500).describe("One or two factual sentences describing what the vendor needs."),
      urgency: z.enum(["normal", "urgent"]).describe("urgent only for same-day blockers like being locked out on site."),
    })
    .strict(),
  // The SMS surface allow-lists this tool so it runs inline (there is no human
  // on the other end of a webhook to confirm). The preview exists so the tool
  // is still previewable wherever it is NOT allow-listed.
  preview: async (ctx, input) => ({
    kind: ESCALATE_TOOL_NAME,
    title: "Notify the manager",
    summary: "Send the manager a note that this vendor needs a human decision.",
    fields: [
      { label: "Summary", value: input.summary },
      { label: "Urgency", value: input.urgency },
    ],
    confirmLabel: "Notify manager",
  }),
  handler: async (ctx, input) => {
    const scope = ctx.vendorScope;
    const scoped = await loadScopedWorkOrder(ctx);
    if (!scope || !scoped) return { ok: false, error: "No job bound to this conversation." };
    const { row } = scoped;

    // One escalation per session-hour: an injection or repeat-question flood
    // collapses to a single manager notification.
    const hourBucket = new Date().toISOString().slice(0, 13);
    const dedupeKey = `vendor_agent_escalate:${scope.sessionId}:${hourBucket}`;
    const { error: auditError } = await ctx.db.from("audit_log").insert({
      actor_user_id: scope.vendorUserId ?? ctx.landlordId,
      landlord_id: ctx.landlordId,
      action: "vendor_agent_escalate",
      tool_name: ESCALATE_TOOL_NAME,
      input_summary: { workOrderId: scope.workOrderId, urgency: input.urgency, summary: input.summary.slice(0, 200) },
      dedupe_key: dedupeKey,
      created_at: new Date().toISOString(),
    });
    if (auditError) {
      if (auditError.code === "23505") {
        return { ok: true, alreadyEscalated: true, message: "The manager was already notified about this a moment ago." };
      }
      return { ok: false, error: "Could not record the escalation." };
    }

    const settings = await loadVendorDispatchSettings(ctx.db, ctx.landlordId);
    const vendorLabel = row.vendorName || "The vendor";
    await notifyManagerFromAgent(ctx.db, {
      landlordId: ctx.landlordId,
      subject: `${input.urgency === "urgent" ? "Urgent vendor question" : "Vendor question"}: ${row.title}`,
      text: [
        `${vendorLabel} needs you on "${row.title}" at ${row.propertyName}:`,
        "",
        input.summary,
        "",
        "Reply to the vendor from Work orders or your inbox.",
      ].join("\n"),
      threadType: "vendor_agent_escalation",
      notify: settings.notify,
    });
    await ctx.db.from("agent_sessions").update({ status: "escalated", updated_at: new Date().toISOString() }).eq("id", scope.sessionId);
    track("vendor_agent_escalated", ctx.landlordId, { work_order_id: scope.workOrderId, urgency: input.urgency });
    return { ok: true, message: "The manager has been notified and will follow up." };
  },
});
