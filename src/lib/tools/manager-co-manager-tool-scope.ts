import type { AgentContext } from "./context";
import type { ToolDefinition } from "./registry";
import { assertManagerCommunicationAllowedForWorkspace } from "@/lib/manager-communication-access.server";

/**
 * Tools whose whole purpose is to message someone on the manager's behalf (inbox, text, email,
 * reminders). A manager on a LIVE signup trial has no Communication until the account pays, so
 * both phases refuse for them: the preview (the model is told why and can say so) and the handler
 * (the confirm gate can never run a stale approval). The plan checked is the workspace OWNER's.
 * Reading the inbox, listing threads and cancelling a scheduled message stay open.
 */
export const COMMUNICATION_SENDING_TOOLS = new Set([
  "send_message",
  "reply_to_thread",
  "schedule_message",
  "reply_to_sms_conversation",
  "send_rent_reminder",
  "send_work_order_reminder",
]);

async function assertToolMayCommunicate(ctx: AgentContext): Promise<void> {
  const access = await assertManagerCommunicationAllowedForWorkspace(
    ctx.db,
    ctx.landlordId,
    ctx.workspace?.id?.trim() || null,
  );
  if (!access.allowed) throw new Error(access.message);
}

/** These tools enforce property/module grants or the shared Communication gate.
 * Everything else retains its own-account semantics until its target loaders
 * enforce delegation in BOTH preview and execution. New tools fail closed.
 */
export const CO_MANAGER_SCOPED_TOOLS = new Set([
  "get_overdue_charges", "list_charges", "list_leases", "list_work_orders",
  "list_vendors", "list_residents", "list_applications", "get_application_details",
  "list_properties", "get_property_details", "list_service_requests",
  "list_sms_conversations", "reply_to_sms_conversation",
  "list_inbox_threads", "get_thread_messages", "send_message", "reply_to_thread",
  // Public-site URLs for a live listing; the share check runs against the
  // workspace owner's live records and returns nothing private.
  "get_property_links",
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
  const sendsMessages = COMMUNICATION_SENDING_TOOLS.has(tool.name);
  const scoped = async (ctx: AgentContext): Promise<AgentContext> => {
    const next = context(ctx);
    if (sendsMessages) await assertToolMayCommunicate(next);
    return next;
  };
  return {
    ...tool,
    handler: async (ctx, input) => tool.handler(await scoped(ctx), input),
    ...(tool.kind === "write" ? { preview: async (ctx: AgentContext, input: Input) => tool.preview(await scoped(ctx), input) } : {}),
  };
}
