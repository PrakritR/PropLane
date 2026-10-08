/**
 * The resident personal agent's registry: four tools, nothing else. Its own registry and context
 * type (AGENTS.md: one registry + resolver + route per role, never crossed). Both writes are gated
 * by a texted YES through the shared confirm gate under the `resident_agent` portal; nothing is
 * allow-listed for inline execution, so a write added later can never become autonomous.
 */
import { buildRegistry, type ToolRegistry } from "./registry";
import type { ResidentPersonalAgentContext } from "./resident-personal-agent-context";
import {
  getTourTimesTool,
  requestTourTool,
  searchListingsTool,
  sendInquiryTool,
} from "./domains/resident-personal-agent";

export const residentPersonalAgentRegistry: ToolRegistry<ResidentPersonalAgentContext> =
  buildRegistry<ResidentPersonalAgentContext>([searchListingsTool, getTourTimesTool, requestTourTool, sendInquiryTool]);

/** No write is callable without the resident's texted confirmation. */
export const RESIDENT_PERSONAL_AGENT_INLINE_WRITE_TOOLS: readonly string[] = [];
