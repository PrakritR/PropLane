import type { PropertyCoManagerPermissions } from "@/lib/co-manager-permissions";

export const WORKSPACE_LIMIT = 3;
export const WORKSPACE_PROPERTY_LIMIT = 10;
export const WORKSPACE_COOKIE = "proplane-workspace";
export type PortalWorkspace = {
  id: string;
  name: string;
  ownerUserId: string;
  owned: boolean;
  isDefault: boolean;
  propertyIds: string[];
  propertyPermissions: PropertyCoManagerPermissions;
};
export type WorkspacePayload = {
  workspaces: PortalWorkspace[];
  activeWorkspaceId: string | null;
};
