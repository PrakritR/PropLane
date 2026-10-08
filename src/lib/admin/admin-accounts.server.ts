import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  collectIdsPaged,
  countByIdChunks,
  listAdminPortalManagerUserIds,
  loadProfilesByIdChunks,
} from "@/lib/auth/admin-portal-manager-ids.server";
import { PORTAL_SANDBOX_EMAIL_SUFFIXES, isPortalSandboxEmail } from "@/lib/portal-sandbox-accounts";

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
/**
 * Every id holding `role`, read a page at a time (`collectIdsPaged`): the
 * account lists and every count derived from them are a count of real rows, so
 * a capped read would make the dashboard quietly wrong past the cap.
 */
async function roleHolderIds(db: SupabaseClient, role: AdminAccountKind): Promise<Set<string>> {
  const [roleRows, legacyRows] = await Promise.all([
    collectIdsPaged("user_id", (from, to) =>
      db.from("profile_roles").select("user_id").eq("role", role).order("user_id").range(from, to),
    ),
    collectIdsPaged("id", (from, to) =>
      db.from("profiles").select("id").eq("role", role).order("id").range(from, to),
    ),
  ]);
  return new Set([...roleRows, ...legacyRows]);
}

/**
 * The demo/sandbox accounts every real admin total leaves out
 * (`isPortalSandboxEmail`), as ids — so a count can exclude them without
 * reading a single profile row.
 */
export async function listSandboxAccountIds(db: SupabaseClient): Promise<Set<string>> {
  const sources = await Promise.all(
    PORTAL_SANDBOX_EMAIL_SUFFIXES.map((suffix) =>
      collectIdsPaged("id", (from, to) =>
        db.from("profiles").select("id").ilike("email", `%${suffix}`).order("id").range(from, to),
      ),
    ),
  );
  const ids = new Set<string>();
  for (const source of sources) for (const id of source) ids.add(id);
  return ids;
}

/**
 * An account is active unless it was disabled: `application_approved !== false`,
 * which `.not(..., "is", false)` says in SQL (a null stays active, as the row
 * predicate does).
 */
export async function countActiveAccounts(db: SupabaseClient, ids: string[]): Promise<number> {
  return countByIdChunks(ids, (chunk) =>
    db
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .in("id", chunk)
      .not("application_approved", "is", false),
  );
}

/** Active accounts among `ids` that have a linked Stripe Connect account. */
export async function countActiveAccountsWithPayouts(db: SupabaseClient, ids: string[]): Promise<number> {
  return countByIdChunks(ids, (chunk) =>
    db
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .in("id", chunk)
      .not("application_approved", "is", false)
      .not("stripe_connect_account_id", "is", null)
      .neq("stripe_connect_account_id", ""),
  );
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
