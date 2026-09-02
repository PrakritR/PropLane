/**
 * The resident portal's tool registry. Tools bind to ResidentAgentContext and
 * scope every query by the resident's own identity. The registry is filtered
 * per-request by phase/tier so the assistant's capabilities always equal the
 * resident portal's.
 */
import { buildRegistry, type ToolDefinition, type ToolRegistry } from "./registry";
import type { ResidentAgentContext } from "./resident-context";
import { residentSectionAllowedForManagerTier } from "@/lib/manager-access";
import { getMyBalanceTool, listMyChargesTool, getMyPaymentMethodsTool } from "./domains/resident/balance";
import { listMySharedDocumentsTool } from "./domains/resident/documents";
import { reportMaintenanceIssueTool } from "./domains/resident/maintenance";
import {
  getMyLeaseTool,
  getMyApplicationStatusTool,
  getMoveInInfoTool,
  requestLeaseExtensionTool,
} from "./domains/resident/lease";
import {
  listMyInboxThreadsTool,
  getMyScheduledMessagesTool,
  sendMessageToManagerTool,
  scheduleMessageTool,
  cancelScheduledMessageTool,
} from "./domains/resident/messaging";
import { reportManualPaymentTool, startRentPaymentTool } from "./domains/resident/payments";
import { residentListOpenTourSlotsTool, residentRequestTourTool } from "./domains/tours";
import {
  listMyServiceRequestsTool,
  listMyWorkOrdersTool,
  createServiceRequestTool,
  addServiceRequestNoteTool,
} from "./domains/resident/services";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ResidentTool = ToolDefinition<any, any, ResidentAgentContext>;

const ALL_RESIDENT_TOOLS: ResidentTool[] = [
  // Balance / charges / payment methods
  getMyBalanceTool,
  listMyChargesTool,
  getMyPaymentMethodsTool,
  // Lease / application / move-in
  getMyLeaseTool,
  getMyApplicationStatusTool,
  getMoveInInfoTool,
  requestLeaseExtensionTool,
  // Services / work orders
  listMyServiceRequestsTool,
  listMyWorkOrdersTool,
  createServiceRequestTool,
  addServiceRequestNoteTool,
  reportMaintenanceIssueTool,
  // Documents shared with the resident
  listMySharedDocumentsTool,
  // Inbox / messaging
  listMyInboxThreadsTool,
  getMyScheduledMessagesTool,
  sendMessageToManagerTool,
  scheduleMessageTool,
  cancelScheduledMessageTool,
  // Payments
  reportManualPaymentTool,
  startRentPaymentTool,
  // Tours. Available in the application phase too — touring is exactly what a
  // resident does before they are approved.
  residentListOpenTourSlotsTool,
  residentRequestTourTool,
];

/**
 * Which portal section a tool belongs to, for tier gating (a free-tier manager
 * hides services + documents; communication stays available).
 * Tools without an entry are available on every tier.
 */
const TOOL_SECTION: Record<string, string> = {
  [listMyServiceRequestsTool.name]: "services",
  [listMyWorkOrdersTool.name]: "services",
  [createServiceRequestTool.name]: "services",
  [addServiceRequestNoteTool.name]: "services",
  [reportMaintenanceIssueTool.name]: "services",
  [listMySharedDocumentsTool.name]: "documents",
  [listMyInboxThreadsTool.name]: "communication",
  [getMyScheduledMessagesTool.name]: "communication",
  [sendMessageToManagerTool.name]: "communication",
  [scheduleMessageTool.name]: "communication",
  [cancelScheduledMessageTool.name]: "communication",
};

/** Tools available while the resident is still in the application phase. */
const APPLICATION_PHASE_TOOLS = new Set([
  "get_my_application_status",
  "list_open_tour_slots",
  "request_tour",
  "list_my_inbox_threads",
  "get_my_scheduled_messages",
  "send_message_to_manager",
  "schedule_message",
  "cancel_scheduled_message",
]);

/**
 * Full registry (every resident tool), unfiltered by phase/tier. The chat route
 * builds its own per-request registry with `buildResidentRegistry`, so this is
 * the catalog-level view used by tests and any caller that needs every tool.
 */
export const residentAgentRegistry: ToolRegistry<ResidentAgentContext> = buildRegistry(ALL_RESIDENT_TOOLS);

/**
 * The per-request registry: application-phase residents get application status
 * + messaging; a free-tier manager hides services/documents tools.
 */
export function buildResidentRegistry(ctx: ResidentAgentContext): ToolRegistry<ResidentAgentContext> {
  const tools = ALL_RESIDENT_TOOLS.filter((tool) => {
    if (ctx.phase === "application" && !APPLICATION_PHASE_TOOLS.has(tool.name)) return false;
    const section = TOOL_SECTION[tool.name];
    if (section && !residentSectionAllowedForManagerTier(section, ctx.managerTier)) return false;
    return true;
  });
  return buildRegistry(tools);
}
