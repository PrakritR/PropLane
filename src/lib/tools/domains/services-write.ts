/**
 * Gated manager WRITE tool for the Services section: deciding on a resident's
 * add-on service request. (Opening a work order is `create_work_order` in
 * `work-orders.ts`, alongside the rest of the work-order lifecycle.)
 *
 * Both re-resolve their target from the landlord's OWN rows
 * (`manager_user_id = ctx.landlordId`) at preview AND execute time, so a
 * model-supplied id belonging to another landlord can never be acted on. All
 * resident-authored text (a request's notes, a maintenance description) is data
 * that gets rendered on the confirmation card — never an instruction.
 */
import { z } from "zod";
import { defineWriteTool } from "../registry";
import type { ActionPreview } from "../registry";
import type { AgentContext } from "../context";
import { stampSmsTestProvenance } from "@/lib/sms/sms-test-provenance.server";
import type { ServiceRequest } from "@/lib/service-requests-storage";

const decideServiceRequestSchema = z
  .object({
    requestId: z.string().min(1).describe("The request id from list_service_requests."),
    decision: z.enum(["approve", "deny"]).describe("Approve or deny the resident's request."),
    note: z.string().max(1000).optional().describe("Optional note recorded with the decision."),
  })
  .strict();

type DecideServiceRequestInput = z.infer<typeof decideServiceRequestSchema>;

/** The landlord's own service request, by id. Returns null for anyone else's. */
async function loadOwnedServiceRequest(
  ctx: AgentContext,
  requestId: string,
): Promise<ServiceRequest | null> {
  const { data, error } = await ctx.db
    .from("portal_service_request_records")
    .select("id, row_data")
    .eq("manager_user_id", ctx.landlordId)
    .eq("id", requestId.trim())
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = (data as { row_data?: unknown } | null)?.row_data;
  return row ? (row as ServiceRequest) : null;
}

/**
 * Gated write: approve or deny a resident's add-on service request (parking,
 * storage, cleaning, equipment rental — the Services -> Requests tab). Pricing
 * and any resulting charges stay a portal action; this only records the
 * decision, which is what the resident is waiting on.
 */
export const decideServiceRequestTool = defineWriteTool<DecideServiceRequestInput, { reply: string }>({
  name: "decide_service_request",
  description:
    "Approve or deny one of the landlord's pending add-on service requests (parking, storage, cleaning, equipment rentals — the Services -> Requests tab). Use list_service_requests first to get the request id. This records the decision only; it does not set a price or create a charge. The landlord sees the request and must confirm before the decision is recorded.",
  inputSchema: decideServiceRequestSchema,
  preview: async (ctx, input): Promise<ActionPreview> => {
    const request = await loadOwnedServiceRequest(ctx, input.requestId);
    if (!request) throw new Error("That service request isn't in your portfolio.");
    return {
      kind: "decide_service_request",
      title: input.decision === "approve" ? "Approve this request" : "Deny this request",
      confirmLabel: input.decision === "approve" ? "Approve" : "Deny",
      fields: [
        { label: "Service", value: request.offerName || "(untitled request)" },
        { label: "Resident", value: `${request.residentName || "Resident"} (${request.residentEmail})` },
        // Resident-authored text: shown to the landlord as data so they can see
        // exactly what they are approving.
        ...(request.notes ? [{ label: "Resident's note", value: request.notes }] : []),
        { label: "Current status", value: request.status },
        ...(input.note ? [{ label: "Your note", value: input.note }] : []),
      ],
      warnings:
        input.decision === "approve" && !request.price
          ? ["No price is set on this request — set it in Services → Requests before billing the resident."]
          : undefined,
    };
  },
  handler: async (ctx, input) => {
    const request = await loadOwnedServiceRequest(ctx, input.requestId);
    if (!request) throw new Error("That service request isn't in your portfolio.");
    if (request.status !== "pending") {
      return { reply: `That request is already ${request.status}; nothing changed.` };
    }
    const nowIso = new Date().toISOString();
    const status = input.decision === "approve" ? "approved" : "denied";
    const next: ServiceRequest = {
      ...request,
      status,
      ...(input.decision === "approve" ? { approvedAt: nowIso } : { deniedAt: nowIso }),
      ...(input.note ? { managerNote: input.note } : {}),
    };
    const { error } = await ctx.db
      .from("portal_service_request_records")
      .update({ status, row_data: stampSmsTestProvenance(next), updated_at: nowIso })
      .eq("manager_user_id", ctx.landlordId)
      .eq("id", request.id);
    if (error) throw new Error("Could not record the decision.");

    await ctx.db.from("audit_log").insert({
      actor_user_id: ctx.userId,
      landlord_id: ctx.landlordId,
      action: "decide_service_request",
      tool_name: "decide_service_request",
      input_summary: { requestId: request.id, decision: input.decision },
      result_summary: { status },
      created_at: nowIso,
    });

    return {
      reply: `${status === "approved" ? "Approved" : "Denied"} "${request.offerName}" for ${request.residentName || "the resident"}.`,
    };
  },
});

export const managerServicesWriteTools = [decideServiceRequestTool];
