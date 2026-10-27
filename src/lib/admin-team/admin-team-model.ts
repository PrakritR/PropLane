/**
 * Admin team (plan admin-team-1027): the pure rules, shared by the routes, the sheets and the tests.
 *
 *   * **Overall admin** is the `admin` row in `profile_roles` (`src/lib/auth/admin-role.ts`): every PropLane-wide section.
 *   * Every other role is a PropLane-issued service seat (`account_link_invites` with `is_service_seat`) on one or more
 *     PropLane Service workspaces: the team roles the manager Team invite offers. "Workspace admin" is the Admin team role.
 *
 * Who may grant what (captain, Oct 27, decision 1): only an Overall admin can invite or promote to Overall admin; a
 * workspace admin invites to the workspaces they themselves run, never above their own role.
 */
import { TEAM_ROLE_INVITE_OPTIONS, parseTeamRole, type TeamRoleId } from "@/lib/co-manager-team-roles";

export const OVERALL_ADMIN_ROLE = "overall_admin" as const;
export type AdminTeamRole = typeof OVERALL_ADMIN_ROLE | TeamRoleId;

export const OVERALL_ADMIN_LABEL = "Overall admin";

/** The Admin team role the invite sheet's dropdown shows, Overall admin first. The team role `admin` reads "Workspace admin". */
export const ADMIN_TEAM_ROLE_OPTIONS: { value: AdminTeamRole; label: string }[] = [
  { value: OVERALL_ADMIN_ROLE, label: OVERALL_ADMIN_LABEL },
  ...TEAM_ROLE_INVITE_OPTIONS.map((option) => ({
    value: option.value as AdminTeamRole,
    label: option.value === "admin" ? "Workspace admin" : option.label,
  })),
];

export function adminTeamRoleLabel(role: string | null | undefined): string {
  if (role === OVERALL_ADMIN_ROLE) return OVERALL_ADMIN_LABEL;
  if (role === "admin" || role === "full") return "Workspace admin";
  const found = TEAM_ROLE_INVITE_OPTIONS.find((option) => option.value === role);
  return found?.label ?? "Teammate";
}

export const ADMIN_INVITE_EXPIRY_DAYS = 7;

export function parseAdminTeamRole(raw: unknown): AdminTeamRole | null {
  if (raw === OVERALL_ADMIN_ROLE) return OVERALL_ADMIN_ROLE;
  const parsed = parseTeamRole(raw);
  if (!parsed.ok || !parsed.role) return null;
  // An owner of record is invited from Admin › Service, never as an admin-team role.
  if (parsed.role === "property_owner") return null;
  return parsed.role;
}

/** What the signed-in viewer is, as the server re-derived it. */
export type AdminTeamActor = {
  /** Holds the Overall admin role. */
  overall: boolean;
  /** Service workspaces whose team the viewer may manage (owner / Admin seat there). Empty for nobody. */
  manageableWorkspaceIds: ReadonlySet<string>;
};

export type Verdict = { ok: true } | { ok: false; status: number; error: string };

export const ONLY_OVERALL_GRANTS_OVERALL = "Only an Overall admin can invite another Overall admin.";
export const NO_WORKSPACE_CHOSEN = "Choose at least one workspace.";
export const WORKSPACE_NOT_YOURS = "You can invite only to the workspaces you manage.";
export const NOT_ON_ADMIN_TEAM = "You do not manage any workspace team.";

/**
 * May `actor` make this grant? Pure: the caller still re-validates the houses and the role against each workspace
 * (`resolveServiceSeatGrant`), which is what stops a workspace admin granting above their own role.
 */
export function adminTeamGrantVerdict(actor: AdminTeamActor, input: { role: AdminTeamRole; workspaceIds: readonly string[] }): Verdict {
  if (input.role === OVERALL_ADMIN_ROLE) {
    return actor.overall ? { ok: true } : { ok: false, status: 403, error: ONLY_OVERALL_GRANTS_OVERALL };
  }
  if (!actor.overall && actor.manageableWorkspaceIds.size === 0) return { ok: false, status: 403, error: NOT_ON_ADMIN_TEAM };
  if (input.workspaceIds.length === 0) return { ok: false, status: 400, error: NO_WORKSPACE_CHOSEN };
  if (!actor.overall && input.workspaceIds.some((id) => !actor.manageableWorkspaceIds.has(id))) {
    return { ok: false, status: 403, error: WORKSPACE_NOT_YOURS };
  }
  return { ok: true };
}

export const LAST_OVERALL_ADMIN_ERROR = "This is the last Overall admin. Make someone else an Overall admin first.";

/** The last Overall admin can be neither removed nor demoted. `overallAdminIds` is the set as read right now. */
export function lastOverallAdminVerdict(overallAdminIds: readonly string[], targetUserId: string): Verdict {
  const others = overallAdminIds.filter((id) => id !== targetUserId);
  return others.length === 0 ? { ok: false, status: 409, error: LAST_OVERALL_ADMIN_ERROR } : { ok: true };
}

/** The email this invite is bound to, normalized the way the link row stores it. */
export function normalizeAdminInviteEmail(raw: unknown): string | null {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

/** The grant a stored `admin_grant` JSON describes; anything malformed reads as no grant (the redeem then refuses). */
export type StoredAdminGrant = {
  role: AdminTeamRole;
  workspaceIds: string[];
  /** The access fields exactly as the sheet sent them (InviteAccessInput); re-validated server-side on redeem. */
  access: Record<string, unknown>;
};

export function parseStoredAdminGrant(raw: unknown): StoredAdminGrant | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const role = parseAdminTeamRole(value.role);
  if (!role) return null;
  const workspaceIds = Array.isArray(value.workspaceIds)
    ? [...new Set(value.workspaceIds.map((id) => String(id ?? "").trim()).filter(Boolean))]
    : [];
  const access = value.access && typeof value.access === "object" && !Array.isArray(value.access) ? (value.access as Record<string, unknown>) : {};
  if (role !== OVERALL_ADMIN_ROLE && workspaceIds.length === 0) return null;
  return { role, workspaceIds: role === OVERALL_ADMIN_ROLE ? [] : workspaceIds, access };
}
