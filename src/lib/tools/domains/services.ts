import { z } from "zod";
import { defineTool } from "../registry";
import type { AgentContext } from "../context";
import type { ServiceRequest } from "@/lib/service-requests-storage";
import { loadAllManagerRows } from "./load-manager-rows";

/** Server-side read of the landlord's service requests, scoped by manager_user_id. */
export async function loadManagerServiceRequests(ctx: AgentContext): Promise<ServiceRequest[]> {
  return loadAllManagerRows(
    ctx,
    "portal_service_request_records",
    (rowData) => rowData as ServiceRequest,
  );
}

/** Safe projection of a service request (no return-photo blob data URLs). */
function summarizeServiceRequest(r: ServiceRequest) {
  return {
    id: r.id,
    offer: r.offerName || null,
    residentName: r.residentName || null,
    residentEmail: (r.residentEmail || "").trim().toLowerCase() || null,
    propertyId: r.propertyId || null,
    status: r.status || null,
    price: r.price || null,
    deposit: r.deposit || null,
    servicePaid: r.servicePaid === true,
    depositPaid: r.depositPaid === true,
    returnByDate: r.returnByDate || null,
    requestedAt: r.requestedAt || null,
    approvedAt: r.approvedAt || null,
    deniedAt: r.deniedAt || null,
  };
}

export const listServiceRequestsTool = defineTool({
  name: "list_service_requests",
  description:
    "List the current landlord's resident add-on service requests (e.g. parking, storage, equipment rentals) with offer, resident, property, status (pending/approved/denied/returned), price, deposit, and payment status. These are add-on services, NOT maintenance work orders — use list_work_orders for maintenance/repair items. Use for 'any pending add-on service requests', 'which services are awaiting approval', etc.",
  kind: "read",
  inputSchema: z
    .object({
      status: z
        .enum(["pending", "approved", "denied", "returned"])
        .optional()
        .describe("Optional filter on service request status."),
    })
    .strict(),
  handler: async (ctx, input) => {
    const requests = (await loadManagerServiceRequests(ctx))
      .filter((r) => !input.status || r.status === input.status)
      .map(summarizeServiceRequest);
    return { count: requests.length, serviceRequests: requests };
  },
});
