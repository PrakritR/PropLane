/**
 * Product team roles are a stamp + a label.
 *
 * Authorization still reads the permission map
 * (`hasCoManagerPermissionLevelForProperty`). A forged `teamRole: "full"`
 * with an empty map grants nothing.
 */
import {
  CO_MANAGER_PERMISSION_OPTIONS,
  OWNER_PERMISSION_OPTIONS,
  hasCoManagerPermissionLevel,
  normalizeCoManagerPermissions,
  onlyOwnerPermissions,
  type CoManagerPermissionGrant,
  type CoManagerPermissionId,
  type CoManagerPermissions,
  type PropertyCoManagerPermissions,
} from "@/lib/co-manager-permissions";

export const TEAM_ROLE_IDS = [
  "property_owner",
  "viewer",
  "leasing",
  "property_manager",
  "bookkeeper",
  "maintenance",
  "admin",
  "full",
  "custom",
] as const;

export type TeamRoleId = (typeof TEAM_ROLE_IDS)[number];
/** Alias used by invite DTOs and routes. */
export type CoManagerTeamRole = TeamRoleId;

export const TEAM_ROLE_LABELS: Record<TeamRoleId, string> = {
  property_owner: "Property owner",
  viewer: "Viewer",
  leasing: "Leasing",
  property_manager: "Property manager",
  bookkeeper: "Bookkeeper",
  maintenance: "Maintenance",
  admin: "Admin",
  /** Legacy stamp: the same module grant as Admin, kept so stored rows still parse. Lists as Admin. */
  full: "Admin",
  custom: "Custom",
};

/** The roles an invite offers. `full` is not offered; it reads as Admin on old rows. */
export const TEAM_ROLE_INVITE_OPTIONS: { value: TeamRoleId; label: string }[] = TEAM_ROLE_IDS
  .filter((id) => id !== "full")
  .map((id) => ({ value: id, label: TEAM_ROLE_LABELS[id] }));

export const TEAM_ROLE_SELECT_OPTIONS: { value: TeamRoleId; label: string }[] = TEAM_ROLE_IDS.map((id) => ({
  value: id,
  label: TEAM_ROLE_LABELS[id],
}));

export const UNKNOWN_TEAM_ROLE_ERROR = "Unknown team role.";

const TEAM_ROLE_ID_SET = new Set<string>(TEAM_ROLE_IDS);

const VIEW = { read: true, notification: true } as const;
const EDIT = { read: true, edit: true, notification: true } as const;

type StampLevel = "view" | "edit" | "manage";

function stampFromSpec(spec: Partial<Record<CoManagerPermissionId, StampLevel>>): CoManagerPermissions {
  const out: CoManagerPermissions = {};
  for (const [id, level] of Object.entries(spec) as [CoManagerPermissionId, StampLevel][]) {
    if (level === "view") out[id] = { ...VIEW };
    else if (level === "edit") out[id] = { ...EDIT };
    else out[id] = true;
  }
  return out;
}

function allModules(level: StampLevel): CoManagerPermissions {
  const out: CoManagerPermissions = {};
  for (const { id } of CO_MANAGER_PERMISSION_OPTIONS) {
    out[id] = level === "view" ? { ...VIEW } : level === "edit" ? { ...EDIT } : true;
  }
  return out;
}

/** Owner keys at View, Messages off: the Property owner default. */
const OWNER_DEFAULT_STAMP: CoManagerPermissions = {
  ownerPerformance: { ...VIEW },
  ownerStatements: { ...VIEW },
  ownerDocuments: { ...VIEW },
};

/** The one role that is not a manager: an investor who reads their own houses' results. */
export function isPropertyOwnerRole(role: unknown): boolean {
  return role === "property_owner";
}

/**
 * What a stored/requested map becomes for `role`. A Property owner holds ONLY
 * owner keys (a forged module grant is dropped); every other role never
 * carries an owner key.
 */
export function permissionsForRole(role: TeamRoleId | null | undefined, perms: CoManagerPermissions): CoManagerPermissions {
  if (role === "property_owner") return onlyOwnerPermissions(perms);
  const out: CoManagerPermissions = { ...perms };
  for (const { id } of OWNER_PERMISSION_OPTIONS) delete out[id];
  return out;
}

