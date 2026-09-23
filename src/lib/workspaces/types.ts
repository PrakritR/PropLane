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
/**
 * The one copy of the words `POST /api/property-records` matches inside the
 * `enforce_property_workspace` trigger's raise text to tell the record cap
 * apart from every other `23514` the database can raise (Postgres gives that
 * route no narrower signal than the message). Reword the migration's raise and
 * `tests/unit/workspace-property-limit-db-message.test.ts` fails, rather than
 * the dialog silently degrading to a dead "Try again".
 */
export const WORKSPACE_PROPERTY_LIMIT_DB_MESSAGE = "property records";

/** Is this `23514` the workspace record cap? See {@link WORKSPACE_PROPERTY_LIMIT_DB_MESSAGE}. */
export function isWorkspacePropertyLimitDbMessage(message: string | null | undefined): boolean {
  return (message ?? "").includes(WORKSPACE_PROPERTY_LIMIT_DB_MESSAGE);
}
export const WORKSPACE_COOKIE = "proplane-workspace";

export type WorkspacePlanTier = "free" | "pro" | "business";

/**
 * What each plan buys, in the nouns the Workspaces pane shows. Plans limit
 * workspaces (with paid extras) and residents — not properties or team seats.
 * `recordsPerWorkspace` is informational only; the DB record trigger is lifted.
 */
export const WORKSPACE_PLAN_ENTITLEMENTS: Record<
  WorkspacePlanTier,
  { label: string; workspaces: number; properties: number | null; recordsPerWorkspace: number | null; team: number | null; residents: number; vendors: number | null }
> = {
  free: { label: "Free", workspaces: 1, properties: null, recordsPerWorkspace: null, team: null, residents: 20, vendors: null },
  // Pro includes ONE workspace; extras are the "extra workspace" add-on.
  // Business includes two; grandfather via loadWorkspacePlan.
  pro: { label: "Pro", workspaces: 1, properties: null, recordsPerWorkspace: null, team: null, residents: 100, vendors: null },
  business: { label: "Business", workspaces: 2, properties: null, recordsPerWorkspace: null, team: null, residents: 500, vendors: null },
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
  /** Always null — properties are not plan-capped (doors may still be for Free). */
  propertyLimit: number | null;
  recordsPerWorkspace: number | null;
  /** Always null — team seats are not plan-capped. */
  teamLimit: number | null;
  residentLimit: number | null;
  /** Usage across the account. */
  usage: { workspaces: number; properties: number; team: number; vendors: number; residents: number };
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
