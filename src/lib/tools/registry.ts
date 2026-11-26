/**
 * The tool layer contract — the ONE agent write-action framework.
 *
 * Every site capability the agent can use is a typed, permission-scoped
 * ToolDefinition. Anthropic tool schemas are generated from the Zod input
 * schema so there is one source of truth, not two.
 *
 * Two tool kinds:
 *  - READ tools return data to the model directly.
 *  - WRITE tools are two-phase: `preview()` (read-only validation + the
 *    user-facing {@link ActionPreview}) runs from the model loop when the model
 *    proposes the action; `handler()` (the actual state change) runs ONLY from
 *    the gated confirm endpoint after the user explicitly approves, and must
 *    re-resolve every target from authoritative, actor-scoped server data.
 *
 * A write tool is NEVER model-callable unless the calling surface names it in
 * an explicit `allowWrite` allowlist (e.g. the vendor SMS agent's
 * escalate_to_manager). That way a write tool added to a registry later can
 * never become autonomously callable by accident.
 *
 * The registry is generic over the context type so manager, resident, and
 * vendor tools each bind to their own scoped context and can never be
 * registered into the wrong portal's registry.
 */
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { AgentContext } from "./context";
import { invalidateTurnCache } from "./turn-cache";

export type ToolKind = "read" | "write";

/**
 * The user-facing preview of a proposed write action, and the exact payload the
 * confirm card renders (`assistant-shared.tsx`). Fields must show EXACTLY what
 * will happen (recipient, full message body, amount, date) — this is the
 * prompt-injection catch point: the user can only veto what they can see.
 */
export type ActionPreview = {
  /** Stable machine label for the action, normally the tool name. */
  kind: string;
  title: string;
  confirmLabel: string;
  fields: { label: string; value: string }[];
  warnings?: string[];
  /** One-line plain-language restatement rendered above the fields. */
  summary?: string;
  /** Number of targets when the input is a batch (drives copy + analytics). */
  batchCount?: number;
};

/**
 * What a write tool's preview returns: the card, plus an optional pinned input.
 */
export type WritePreview<Input> = ActionPreview & {
  /**
   * Store THIS instead of the model's input, when the preview resolved a value
   * the user is approving — e.g. the vendor's auto-picked next available slot,
   * which could otherwise drift between preview and confirm and book a time the
   * manager never saw. Stripped by {@link previewWriteTool} before the preview
   * is persisted or returned to any client, so it can never leak the stored
   * input. It is a pin, never a substitute for re-verifying ownership in the
   * handler.
   */
  confirmedInput?: Input;
};

/**
 * What a gated write returns after the user confirms. Tools may return extra
 * fields; the confirm gate reads `reply` (and `checkoutUrl` when the action
 * hands off to a payment page).
 */
export type WriteResult = {
  reply: string;
  resultSummary?: Record<string, unknown>;
  checkoutUrl?: string;
};

export type ReadToolDefinition<Input = unknown, Output = unknown, Ctx = AgentContext> = {
  name: string;
  description: string;
  kind: "read";
  inputSchema: z.ZodType<Input>;
  handler: (ctx: Ctx, input: Input) => Promise<Output>;
};

export type WriteToolDefinition<Input = unknown, Output = unknown, Ctx = AgentContext> = {
  name: string;
  /**
   * Shown to the model. A shared "requires user confirmation" suffix is
   * appended automatically in toAnthropicTools — don't repeat it per tool.
   */
  description: string;
  kind: "write";
  /** Deletes / irreversible / money-moving ops get warning styling + copy. */
  destructive?: boolean;
  inputSchema: z.ZodType<Input>;
  /**
   * READ-ONLY: validate against live actor-scoped data and build the preview.
   * Runs from the model loop before any confirmation exists, so it must never
   * mutate. Throw to reject — the message is fed back to the model as a
   * tool_result error so it can self-correct.
   */
  preview: (ctx: Ctx, input: Input) => Promise<WritePreview<Input>>;
  /**
   * The state change. Callable ONLY from the gated confirm endpoint (or from
   * the model loop when the surface allow-lists this tool). Must re-resolve
   * targets from live actor-scoped data and write an audit_log row.
   */
  handler: (ctx: Ctx, input: Input) => Promise<Output>;
  /**
   * Identity-named input fields that are TARGETS rather than scope, exempting
   * them from {@link BANNED_IDENTITY_FIELDS}. Every exempted field MUST be
   * re-verified against actor-scoped data in both preview and handler.
   */
  allowedIdentityInputs?: readonly string[];
};

