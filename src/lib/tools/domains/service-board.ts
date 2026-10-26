import { z } from "zod";
import { defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import { writeAuditLog } from "../audit";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { rowAllowedInAgentWorkspace } from "@/lib/agent/manager-workspace-scope";
import { publicServiceTradeLabel } from "@/lib/public-service-projection";
import { publishServiceToBoard, serviceIsOpenToNewRequests } from "@/lib/service-work-board.server";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import { workOrderGeneralArea } from "@/lib/work-order-vendor-privacy";

/**
 * `post_service_to_board`: put one of the manager's open services on the public vendor work board.
 * It wraps `publishServiceToBoard`, the same call behind `POST /api/portal/service-publish`, with the
 * same checks: the signed-in user is the manager and owns the service by its row (never by the model's
 * id), a business account in good standing, and the service is open. A delegated co-manager never gets
 * this tool (it is not in `CO_MANAGER_SCOPED_TOOLS`), and the owner check below refuses one anyway.
 * What goes public is the board's own projection: the trade, the title and the general area only.
 */

const CATEGORIES = ["cleaning", "plumbing", "mold", "electrical", "hvac", "general", "appliance", "access", "tours"] as const;

const postSchema = z
  .object({
    workOrderId: z.string().min(1).describe("The service's id (from list_work_orders)."),
    category: z
      .enum(CATEGORIES)
      .optional()
      .describe("Board category override, e.g. tours for a tour-host job. Omit to keep the service's own category."),
  })
  .strict();

type OwnedService = { id: string; row: DemoManagerWorkOrderRow; vendorUserId: string | null };

async function loadOwnedService(ctx: AgentContext, workOrderId: string): Promise<OwnedService> {
  // The route's rule: the session user is the manager. A delegated turn (someone else's number) never posts.
  if (ctx.landlordId !== ctx.userId || ctx.managerSmsAccess?.mode === "delegated") {
    throw new Error("Posting a service to the board is not available on another manager's account.");
  }
  if ((await resolveAuthenticatedBusinessAccess(ctx.userId, ctx.db)).kind !== "normal") {
    throw new Error("Publishing is unavailable for this account.");
  }
  const { data, error } = await ctx.db
    .from("portal_work_order_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .eq("id", workOrderId.trim())
    .eq("manager_user_id", ctx.landlordId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = (data?.row_data ?? null) as DemoManagerWorkOrderRow | null;
  if (!data || !row || String(data.manager_user_id) !== ctx.landlordId || !rowAllowedInAgentWorkspace(ctx, row)) {
    throw new Error("No service with this id belongs to this landlord. Use list_work_orders for valid ids.");
  }
  return { id: String(data.id), row, vendorUserId: (data.vendor_user_id as string | null) ?? null };
}

/** The category the post goes out under: the manager's override, else the row's own, else Tours for a tour job. */
function boardCategory(row: DemoManagerWorkOrderRow, override?: (typeof CATEGORIES)[number]): DemoManagerWorkOrderRow["category"] {
  if (override) return override;
  if (row.category) return row.category;
  return /\btours?\b/i.test(`${row.title ?? ""}`) ? "tours" : undefined;
}

export const postServiceToBoardTool = defineWriteTool({
  name: "post_service_to_board",
  description:
    "Post one of the landlord's open services to the public vendor work board so any vendor in the area can ask for it. Vendors see the trade, the title and the general area only, never the street address or the resident. Pass category tours for a tour-host job. Use list_work_orders to get the id. The landlord confirms first.",
  inputSchema: postSchema,
  preview: async (ctx, input) => {
    const { row, vendorUserId, id } = await loadOwnedService(ctx, input.workOrderId);
    if (!serviceIsOpenToNewRequests({ vendor_user_id: vendorUserId }, row)) throw new Error("Only an open service can be posted to the board.");
    const category = boardCategory(row, input.category);
    return {
      kind: "post_service_to_board",
      title: "Post to the work board",
      summary: `Post "${row.title || id}" to the work board under ${publicServiceTradeLabel(category)}.`,
      confirmLabel: "Post to the board",
      fields: [
        { label: "Service", value: row.title || id },
        { label: "Board category", value: publicServiceTradeLabel(category) },
        { label: "Vendors see", value: `the title and the area (${workOrderGeneralArea(row)}) only` },
        { label: "Not shared", value: "the street address, unit and the resident" },
      ],
      confirmedInput: input,
    };
  },
  handler: async (ctx, input) => {
    const owned = await loadOwnedService(ctx, input.workOrderId);
    const category = boardCategory(owned.row, input.category);
    const audit = await writeAuditLog(ctx, {
      action: "post_service_to_board",
      toolName: "post_service_to_board",
      inputSummary: { workOrderId: owned.id, category: category ?? null },
    });
    if (!audit.recorded && !audit.duplicate) throw new Error("Could not record the action; nothing was posted.");
    const result = await publishServiceToBoard(
      ctx.db,
      { userId: ctx.landlordId, role: "manager", admin: false },
      { workOrderId: owned.id, ...(category ? { category } : {}) },
    );
    if (!result.ok) throw new Error(result.error);
    return {
      reply: `"${owned.row.title || owned.id}" is on the work board under ${publicServiceTradeLabel(category)}.`,
      resultSummary: { workOrderId: owned.id, published: true },
    };
  },
});

export const managerServiceBoardTools = [postServiceToBoardTool];
