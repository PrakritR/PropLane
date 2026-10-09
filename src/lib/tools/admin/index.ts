/**
 * The admin (PropLane operator) tool registry. READ-ONLY by construction:
 * every entry is a `defineTool` read tool, there is no write-tool
 * definition anywhere in this folder and no pending-action path for this role. Tools bind to AdminAgentContext,
 * so a manager, resident or vendor tool cannot be registered into it, and none
 * of these can be registered into another role's registry.
 */
import { buildRegistry, type ToolDefinition, type ToolRegistry } from "../registry";
import { accountSummaryTool, findAccountTool } from "./accounts";
import type { AdminAgentContext } from "./context";
import { healthSummaryTool, openFeedbackTool } from "./health";
import { earningsSummaryTool, promoCodesSummaryTool } from "./stripe-reads";
import { subscriberCountsTool, trialsEndingTool } from "./subscribers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminTool = ToolDefinition<any, any, AdminAgentContext>;

const ALL_ADMIN_TOOLS: AdminTool[] = [
  findAccountTool,
  accountSummaryTool,
  subscriberCountsTool,
  trialsEndingTool,
  earningsSummaryTool,
  promoCodesSummaryTool,
  healthSummaryTool,
  openFeedbackTool,
];

export const adminAgentRegistry: ToolRegistry<AdminAgentContext> = buildRegistry(ALL_ADMIN_TOOLS);
