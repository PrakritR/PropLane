/**
 * Product team roles are a stamp + a label.
 *
 * Authorization still reads the permission map
 * (`hasCoManagerPermissionLevelForProperty`). A forged `teamRole: "full"`
 * with an empty map grants nothing.
 */
import {
  CO_MANAGER_PERMISSION_OPTIONS,
  normalizeCoManagerPermissions,
  type CoManagerPermissionGrant,
  type CoManagerPermissionId,
  type CoManagerPermissions,
  type PropertyCoManagerPermissions,
} from "@/lib/co-manager-permissions";

export const TEAM_ROLE_IDS = [
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

const ROLE_STAMPS: Record<Exclude<TeamRoleId, "custom">, CoManagerPermissions> = {
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
    next[id] = { ...stamp };
  }
  return next;
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
  const a = normalizeCoManagerPermissions(actual);
  const s = normalizeCoManagerPermissions(stamp);
  for (const { id } of CO_MANAGER_PERMISSION_OPTIONS) {
    if (grantFingerprint(a[id]) !== grantFingerprint(s[id])) return false;
  }
  return true;
}

export function inferTeamRoleFromPermissions(grant: CoManagerPermissions): TeamRoleId {
  for (const id of TEAM_ROLE_IDS) {
    if (id === "custom") continue;
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
