import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  listAdminPortalManagerUserIds,
  loadProfilesByIdChunks,
} from "@/lib/auth/admin-portal-manager-ids.server";
import { isPortalSandboxEmail } from "@/lib/portal-sandbox-accounts";

export type AdminAccountKind = "manager" | "resident" | "vendor";

export type AdminAccountProfile = {
  id: string;
  email: string;
  fullName: string;
  phone: string;
  /** The PropLane ID (`profiles.manager_id`). */
  propLaneId: string;
  /** `application_approved !== false` — a disabled account is the only way this is false. */
  active: boolean;
  joinedAt: string | null;
  stripeConnectAccountId: string;
};

type ProfileSelectRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  phone: string | null;
  manager_id: string | null;
  application_approved: boolean | null;
  created_at: string | null;
  stripe_connect_account_id: string | null;
};

const PROFILE_SELECT =
  "id, email, full_name, phone, manager_id, application_approved, created_at, stripe_connect_account_id";
const ROW_LIMIT = 5000;

async function roleHolderIds(db: SupabaseClient, role: AdminAccountKind): Promise<Set<string>> {
  const ids = new Set<string>();
  const { data: roleRows } = await db.from("profile_roles").select("user_id").eq("role", role).limit(ROW_LIMIT);
  for (const row of (roleRows ?? []) as { user_id: string | null }[]) {
    const id = String(row.user_id ?? "").trim();
    if (id) ids.add(id);
  }
  const { data: legacyRows } = await db.from("profiles").select("id").eq("role", role).limit(ROW_LIMIT);
  for (const row of (legacyRows ?? []) as { id: string | null }[]) {
    const id = String(row.id ?? "").trim();
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Every account id holding `kind`, from `profile_roles` plus the legacy singular `profiles.role`.
 *
 * Managers are wider than their role rows (a manager whose role row was never backfilled still
 * shows up by purchase or PropLane ID - see `listAdminPortalManagerUserIds`), but every resident
 * and vendor ALSO carries a PropLane ID, so that widening alone would list them under Managers
 * too. A resident or vendor is therefore left out of the Managers set unless they hold the
 * manager role themselves.
 */
export async function listAccountIdsByKind(db: SupabaseClient, kind: AdminAccountKind): Promise<string[]> {
  if (kind !== "manager") return [...(await roleHolderIds(db, kind))];
  const [wide, managerRole, residents, vendors] = await Promise.all([
    listAdminPortalManagerUserIds(db),
    roleHolderIds(db, "manager"),
    roleHolderIds(db, "resident"),
    roleHolderIds(db, "vendor"),
  ]);
  return wide.filter((id) => managerRole.has(id) || !(residents.has(id) || vendors.has(id)));
}

export function toAdminAccountProfile(row: ProfileSelectRow): AdminAccountProfile {
  return {
    id: row.id,
    email: row.email ?? "",
    fullName: row.full_name ?? "",
    phone: row.phone ?? "",
    propLaneId: row.manager_id ?? "",
    active: row.application_approved !== false,
    joinedAt: row.created_at ?? null,
    stripeConnectAccountId: String(row.stripe_connect_account_id ?? "").trim(),
  };
}

/** Profiles for the given ids with demo/sandbox accounts removed, newest first. */
export async function loadRealAccountProfiles(db: SupabaseClient, ids: string[]): Promise<AdminAccountProfile[]> {
  const rows = await loadProfilesByIdChunks<ProfileSelectRow>(db, ids, PROFILE_SELECT);
  return rows
    .filter((row) => !isPortalSandboxEmail(row.email))
    .map(toAdminAccountProfile)
    .sort((a, b) => (Date.parse(b.joinedAt ?? "") || 0) - (Date.parse(a.joinedAt ?? "") || 0));
}

export async function loadAccountProfilesByKind(
  db: SupabaseClient,
  kind: AdminAccountKind,
): Promise<AdminAccountProfile[]> {
  return loadRealAccountProfiles(db, await listAccountIdsByKind(db, kind));
}

/** Digits only, so "(206) 555-0100" matches "+12065550100". */
function digits(value: string): string {
  return value.replace(/\D+/g, "");
}

/** Name, email, phone or PropLane ID contains the query (case-insensitive; phone by digits). */
export function accountMatchesQuery(profile: AdminAccountProfile, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (profile.email.toLowerCase().includes(needle)) return true;
  if (profile.fullName.toLowerCase().includes(needle)) return true;
  if (profile.propLaneId.toLowerCase().includes(needle)) return true;
  const needleDigits = digits(needle);
  if (needleDigits.length >= 3 && digits(profile.phone).includes(needleDigits)) return true;
  return profile.phone.toLowerCase().includes(needle);
}
