import type { PortalWorkspace } from "@/lib/workspaces/types";

/**
 * What "Add property" should do given the workspace the manager is standing in.
 *
 * A new property can be saved into a workspace the manager owns, or one they
 * were granted `workspace_permissions.addProperties` on (create-as-owner). The
 * records API still 403s a workspace with neither, and it used to do that only
 * after the form was filled in (PLAN-0916-1119). This resolves writability
 * BEFORE the editor opens.
 *
 *  - `open`     — already in a writable workspace (owned or granted), or none
 *                 is selected (a brand-new account with no cookie).
 *  - `wait`     — workspaces are still loading; do not open on a stale cookie.
 *  - `switch`   — exactly one writable workspace; switch to it, then open.
 *  - `ask-pick` — several writable workspaces; the manager chooses which.
 *  - `no-owned` — nowhere writable, so a property has nowhere to go.
 *
 * Pure and context-shaped (not the React context itself) so it is unit-tested
 * without rendering the Properties page.
 */
export type AddPropertyWorkspaceAction =
  | { kind: "open" }
  | { kind: "wait" }
  | { kind: "switch"; workspaceId: string }
  | { kind: "ask-pick" }
  | { kind: "no-owned" };

function canCreateHere(workspace: Pick<PortalWorkspace, "owned" | "canAddProperties"> | null): boolean {
  if (!workspace) return false;
  return workspace.owned || workspace.canAddProperties === true;
}

export function resolveAddPropertyWorkspaceAction(
  ctx: {
    loading: boolean;
    active: Pick<PortalWorkspace, "owned" | "canAddProperties"> | null;
    workspaces: Pick<PortalWorkspace, "id" | "owned" | "canAddProperties">[];
  } | null,
): AddPropertyWorkspaceAction {
  // No workspace context (hosts/tests): don't block — the server stays the authority.
  if (!ctx) return { kind: "open" };
  // Loading must not open: a stale cookie can land in a co-managed workspace
  // and the wizard then 403s after the form is filled.
  if (ctx.loading) return { kind: "wait" };
  if (!ctx.active) return { kind: "open" };
  if (canCreateHere(ctx.active)) return { kind: "open" };
  const writable = ctx.workspaces.filter((w) => canCreateHere(w));
  if (writable.length === 0) return { kind: "no-owned" };
  if (writable.length === 1) return { kind: "switch", workspaceId: writable[0]!.id };
  return { kind: "ask-pick" };
}
