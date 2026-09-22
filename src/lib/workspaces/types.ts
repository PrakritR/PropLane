import type { PropertyCoManagerPermissions } from "@/lib/co-manager-permissions";
import type { TeamRoleId } from "@/lib/co-manager-team-roles";
import type { HouseScope, WorkspaceRole } from "@/lib/workspaces/membership";

/** Hard ceiling enforced in the database; the plan below narrows it per tier. */
export const WORKSPACE_LIMIT = 10;
/** Property records per workspace, drafts included (database trigger). */
export const WORKSPACE_PROPERTY_LIMIT = 10;
/**
 * The machine tag `POST /api/property-records` puts on the workspace
 * record-cap 422 (the database trigger's `23514`, matched by message text
 * since Postgres gives this route no narrower signal). A client keys on this
 * rather than the message so the save-failed dialog can tell "workspace is
 * full" apart from every other refusal that route can return — never a
 * plan-tier limit, which is `MANAGER_PROPERTY_LIMIT_ERROR_CODE`
 * (`src/lib/manager-access.ts`) and a completely different cap.
 */
export const WORKSPACE_PROPERTY_LIMIT_ERROR_CODE = "property_record_limit";
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
  // Round 3 plan model: Pro includes ONE workspace; a second and third are
  // the "extra workspace" add-on. Business includes two (PLAN-0920 add-ons
  // decision); an existing Business account already holding a third
  // workspace keeps it — `loadWorkspacePlan` grandfathers `workspaceLimit` up
  // to the account's current workspace count, never below it.
  pro: { label: "Pro", workspaces: 1, properties: 2, recordsPerWorkspace: WORKSPACE_PROPERTY_LIMIT, team: 2, vendors: null },
  business: { label: "Business", workspaces: 2, properties: 20, recordsPerWorkspace: WORKSPACE_PROPERTY_LIMIT, team: 20, vendors: null },
};

export type WorkspaceMember = {
  /** The membership row (an account link pinned to this workspace). */
  linkId: string;
  userId: string;
  name: string;
  email: string;
  role: TeamRoleId;
  houseScope: HouseScope;
  /** Houses in THIS workspace the member reaches right now. */
  propertyIds: string[];
  /** Modules granted on at least one of those houses. */
  modules: string[];
  status: "accepted" | "pending";
  joinedAt: string | null;
  /** Held the on-by-default Add properties / Team flags before rights followed the role. */
  legacyRights: boolean;
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
  /** Every property scoped to this workspace, drafts and unlisted included — drives scoping, never a display count. */
  propertyIds: string[];
  /**
   * Properties in this workspace with status "live" — what Properties → Listed
   * counts (PRP-481). Optional so existing fixtures/tests built before this
   * field keep compiling; every real payload from `loadWorkspaces` sets it.
   */
  livePropertyCount?: number;
  /** Display names from the property record itself, so the pane never depends on a client cache. */
  propertyLabels?: Record<string, string>;
  propertyPermissions: PropertyCoManagerPermissions;
  /** This workspace's members. Present for the owner and for an admin of the workspace. */
  members?: WorkspaceMember[];
  /** The viewer's standing here: owner, or the role on their membership row. */
  viewerRole?: WorkspaceRole | null;
  viewerHouseScope?: HouseScope;
  /** Viewer may create listings here (owner, admin, property manager). */
  canAddProperties?: boolean;
  /** Viewer may invite, edit and remove members here (owner or admin). */
  canManageMembers?: boolean;
};
export type WorkspacePayload = {
  workspaces: PortalWorkspace[];
  activeWorkspaceId: string | null;
  plan?: WorkspacePlan;
};