export type ToolDefinition<Input = unknown, Output = unknown, Ctx = AgentContext> =
  | ReadToolDefinition<Input, Output, Ctx>
  | WriteToolDefinition<Input, Output, Ctx>;

export function defineTool<Input, Output, Ctx = AgentContext>(
  def: Omit<ReadToolDefinition<Input, Output, Ctx>, "kind"> & { kind?: "read" },
): ReadToolDefinition<Input, Output, Ctx> {
  return { ...def, kind: "read" };
}

/** A write tool: preview is required, kind is pinned, handler is the gated execute. */
export function defineWriteTool<Input, Output, Ctx = AgentContext>(
  def: Omit<WriteToolDefinition<Input, Output, Ctx>, "kind"> & { kind?: "write" },
): WriteToolDefinition<Input, Output, Ctx> {
  return { ...def, kind: "write" };
}

// Stored heterogeneously; per-tool generics are recovered at call time via Zod.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolRegistry<Ctx = AgentContext> = Map<string, ToolDefinition<any, any, Ctx>>;

/**
 * Scope identity can never come from the model. No write tool may accept a
 * field that names the acting/owning identity — those always come from the
 * authenticated context. (Target identities like a recipient email are fine;
 * they are re-verified against actor-scoped data in preview/handler. A target
 * that unavoidably reads as an identity opts out via `allowedIdentityInputs`.)
 */