const ROLE_STAMPS: Record<Exclude<TeamRoleId, "custom">, CoManagerPermissions> = {
  property_owner: OWNER_DEFAULT_STAMP,
  viewer: allModules("view"),
  leasing: stampFromSpec({
    applications: "edit",
    promotion: "edit",
    inbox: "edit",
    calendar: "edit",
    properties: "view",
    residents: "view",
    leases: "view",
  }),
  property_manager: stampFromSpec({
    properties: "edit",
    applications: "edit",
    residents: "edit",
    leases: "edit",
    services: "edit",
    promotion: "edit",
    inbox: "edit",
    calendar: "edit",
    documents: "edit",
    payments: "view",
    financials: "view",
    teams: "view",
  }),
  bookkeeper: stampFromSpec({
    payments: "edit",
    documents: "edit",
    financials: "edit",
    properties: "view",
    bankAccount: "view",
  }),
  maintenance: stampFromSpec({
    services: "edit",
    inbox: "edit",
    calendar: "edit",
    properties: "view",
  }),
  admin: allModules("manage"),
  full: allModules("manage"),
};

/** Custom is not a stamp — keep the current map. */
export function stampTeamRolePermissions(role: TeamRoleId): CoManagerPermissions | null {
  if (role === "custom") return null;
  return { ...ROLE_STAMPS[role] };
}

/**
 * The flat `co_manager_permissions` column a membership stores, or null when
 * the caller must fall back to its own value (Custom).
 *
 * For every role but Property owner that is the role stamp. An owner's is the
 * per-house keys the manager ACTUALLY set, because
 * `readPropertyPermissionsFromRow` falls back to this column for a house an
 * "all houses" row picks up later: a stamped role default would hand
 * Performance, Statements and Documents back on every new house after the
 * manager turned those keys off. Every write path (invite, mint redeem, edit)
 * goes through here so the three cannot disagree.
 */
export function flatTeamRoleGrant(
  role: TeamRoleId | null | undefined,
  propertyPerms: PropertyCoManagerPermissions,
): CoManagerPermissions | null {
  if (!role || role === "custom") return null;
  if (role === "property_owner") return ownerFlatGrant(propertyPerms);
  return stampTeamRolePermissions(role);
}

/**
 * One owner key per house map, collapsed: on where any house has it on, and
 * EXPLICITLY off (`{ notification: false }`) where a house says so. The off
 * form matters as much as the on form - a key that merely goes missing reads as
 * *unset*, and `stampTeamRoleOnProperties` fills an unset house from the role
 * default, which is how a manager's "No access" came back on its own.
 */
function ownerFlatGrant(propertyPerms: PropertyCoManagerPermissions): CoManagerPermissions {
  const maps = Object.values(propertyPerms ?? {}).map((map) => normalizeCoManagerPermissions(map));
  const out: CoManagerPermissions = {};
  for (const { id } of OWNER_PERMISSION_OPTIONS) {
    if (maps.some((map) => hasCoManagerPermissionLevel(map, id, "read"))) {
      out[id] = { read: true, notification: true };
    } else if (maps.some((map) => map[id] !== undefined)) {
      out[id] = { notification: false };
    }
  }
  return out;
}

/** Apply a named role stamp to every assigned house. Custom leaves the map alone. */
export function stampTeamRoleOnProperties(
  role: TeamRoleId,
  assignedPropertyIds: string[],
  current: PropertyCoManagerPermissions,
): PropertyCoManagerPermissions {
  const stamp = stampTeamRolePermissions(role);
  if (!stamp) return current;
  const next: PropertyCoManagerPermissions = {};
  for (const id of assignedPropertyIds) {
    if (role === "property_owner") {
      // The owner keys the manager set per owner stand; an owner with none set
      // at all starts from the default. "Off" is stored explicitly
      // (`{ notification: false }`), so a turned-off row is never read as unset.
      const chosen = onlyOwnerPermissions(normalizeCoManagerPermissions(current[id]));
      next[id] = Object.keys(chosen).length > 0 ? chosen : { ...stamp };
    } else {
      next[id] = { ...stamp };
    }
  }
  return next;
}

/**
 * Final shape of a per-house map for `role`: an owner keeps owner keys only,
 * every other role loses any owner key. Run on every write path (mint, invite,
 * edit) so a forged or stale key cannot ride along a role change.
 */
