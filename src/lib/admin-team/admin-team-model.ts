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

/** What the Invite / Change sheet collected. The server re-derives every part of it; this only shapes the request. */
export type AdminTeamChoice = {
  role: AdminTeamRole;
  workspaceIds: string[];
  houseScope: "all" | "selected";
  /** The houses chosen; only meaningful for `selected` (and then exactly one workspace). */
  houseIds: string[];
  customPermissions: Record<string, unknown>;
  workspacePermissions: Record<string, unknown>;
};

/**
 * The `access` object of an Admin team request. "All houses" names no house and no per-house map, so every workspace
 * resolves it to ITS OWN houses on the server (the same validators the Team invite runs); only a selected list, which
 * the sheet allows for exactly one workspace, names houses.
 */
export function adminTeamAccessFields(choice: AdminTeamChoice): Record<string, unknown> {
  if (choice.role === OVERALL_ADMIN_ROLE) return {};
  const base: Record<string, unknown> = {
    teamRole: choice.role,
    houseScope: choice.workspaceIds.length === 1 ? choice.houseScope : "all",
  };
  if (choice.role === "custom") {
    base.coManagerPermissions = choice.customPermissions;
    base.workspacePermissions = choice.workspacePermissions;
  }
  if (choice.workspaceIds.length === 1 && choice.houseScope === "selected") base.assignedPropertyIds = choice.houseIds;
  return base;
}

export function adminTeamInviteRequest(input: { email: string; choice: AdminTeamChoice }): Record<string, unknown> {
  return {
    email: input.email.trim(),
    role: input.choice.role,
    workspaceIds: input.choice.role === OVERALL_ADMIN_ROLE ? [] : input.choice.workspaceIds,
    access: adminTeamAccessFields(input.choice),
  };
}

export function adminTeamChangeRequest(input: { userId: string; choice: AdminTeamChoice }): Record<string, unknown> {
  return {
    userId: input.userId,
    role: input.choice.role,
    workspaceIds: input.choice.role === OVERALL_ADMIN_ROLE ? [] : input.choice.workspaceIds,
    access: adminTeamAccessFields(input.choice),
  };
}

// The Admin team list as the pane reads it (built by `listAdminTeam`).
export type AdminTeamSeat = {
  linkId: string;
  workspaceId: string;
  workspaceName: string;
  role: string;
  status: "accepted" | "pending";
  houseScope: "all" | "selected";
  assignedPropertyIds: string[];
  houseCount: number;
};

export type AdminTeamMemberRow = {
  key: string;
  userId: string | null;
  name: string;
  email: string;
  phoneVerified: boolean;
  role: AdminTeamRole;
  state: "active" | "invited";
  seats: AdminTeamSeat[];
  /** The unspent admin invite link behind an "invited" row. */
  inviteId: string | null;
  isSelf: boolean;
  /** Whether this viewer may change or remove the row (re-checked by the verb itself). */
  canManage: boolean;
};

export type AdminTeamWorkspace = { id: string; name: string; city: string | null; houses: { id: string; label: string }[] };

export type AdminTeamPayload = {
  viewer: { userId: string; overall: boolean };
  workspaces: AdminTeamWorkspace[];
  members: AdminTeamMemberRow[];
};


/** The slice of a Supabase auth user the proof reads. `identities` is what a provider (Google, Apple) verified. */
export type AdminInviteAuthUser = {
  created_at?: string | null;
  email_confirmed_at?: string | null;
  app_metadata?: Record<string, unknown> | null;
  identities?: { provider?: string | null; identity_data?: Record<string, unknown> | null }[] | null;
};

/** `email_verified` arrives as a boolean or the string "true"; absent is not a denial (Apple omits it). Anything else is. */
function identityEmailVerified(value: unknown): boolean {
  return value === undefined || value === null || value === true || value === "true";
}

/** A Google / Apple identity on this account whose OWN email is the invite's bound address, verified by the provider. */
function providerVerifiedBoundEmail(user: AdminInviteAuthUser, boundEmail: string): boolean {
  const bound = boundEmail.trim().toLowerCase();
  if (!bound) return false;
  return (user.identities ?? []).some((identity) => {
    const provider = String(identity?.provider ?? "").toLowerCase();
    if (provider !== "google" && provider !== "apple") return false;
    const data = identity?.identity_data ?? {};
    return String(data.email ?? "").trim().toLowerCase() === bound && identityEmailVerified(data.email_verified);
  });
}

/**
 * Has this account proven it controls the invited inbox? An admin invite is bound to an email, but the generic sign-up
 * confirms an address without any inbox round-trip, so a holder of a forwarded link could otherwise create the account
 * and take the grant. One created AFTER the invite was minted must carry the server's proof
 * (`app_metadata.admin_invite_proof`, written only by the emailed-code route, and only for this link) or hold a Google /
 * Apple identity whose own verified email IS the invite's bound address (the providers list alone proves nothing: it
 * names a provider, not whose address it verified). An account that existed BEFORE the invite signed in as itself, but its
 * address must be confirmed. Anything unreadable fails closed.
 *
 * Residual (accepted, documented in docs/agents/admin-service.md): someone who pre-registered the invitee's address
 * before any invite existed, and confirmed it, still holds that login.
 */
export function adminInviteAccountProven(
  user: AdminInviteAuthUser | null | undefined,
  link: { id: string; created_at: string | null | undefined; email: string },
): boolean {
  if (!user) return false;
  const app = user.app_metadata ?? {};
  if (app.admin_invite_proof === link.id) return true;
  if (providerVerifiedBoundEmail(user, link.email)) return true;
  if (!String(user.email_confirmed_at ?? "").trim()) return false;
  const created = Date.parse(String(user.created_at ?? ""));
  const minted = Date.parse(String(link.created_at ?? ""));
  return Number.isFinite(created) && Number.isFinite(minted) && created <= minted;
}

export const ADMIN_INVITE_CODE_MINUTES = 10;

export const ADMIN_INVITE_NAME_MAX = 60;
export const ADMIN_INVITE_FALLBACK_NAME = "A PropLane admin";

/**
 * The inviter's profile name as it may appear in an email WE send: it is free text the inviter typed, so a link or markup
 * in it would ride a PropLane-signed message. URLs and angle brackets are stripped, whitespace collapsed, 60 characters.
 */
export function sanitizeInviterName(raw: unknown): string {
  const cleaned = String(raw ?? "")
    .replace(/\b(?:https?:\/\/|www\.)\S*/gi, " ")
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|app|dev|xyz|info|biz|us|ly|link|click|top)\b\S*/gi, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ADMIN_INVITE_NAME_MAX)
    .trim();
  return cleaned || ADMIN_INVITE_FALLBACK_NAME;
}
