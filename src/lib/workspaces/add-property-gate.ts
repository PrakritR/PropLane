import type { PortalWorkspace } from "@/lib/workspaces/types";

/**
 * What "Add property" should do given the workspace the manager is standing in.
 *
 * A new property can only be saved into a workspace the manager OWNS — the
 * records API refuses a co-managed one (403 "Select an owned workspace before
 * adding a property."), and it did so only after the whole form was filled in,
 * which is the cause the editor kept toasting in PLAN-0916-1119. This resolves
 * ownership BEFORE the editor opens.
 *
 *  - `open`     — already in an owned workspace (or none is selected, e.g. a
 *                 brand-new account with no cookie, where the API check never
 *                 fires). The editor may open now.
 *  - `switch`   — exactly one owned workspace; switch to it, then open.
 *  - `ask-pick` — several owned workspaces; the manager chooses which.
 *  - `no-owned` — the manager owns no workspace, so a property has nowhere to go.
 *
 * Pure and context-shaped (not the React context itself) so it is unit-tested
 * without rendering the Properties page.
 */
export type AddPropertyWorkspaceAction =
  | { kind: "open" }
  | { kind: "switch"; workspaceId: string }
  | { kind: "ask-pick" }
  | { kind: "no-owned" };

export function resolveAddPropertyWorkspaceAction(
  ctx: {
    loading: boolean;
    active: Pick<PortalWorkspace, "owned"> | null;
    workspaces: Pick<PortalWorkspace, "id" | "owned">[];
  } | null,
): AddPropertyWorkspaceAction {
  // No workspace context (some hosts, tests) or still loading: don't block — the
  // server stays the authority and refuses a bad workspace anyway.
  if (!ctx || ctx.loading) return { kind: "open" };
  if (!ctx.active || ctx.active.owned) return { kind: "open" };
  const owned = ctx.workspaces.filter((w) => w.owned);
  if (owned.length === 0) return { kind: "no-owned" };
  if (owned.length === 1) return { kind: "switch", workspaceId: owned[0]!.id };
  return { kind: "ask-pick" };
}