export function applyRoleToPropertyPermissions(
  role: TeamRoleId | null | undefined,
  perms: PropertyCoManagerPermissions,
): PropertyCoManagerPermissions {
  const out: PropertyCoManagerPermissions = {};
  for (const [id, map] of Object.entries(perms)) out[id] = permissionsForRole(role, normalizeCoManagerPermissions(map));
  return out;
}

function grantFingerprint(grant: CoManagerPermissionGrant | undefined): string {
  if (grant === true) return "full";
  if (!grant || typeof grant !== "object") return "none";
  const read = grant.read === true || grant.edit === true || grant.delete === true;
  return [
    read ? "r" : "",
    grant.edit ? "e" : "",
    grant.delete ? "d" : "",
    grant.notification === false ? "n0" : read || grant.notification === true ? "n1" : "",
  ].join("");
}

export function permissionsMatchTeamRole(actual: CoManagerPermissions, role: TeamRoleId): boolean {
  const stamp = stampTeamRolePermissions(role);
  if (!stamp) return false;
  // A Property owner is edited per owner, so any owner-key combination is still
  // the role; what it must never hold is a module grant.
  if (role === "property_owner") {
    const a = normalizeCoManagerPermissions(actual);
    return CO_MANAGER_PERMISSION_OPTIONS.every(({ id }) => !a[id]);
  }
  const a = normalizeCoManagerPermissions(actual);
  const s = normalizeCoManagerPermissions(stamp);
  for (const { id } of [...CO_MANAGER_PERMISSION_OPTIONS, ...OWNER_PERMISSION_OPTIONS]) {
    if (grantFingerprint(a[id]) !== grantFingerprint(s[id])) return false;
  }
  return true;
}

export function inferTeamRoleFromPermissions(grant: CoManagerPermissions): TeamRoleId {
  for (const id of TEAM_ROLE_IDS) {
    if (id === "custom") continue;
    // Never inferred: an empty or owner-only map is not evidence of an owner.
    // Property owner exists only as an explicitly stored role.
    if (id === "property_owner") continue;
    if (permissionsMatchTeamRole(grant, id)) return id;
  }
  return "custom";
}

export function inferInviteTeamRole(propertyPerms: PropertyCoManagerPermissions): TeamRoleId {
  const maps = Object.values(propertyPerms);
  if (maps.length === 0) return "custom";
  const first = inferTeamRoleFromPermissions(maps[0] ?? {});
  for (const map of maps.slice(1)) {
    if (inferTeamRoleFromPermissions(map) !== first) return "custom";
  }
  return first;
}

export function parseTeamRole(raw: unknown): { ok: true; role: TeamRoleId | null } | { ok: false; error: string } {
  if (raw == null || raw === "") return { ok: true, role: null };
  if (typeof raw !== "string") return { ok: false, error: UNKNOWN_TEAM_ROLE_ERROR };
  const id = raw.trim();
  if (!id) return { ok: true, role: null };
  if (TEAM_ROLE_ID_SET.has(id)) return { ok: true, role: id as TeamRoleId };
  return { ok: false, error: UNKNOWN_TEAM_ROLE_ERROR };
}

/** Null / unknown stored values read as Co-manager on existing rows. */
export function teamRoleListLabel(role: TeamRoleId | string | null | undefined): string {
  const parsed = parseTeamRole(role);
  if (!parsed.ok || parsed.role == null) return "Co-manager";
  return TEAM_ROLE_LABELS[parsed.role];
}

/**
 * Drop a Property owner's rows from a result of `account_link_invites`.
 *
 * Every reader that treats an accepted membership row as "this person is a
 * teammate of the inviter" (recipients, SMS and email access, tier inheritance,
 * linked houses, payout access…) wraps its read in this, and selects
 * `team_role`. An owner is an investor reading their own houses' results, never
 * a teammate; the owner readers (`src/lib/property-owner/*`) are the only code
 * that look at those rows. The filter is applied to the rows rather than as a
 * query predicate so a legacy row whose `team_role` is NULL still passes.
 * `tests/unit/property-owner-link-readers.test.ts` fails a reader that forgets it.
 */
export function withoutOwnerLinks<R extends { data: unknown }>(result: R): R {
  const rows = result.data;
  if (!Array.isArray(rows)) return result;
  return {
    ...result,
    data: rows.filter((row) => (row as { team_role?: unknown } | null)?.team_role !== "property_owner"),
  };
}
