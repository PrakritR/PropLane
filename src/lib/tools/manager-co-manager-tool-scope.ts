import type { AgentContext } from "./context";
import type { ToolDefinition } from "./registry";

/** These tools enforce property/module grants or the shared Communication gate.
 * Everything else retains its own-account semantics until its target loaders
 * enforce delegation in BOTH preview and execution. New tools fail closed.
 */
export const CO_MANAGER_SCOPED_TOOLS = new Set([
  "get_overdue_charges", "list_charges", "list_leases", "list_work_orders",
  "list_vendors", "list_residents", "list_applications", "get_application_details",
  "list_properties", "get_property_details", "list_service_requests",
  "list_inbox_threads", "get_thread_messages", "send_message", "reply_to_thread",
]);

export function scopeManagerTool<Input, Output>(
  tool: ToolDefinition<Input, Output, AgentContext>,
): ToolDefinition<Input, Output, AgentContext> {
  const context = (ctx: AgentContext): AgentContext => {
    const access = ctx.managerSmsAccess;
    if (!access || access.mode === "owner" || CO_MANAGER_SCOPED_TOOLS.has(tool.name)) return ctx;
    if (access.mode === "delegated") {
      throw new Error("This action is not available on another manager's number. Use PropLane with your assigned permissions.");
    }
    // A combined user still has all their own capabilities. Do not accidentally
    // turn a read-only assignment into permission to edit a linked owner's row.
    return { ...ctx, landlordId: ctx.userId, managerSmsAccess: undefined };
  };
  return {
    ...tool,
    handler: async (ctx, input) => tool.handler(context(ctx), input),
    ...(tool.kind === "write" ? { preview: async (ctx: AgentContext, input: Input) => tool.preview(context(ctx), input) } : {}),
  };
}
