/**
 * Manager portal assistant is scoped to the active workspace. Tools must not
 * return houses (or facts about them) that live in another workspace.
 */
import type { AgentContext } from "@/lib/tools/context";
import { workspacePropertyIdFromRow } from "@/lib/workspaces/selection";

export const SWITCH_WORKSPACE_ASSISTANT_REPLY =
  "Please switch to the other workspace for these questions.";

export type AgentWorkspaceScope = {
  id: string;
  name: string;
  isDefault: boolean;
  /** True when the account has more than one workspace. */
  narrowing: boolean;
  propertyIds: readonly string[];
};

export function propertyInAgentWorkspace(
  workspace: AgentWorkspaceScope | undefined,
  propertyId: string | null | undefined,
): boolean {
  if (!workspace) return true;
  const id = propertyId?.trim();
  if (!id) return workspace.isDefault || !workspace.narrowing;
  return workspace.propertyIds.some((known) => known === id);
}

export function otherWorkspaceToolResult(): { error: string } {
  return { error: SWITCH_WORKSPACE_ASSISTANT_REPLY };
}

export function withManagerWorkspacePrompt(system: string, workspace: AgentWorkspaceScope | undefined): string {
  if (!workspace) return system;
  const houseCount = workspace.propertyIds.length;
  const scopeLine = workspace.narrowing
    ? `You are in the "${workspace.name}" workspace (${houseCount} ${houseCount === 1 ? "house" : "houses"}). Tools only return records for this workspace.`
    : `You are helping with this manager's portfolio in "${workspace.name}".`;
  const switchRule = workspace.narrowing
    ? `If they ask about a house, resident, lease, or conversation that is not in this workspace, reply exactly: ${SWITCH_WORKSPACE_ASSISTANT_REPLY} Do not mention names, rents, occupancy, or other facts from the other workspace.`
    : "";
  return [system.trim(), scopeLine, switchRule].filter(Boolean).join("\n\n");
}

/** Drop rows whose house is in another workspace. Untagged rows stay in the default workspace only. */
export function rowAllowedInAgentWorkspace(
  ctx: Pick<AgentContext, "workspace">,
  rowData: unknown,
  recordId?: string | null,
): boolean {
  const workspace = ctx.workspace;
  if (!workspace) return true;
  const fromRow = workspacePropertyIdFromRow(
    (rowData && typeof rowData === "object" ? rowData : {}) as {
      assignedPropertyId?: string | null;
      propertyId?: string | null;
      application?: { propertyId?: string | null } | null;
    },
  );
  const propertyId = fromRow || recordId?.trim() || null;
  return propertyInAgentWorkspace(workspace, propertyId);
}
