import { z } from "zod";
import { defineTool, defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import { updateAuditResult, writeAuditLog } from "../audit";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { rowAllowedInAgentWorkspace } from "@/lib/agent/manager-workspace-scope";
import { canActorApprove, loadAttempts, loadRunByHandle, loadVendorContacts, vendorNamesForApproval } from "@/lib/vendor-dispatch/engine.server";
import { matchDispatchRule } from "@/lib/vendor-dispatch/match.server";
import { approveDispatchRun, createDispatchRun } from "@/lib/vendor-dispatch/runs.server";
import { payLabel } from "@/lib/vendor-dispatch/text";
import { VENDOR_TRADES, tradeDefinition } from "@/lib/vendor-dispatch/trades";
import { resolveOwnerAndWorkspace } from "@/lib/vendor-dispatch/triggers.server";
import { inferDispatchFromService } from "@/lib/vendor-dispatch/triage";
import { workOrderGeneralArea } from "@/lib/work-order-vendor-privacy";
import { firstNameOf } from "@/lib/vendor-dispatch/text";

/**
 * The manager's dispatch tools (vendor-dispatch-1018). Both ride the one write-action
 * framework: the manager's YES at the confirm gate is the approval, the owner and workspace
 * come from the authenticated context, and every id the model passes is re-verified here.
 *  - `list_vendor_dispatches` reads what is waiting.
 *  - `approve_vendor_dispatch` is the SMS approval, but for "approve the plumber" in chat.
 *  - `dispatch_vendor` is "send the plumber to the 8th Ave leak" on an existing service.
 */

async function loadOwnedWorkOrder(ctx: AgentContext, workOrderId: string) {
  const { data, error } = await ctx.db
    .from("portal_work_order_records")
    .select("id, vendor_user_id, row_data")
    .eq("id", workOrderId.trim())
    .eq("manager_user_id", ctx.landlordId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = (data.row_data ?? {}) as DemoManagerWorkOrderRow;
  if (!rowAllowedInAgentWorkspace(ctx, row)) return null;
  return { id: String(data.id), row };
}

/** The status of the newest dispatch run filed for a service, or null when it has none. */
async function latestRunStatus(db: AgentContext["db"], workOrderId: string): Promise<string | null> {
  const { data, error } = await db
    .from("vendor_dispatch_runs")
    .select("status, created_at")
    .eq("source_type", "work_order")
    .eq("source_id", workOrderId);
  if (error || !Array.isArray(data) || data.length === 0) return null;
  const newest = [...(data as Array<{ status: string; created_at: string }>)].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  return newest?.status ?? null;
}

export const listVendorDispatchesTool = defineTool({
  name: "list_vendor_dispatches",
  description:
    "List vendor dispatch runs that need the landlord's attention: jobs waiting for approval before any vendor is texted, jobs being offered, and jobs nobody took. Returns each run's number (handle), what it is, the house and the vendors in order. Use before approve_vendor_dispatch.",
  kind: "read",
  inputSchema: z.object({}).strict(),
  handler: async (ctx) => {
    const { data, error } = await ctx.db
      .from("vendor_dispatch_runs")
      .select("id, handle, trade, issue, urgency, status, source_type, details, property_id, pay_cents, mode, workspace_id")
      .eq("owner_user_id", ctx.landlordId)
      .in("status", ["awaiting_approval", "offering", "exhausted"]);
    if (error) return { count: 0, runs: [] };
    const runs = [] as Array<Record<string, unknown>>;
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const workspaceId = ctx.workspace?.id?.trim();
      if (workspaceId && row.workspace_id !== workspaceId) continue;
      const attempts = await loadAttempts(ctx.db, String(row.id));
      const contacts = await loadVendorContacts(ctx.db, ctx.landlordId, attempts.map((attempt) => attempt.vendor_directory_id));
      const details = (row.details ?? {}) as Record<string, unknown>;
      runs.push({
        handle: row.handle,
        status: row.status,
        what: details.what ?? row.trade,
        house: details.houseLabel ?? null,
        urgency: row.urgency,
        pay: payLabel({ payCents: row.pay_cents as number | null, payModel: details.payModel as string | undefined }),
        mode: row.mode,
        vendors: vendorNamesForApproval(attempts, contacts),
      });
    }
    return { count: runs.length, runs };
  },
});

const approveSchema = z
  .object({
    handle: z.number().int().min(1).describe("The run number from list_vendor_dispatches (the # in the approval text)."),
    pickPosition: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Send ONLY the vendor at this 1-based position in the chain instead of the whole chain."),
  })
  .strict();

export const approveVendorDispatchTool = defineWriteTool({
  name: "approve_vendor_dispatch",
  description:
    "Approve a vendor dispatch that is waiting for the landlord's permission, so the vendors on its chain are texted (the first one, or several for a broadcast). Nothing reaches a vendor until this is approved. Pass the run number from list_vendor_dispatches.",
  inputSchema: approveSchema,
  preview: async (ctx, input) => {
    const run = await loadRunByHandle(ctx.db, ctx.landlordId, input.handle);
    if (!run) throw new Error("No dispatch with that number belongs to this landlord. Use list_vendor_dispatches.");
    if (run.status !== "awaiting_approval") throw new Error(`Dispatch #${run.handle} is ${run.status.replace(/_/g, " ")}, not waiting for approval.`);
    if (ctx.workspace?.id && run.workspace_id !== ctx.workspace.id) throw new Error("That dispatch belongs to another workspace.");
    if (!(await canActorApprove(ctx.db, run, ctx.userId))) throw new Error("You do not have access to approve this dispatch.");
    const attempts = await loadAttempts(ctx.db, run.id);
    const contacts = await loadVendorContacts(ctx.db, run.owner_user_id, attempts.map((attempt) => attempt.vendor_directory_id));
    const queued = attempts.filter((attempt) => attempt.status === "queued");
    const names = vendorNamesForApproval(attempts, contacts);
    if (input.pickPosition && !queued.some((attempt) => attempt.position === input.pickPosition! - 1)) {
      throw new Error(`There is no vendor number ${input.pickPosition} on this dispatch.`);
    }
    const target = input.pickPosition ? contacts.get(queued.find((attempt) => attempt.position === input.pickPosition! - 1)!.vendor_directory_id)?.name ?? "that vendor" : names.join(", then ");
    return {
      kind: "approve_vendor_dispatch",
      title: "Approve vendor dispatch",
      summary: `Approve dispatch #${run.handle}: text ${target || "the vendor"} the job.`,
      confirmLabel: "Approve and text",
      fields: [
        { label: "Job", value: String(run.details.what || run.trade) },
        { label: "House", value: String(run.details.houseLabel || "—") },
        { label: "Vendors", value: target || "—" },
        { label: "Pay", value: payLabel({ payCents: run.pay_cents, payModel: run.details.payModel as string | undefined }) },
        { label: "What the vendor reads", value: run.offer_text },
      ],
    };
  },
  handler: async (ctx, input) => {
    const run = await loadRunByHandle(ctx.db, ctx.landlordId, input.handle);
    if (!run) throw new Error("No matching dispatch for this landlord.");
    const dedupeKey = `approve_vendor_dispatch:${ctx.landlordId}:${run.id}`;
    const audit = await writeAuditLog(ctx, {
      action: "approve_vendor_dispatch",
      toolName: "approve_vendor_dispatch",
      inputSummary: { runId: run.id, handle: run.handle, pickPosition: input.pickPosition ?? null },
      dedupeKey,
    });
    if (!audit.recorded && audit.duplicate) return { reply: `Dispatch #${run.handle} was already approved.` };
    if (!audit.recorded) throw new Error("Could not record the approval; nothing was sent.");
    // The key is permanent only once vendors were really texted; every failure frees it so a retry can run.
    const fail = async (error: string, message: string): Promise<never> => {
      await updateAuditResult(ctx, dedupeKey, { error }, { clearDedupeKey: true });
      throw new Error(message);
    };
    let result: Awaited<ReturnType<typeof approveDispatchRun>>;
    try {
      result = await approveDispatchRun(ctx.db, {
        ownerUserId: run.owner_user_id,
        actorUserId: ctx.userId,
        channel: "sms",
        runId: run.id,
        pickPosition: input.pickPosition ? input.pickPosition - 1 : null,
        rawText: "approved in chat",
      });
    } catch (error) {
      return fail("approve_threw", error instanceof Error ? error.message : "Could not approve the dispatch.");
    }
    if (!result.ok) {
      return fail(
        result.reason,
        result.reason === "wrong_state"
          ? `Dispatch #${run.handle} is no longer waiting for approval.`
          : result.reason === "not_allowed"
            ? "You do not have access to approve this dispatch."
            : "Nobody is left to text for this dispatch.",
      );
    }
    await updateAuditResult(ctx, dedupeKey, { approved: true, runId: run.id });
    return { reply: `Approved dispatch #${run.handle}. The vendor is being texted now.` };
  },
});

const dispatchSchema = z
  .object({
    workOrderId: z.string().min(1).describe("The service's id (from list_work_orders)."),
    trade: z
      .enum(VENDOR_TRADES.map((trade) => trade.id) as [string, ...string[]])
      .optional()
      .describe("The vendor role to send (plumber, locksmith, cleaner...). Omit to infer it from the service's category."),
  })
  .strict();

export const dispatchVendorTool = defineWriteTool({
  name: "dispatch_vendor",
  description:
    "Send a vendor role to an existing service ('send the plumber to the 8th Ave leak'): offers it down the landlord's dispatch rule for that trade and house, or the matching vendors on file. The landlord's confirmation is the approval; the first vendor on the chain is texted right away and the next ones follow if they decline or do not answer.",
  inputSchema: dispatchSchema,
  preview: async (ctx, input) => {
    const owned = await loadOwnedWorkOrder(ctx, input.workOrderId);
    if (!owned) throw new Error("No service with this id belongs to this landlord. Use list_work_orders for valid ids.");
    const { row } = owned;
    if (row.vendorId || row.selfAssigned) throw new Error("A vendor or teammate is already assigned to this service.");
    if (row.bucket === "completed") throw new Error("This service is already completed.");
    const inferred = inferDispatchFromService(row);
    const trade = input.trade ?? inferred?.trade;
    if (!trade || !tradeDefinition(trade)) throw new Error("Say which vendor role to send (plumber, locksmith, handyman...).");
    const propertyId = row.assignedPropertyId || row.propertyId || null;
    const scope = await resolveOwnerAndWorkspace(ctx.db, { ownerUserId: ctx.landlordId, propertyId });
    if (!scope) throw new Error("Could not place this service in a workspace.");
    const match = await matchDispatchRule(ctx.db, {
      workspaceId: scope.workspaceId,
      ownerUserId: scope.ownerUserId,
      trade,
      issue: inferred?.trade === trade ? inferred.issue : null,
      propertyId,
      urgency: inferred?.urgency ?? "routine",
      workOrder: row,
    });
    if (match.chain.length === 0) throw new Error(`No ${tradeDefinition(trade)!.label.toLowerCase()} on file can be texted for this house. Add one in Vendors.`);
    return {
      kind: "dispatch_vendor",
      title: "Dispatch a vendor",
      summary: `Text ${match.chain[0]!.name}${match.chain.length > 1 ? ` (then ${match.chain.slice(1, 3).map((v) => v.name).join(", ")} if busy)` : ""} about "${row.title || owned.id}".`,
      confirmLabel: "Send the job",
      fields: [
        { label: "Service", value: row.title || owned.id },
        { label: "House", value: row.propertyName || "—" },
        { label: "Role", value: tradeDefinition(trade)!.label },
        { label: "Vendors", value: match.chain.map((vendor) => vendor.name).join(", then ") },
        { label: "Vendors see", value: `the area (${workOrderGeneralArea(row)}) until they accept` },
      ],
    };
  },
  handler: async (ctx, input) => {
    const owned = await loadOwnedWorkOrder(ctx, input.workOrderId);
    if (!owned) throw new Error("No matching service for this landlord.");
    const { row } = owned;
    if (row.vendorId || row.selfAssigned) throw new Error("A vendor or teammate is already assigned to this service.");
    const inferred = inferDispatchFromService(row);
    const trade = input.trade ?? inferred?.trade;
    if (!trade) throw new Error("Say which vendor role to send.");
    const propertyId = row.assignedPropertyId || row.propertyId || null;
    const scope = await resolveOwnerAndWorkspace(ctx.db, { ownerUserId: ctx.landlordId, propertyId });
    if (!scope) throw new Error("Could not place this service in a workspace.");
    const dedupeKey = `dispatch_vendor:${ctx.landlordId}:${owned.id}`;
    const auditArgs = {
      action: "dispatch_vendor",
      toolName: "dispatch_vendor",
      inputSummary: { workOrderId: owned.id, trade },
      dedupeKey,
    };
    let audit = await writeAuditLog(ctx, auditArgs);
    if (!audit.recorded && audit.duplicate && (await latestRunStatus(ctx.db, owned.id)) === "exhausted") {
      // The earlier dispatch ran out of vendors: this is a new request, not a double confirm.
      await updateAuditResult(ctx, dedupeKey, { superseded: "exhausted" }, { clearDedupeKey: true });
      audit = await writeAuditLog(ctx, auditArgs);
    }
    if (!audit.recorded && audit.duplicate) return { reply: "This service was already sent to a vendor." };
    if (!audit.recorded) throw new Error("Could not record the action; nothing was sent.");
    // The key stays only when this call really started a dispatch; every other outcome frees it.
    const fail = async (error: string, message: string): Promise<never> => {
      await updateAuditResult(ctx, dedupeKey, { error }, { clearDedupeKey: true });
      throw new Error(message);
    };
    const release = (outcome: string) => updateAuditResult(ctx, dedupeKey, { outcome }, { clearDedupeKey: true });
    let created: Awaited<ReturnType<typeof createDispatchRun>>;
    try {
      created = await createDispatchRun(ctx.db, {
        workspaceId: scope.workspaceId,
        ownerUserId: scope.ownerUserId,
        sourceType: "work_order",
        sourceId: owned.id,
        trade,
        issue: inferred?.trade === trade ? inferred.issue : null,
        urgency: inferred?.urgency ?? "routine",
        propertyId,
        createdBy: ctx.userId,
        residentEmail: row.residentEmail ?? null,
        workOrder: row,
        skipApprovalRequest: true,
        restartExhausted: true,
        details: {
          what: row.title || undefined,
          area: workOrderGeneralArea(row),
          houseLabel: row.propertyName || "",
          address: row.propertyAddress || "",
          room: row.unit && row.unit !== "—" ? row.unit : undefined,
          personFirstName: firstNameOf(row.residentName),
          summary: row.description || undefined,
        },
      });
    } catch (error) {
      return fail("create_threw", error instanceof Error ? error.message : "Could not start the dispatch.");
    }
    if (!created.ok) {
      return fail(created.reason, created.reason === "no_vendors" ? "No vendor on file can be texted for this job." : "Could not start the dispatch.");
    }
    const { run } = created;
    if (!created.created) {
      // A run for this service already exists: say what it is doing, never "started".
      if (run.status === "accepted") {
        await release("already_accepted");
        const contacts = run.accepted_vendor_directory_id
          ? await loadVendorContacts(ctx.db, run.owner_user_id, [run.accepted_vendor_directory_id]).catch(() => new Map())
          : new Map();
        const name = run.accepted_vendor_directory_id ? contacts.get(run.accepted_vendor_directory_id)?.name : null;
        return { reply: `Dispatch #${run.handle} was already accepted${name ? ` by ${name}` : ""}. Nothing new was sent.` };
      }
      if (run.status === "exhausted") {
        await release("exhausted");
        return { reply: `Every vendor on dispatch #${run.handle} declined or did not answer. Ask me to dispatch again to restart it, or add another vendor in Vendors.` };
      }
      if (run.status === "offering") {
        return { reply: `Dispatch #${run.handle} is already out to a vendor. Nothing new was sent.` };
      }
    }
    if (run.status === "awaiting_approval") {
      let approved: Awaited<ReturnType<typeof approveDispatchRun>>;
      try {
        approved = await approveDispatchRun(ctx.db, {
          ownerUserId: scope.ownerUserId,
          actorUserId: ctx.userId,
          channel: "sms",
          runId: run.id,
          rawText: "dispatched in chat",
        });
      } catch (error) {
        return fail("approve_threw", error instanceof Error ? error.message : "The dispatch was created but could not be started. Approve it from Services.");
      }
      if (!approved.ok) return fail(approved.reason, "The dispatch was created but could not be started. Approve it from Services.");
    }
    await updateAuditResult(ctx, dedupeKey, { runId: run.id, started: true });
    return { reply: `Dispatch #${run.handle} started. The first vendor is being texted now.` };
  },
});

export const managerDispatchTools = [listVendorDispatchesTool, approveVendorDispatchTool, dispatchVendorTool];