const BANNED_IDENTITY_FIELDS = new Set(
  [
    "landlordId",
    "landlord_id",
    "managerUserId",
    "manager_user_id",
    "managerId",
    "manager_id",
    "userId",
    "user_id",
    "actorUserId",
    "actor_user_id",
    "ownerUserId",
    "owner_user_id",
    "vendorUserId",
    "vendor_user_id",
    "residentUserId",
    "resident_user_id",
  ].map((s) => s.toLowerCase()),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildRegistry<Ctx = AgentContext>(tools: ToolDefinition<any, any, Ctx>[]): ToolRegistry<Ctx> {
  const registry: ToolRegistry<Ctx> = new Map();
  for (const tool of tools) {
    if (registry.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`);
    }
    if (tool.kind === "write") {
      if (typeof tool.preview !== "function") {
        throw new Error(`Write tool ${tool.name} has no preview — it would be unreachable from chat.`);
      }
      const exempt = new Set((tool.allowedIdentityInputs ?? []).map((s) => s.toLowerCase()));
      const schema = zodToJsonSchema(tool.inputSchema, { $refStrategy: "none" }) as {
        properties?: Record<string, unknown>;
      };
      for (const prop of Object.keys(schema.properties ?? {})) {
        const key = prop.toLowerCase();
        if (BANNED_IDENTITY_FIELDS.has(key) && !exempt.has(key)) {
          throw new Error(
            `Write tool ${tool.name} declares identity input field "${prop}" — scope always comes from the authenticated context, never from the model.`,
          );
        }
      }
    }
    registry.set(tool.name, tool);
  }
  return registry;
}

export type AnthropicToolSchema = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const WRITE_DESCRIPTION_SUFFIX =
  " This does not execute immediately: the user is shown a preview of the exact action and must explicitly confirm before anything happens.";

/**
 * Generate Anthropic tool definitions from the registry's Zod schemas.
 * `allowWrite` names specific write tools the model may call autonomously
 * (e.g. the vendor agent's escalate_to_manager) — an explicit allowlist so a
 * future write tool added to a registry never becomes model-callable by
 * accident. Everything else keeps the gated-confirm contract.
 */
export function toAnthropicTools<Ctx>(
  registry: ToolRegistry<Ctx>,
  opts: { readOnly?: boolean; allowWrite?: readonly string[] } = {},
): AnthropicToolSchema[] {
  const allowWrite = opts.allowWrite ?? [];
  const out: AnthropicToolSchema[] = [];
  for (const tool of registry.values()) {
    const inlineWrite = tool.kind === "write" && allowWrite.includes(tool.name);
    if (opts.readOnly && tool.kind !== "read" && !inlineWrite) continue;
    const description =
      tool.kind === "write" && !inlineWrite ? tool.description + WRITE_DESCRIPTION_SUFFIX : tool.description;
    out.push({
      name: tool.name,
      description,
      input_schema: zodToJsonSchema(tool.inputSchema, { $refStrategy: "none" }) as Record<string, unknown>,
    });
  }
  return out;
}

export type RunToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/**
 * Validate input and dispatch a READ tool. Write tools are never callable from
 * the model loop unless the surface allow-lists them; everything else only
 * executes through the gated confirm endpoint, which re-resolves the action
 * from authoritative server data.
 */
export async function runReadTool<Ctx>(
  registry: ToolRegistry<Ctx>,
  ctx: Ctx,
  name: string,
  rawInput: unknown,
  opts: { allowWrite?: readonly string[] } = {},
): Promise<RunToolResult> {
  const tool = registry.get(name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  if (tool.kind !== "read" && !(opts.allowWrite ?? []).includes(tool.name)) {
    return { ok: false, error: `Tool ${name} requires explicit user confirmation and cannot be called directly.` };
  }
  const parsed = tool.inputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, error: `Invalid input for ${name}: ${parsed.error.message}` };
  }
  try {
    const data = await tool.handler(ctx, parsed.data);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Tool execution failed." };
  } finally {
    // An inline (allow-listed) write may have changed rows this context already read.
    if (tool.kind === "write" && ctx && typeof ctx === "object") invalidateTurnCache(ctx);
  }
}

export type PreviewWriteToolResult =
  | { ok: true; input: unknown; preview: ActionPreview; destructive: boolean }
  | { ok: false; error: string };

/**
 * Validate input for a WRITE tool and build its user-facing preview. This is
 * the only write-tool entry point reachable from the model loop; the handler
 * itself only runs later, from the confirm gate, with the stored input.
 */
export async function previewWriteTool<Ctx>(
  registry: ToolRegistry<Ctx>,
  ctx: Ctx,
  name: string,
  rawInput: unknown,
): Promise<PreviewWriteToolResult> {
  const tool = registry.get(name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  if (tool.kind !== "write" || typeof tool.preview !== "function") {
    return { ok: false, error: `Tool ${name} is not a previewable write tool.` };
  }
  const parsed = tool.inputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, error: `Invalid input for ${name}: ${parsed.error.message}` };
  }
  try {
    // `confirmedInput` is stripped here: it decides what gets STORED and must
    // never travel with the preview into the pending-action row or the client.
    const { confirmedInput, ...preview } = await tool.preview(ctx, parsed.data);
    return {
      ok: true,
      input: confirmedInput ?? parsed.data,
      preview,
      destructive: Boolean(tool.destructive),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not preview this action." };
  }
}

export type ExecuteWriteResult =
  | { ok: true; result: WriteResult }
  | { ok: false; error: string };

/**
 * Re-validate STORED input against the tool's CURRENT schema (schema drift
 * across deploys fails safely) and run the state change. Called only by the
 * gated confirm path and by the loop for allow-listed write tools — never with
 * client- or model-supplied arguments.
 */
export async function executeWriteTool<Ctx>(
  registry: ToolRegistry<Ctx>,
  ctx: Ctx,
  name: string,
  storedInput: unknown,
): Promise<ExecuteWriteResult> {
  const tool = registry.get(name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  if (tool.kind !== "write") return { ok: false, error: `Tool ${name} is not an action tool.` };
  const parsed = tool.inputSchema.safeParse(storedInput ?? {});
  if (!parsed.success) {
    return { ok: false, error: "This action is no longer valid. Please ask again." };
  }
  try {
    const result = (await tool.handler(ctx, parsed.data)) as WriteResult | undefined;
    return { ok: true, result: { ...result, reply: result?.reply ?? "Done." } };
  } catch (e) {
    console.error(`[tools] execute ${name} failed:`, e);
    return { ok: false, error: e instanceof Error ? e.message : "The action failed to execute." };
  } finally {
    // A write may have changed rows this context already read: the next read in it starts fresh.
    if (ctx && typeof ctx === "object") invalidateTurnCache(ctx);
  }
}
