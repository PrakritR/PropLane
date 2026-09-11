import type { PropertyCoManagerPermissions } from "@/lib/co-manager-permissions";

/** Hard ceiling enforced in the database; the plan below narrows it per tier. */
export const WORKSPACE_LIMIT = 3;
/** Property records per workspace, drafts included (database trigger). */
export const WORKSPACE_PROPERTY_LIMIT = 10;
export const WORKSPACE_COOKIE = "proplane-workspace";

export type WorkspacePlanTier = "free" | "pro" | "business";

/**
 * What each plan buys, in the nouns the Workspaces pane shows. Property and
 * team caps are the same numbers the listing quota and the co-manager link
 * cap already enforce (src/lib/manager-access.ts); workspaces per plan is
 * enforced by `/api/workspaces` on create under the database ceiling.
 */
export const WORKSPACE_PLAN_ENTITLEMENTS: Record<
  WorkspacePlanTier,
  { label: string; workspaces: number; properties: number; recordsPerWorkspace: number; team: number; vendors: number | null }
> = {
  free: { label: "Free", workspaces: 1, properties: 1, recordsPerWorkspace: WORKSPACE_PROPERTY_LIMIT, team: 0, vendors: null },
  pro: { label: "Pro", workspaces: 2, properties: 2, recordsPerWorkspace: WORKSPACE_PROPERTY_LIMIT, team: 2, vendors: null },
  business: { label: "Business", workspaces: 3, properties: 20, recordsPerWorkspace: WORKSPACE_PROPERTY_LIMIT, team: 20, vendors: null },
};

export type WorkspaceMember = {
  userId: string;
  name: string;
  email: string;
  /** Houses in THIS workspace the member is assigned to. */
  propertyIds: string[];
  /** Modules granted on at least one of those houses. */
  modules: string[];
};

export type WorkspacePlan = {
  tier: WorkspacePlanTier | null;
  /** True when the plan could not be resolved; caps are then shown as unknown, never as Free. */
  unknown: boolean;
  workspaceLimit: number;
  propertyLimit: number | null;
  recordsPerWorkspace: number;
  teamLimit: number | null;
  /** Usage across the account. */
  usage: { workspaces: number; properties: number; team: number; vendors: number };
};
export type PortalWorkspace = {
  id: string;
  name: string;
  ownerUserId: string;
  owned: boolean;
  isDefault: boolean;
  propertyIds: string[];
  /** Display names from the property record itself, so the pane never depends on a client cache. */
  propertyLabels?: Record<string, string>;
  propertyPermissions: PropertyCoManagerPermissions;
  /** Managers the owner has granted access on houses in this workspace (owned workspaces only). */
  members?: WorkspaceMember[];
};
export type WorkspacePayload = {
  workspaces: PortalWorkspace[];
  activeWorkspaceId: string | null;
  plan?: WorkspacePlan;
};
