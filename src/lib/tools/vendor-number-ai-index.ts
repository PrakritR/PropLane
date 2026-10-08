/**
 * The vendor-number AI's registry: `get_vendor_info` and `handoff_to_vendor`, nothing else.
 * Its own registry and context type (AGENTS.md: one registry + resolver + route per role,
 * never crossed). `handoff_to_vendor` is the single write and is autonomously callable
 * through the explicit allowlist below; a write added later is not.
 */
import { buildRegistry, type ToolRegistry } from "./registry";
import type { VendorNumberAiContext } from "./vendor-number-ai-context";
import { VENDOR_NUMBER_AI_HANDOFF_TOOL, getVendorInfoTool, handoffToVendorTool } from "./domains/vendor-number-ai";

export const vendorNumberAiRegistry: ToolRegistry<VendorNumberAiContext> = buildRegistry<VendorNumberAiContext>([
  getVendorInfoTool,
  handoffToVendorTool,
]);

export const VENDOR_NUMBER_AI_WRITE_TOOLS = [VENDOR_NUMBER_AI_HANDOFF_TOOL] as const;
