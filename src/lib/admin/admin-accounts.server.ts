import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ADMIN_PROFILE_ID_CHUNK,
  collectIdsPaged,
  countByIdChunks,
  listAdminPortalManagerUserIds,
  loadProfilesByIdChunks,
  mapWithBoundedConcurrency,
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
 * THE membership rule, in one place.
 *
 * Managers are wider than their role rows (a manager whose role row was never backfilled still
 * shows up by purchase or PropLane ID - see `listAdminPortalManagerUserIds`), but every resident
 * and vendor ALSO carries a PropLane ID, so that widening alone would list them under Managers
 * too. A resident or vendor is therefore left out of the Managers set unless they hold the
 * manager role themselves.
 */
function managerIdsFrom(
  wide: string[],
  managerRole: ReadonlySet<string>,
  residents: ReadonlySet<string>,
  vendors: ReadonlySet<string>,
): string[] {
  return wide.filter((id) => managerRole.has(id) || !(residents.has(id) || vendors.has(id)));
}

/** Every account id holding `kind`, from `profile_roles` plus the legacy singular `profiles.role`. */
export async function listAccountIdsByKind(db: SupabaseClient, kind: AdminAccountKind): Promise<string[]> {
  if (kind !== "manager") return [...(await roleHolderIds(db, kind))];
  const [wide, managerRole, residents, vendors] = await Promise.all([
    listAdminPortalManagerUserIds(db),
    roleHolderIds(db, "manager"),
    roleHolderIds(db, "resident"),
    roleHolderIds(db, "vendor"),
  ]);
  return managerIdsFrom(wide, managerRole, residents, vendors);
}

/**
 * All three kind sets in one pass. Asking `listAccountIdsByKind` for each kind
 * reads the resident and vendor role sets twice over (the manager rule needs
 * them to subtract), so a caller that wants every kind asks here instead.
 */
export async function listAccountIdsForEveryKind(
  db: SupabaseClient,
): Promise<Record<AdminAccountKind, string[]>> {
  const [wide, managerRole, residents, vendors] = await Promise.all([
    listAdminPortalManagerUserIds(db),
    roleHolderIds(db, "manager"),
    roleHolderIds(db, "resident"),
    roleHolderIds(db, "vendor"),
  ]);
  return {
    manager: managerIdsFrom(wide, managerRole, residents, vendors),
    resident: [...residents],
    vendor: [...vendors],
  };
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

/**
 * A value used as a LIKE/ILIKE pattern, with the pattern characters escaped so
 * it only ever matches itself: a term holding `_` or `%` would otherwise
 * wildcard into rows it does not name.
 */
export function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** The columns a scanned profile window carries: enough to list it and to decide its kind. */
export type AdminProfileScanRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  phone: string | null;
  manager_id: string | null;
  role: string | null;
  application_approved: boolean | null;
  created_at: string | null;
};

const PROFILE_SCAN_SELECT = "id, email, full_name, phone, manager_id, role, application_approved, created_at";
const PROFILE_SCAN_WINDOW = 200;
const PROFILE_SCAN_MAX_WINDOWS = 10;

/**
 * The `or=` filter for an admin search term: email, name or PropLane ID
 * contains it. Null for an empty term, which matches every account.
 *
 * A term that is itself a number — digits and phone punctuation only, three
 * digits or more — matches a phone holding those digits in order, whatever
 * punctuation the stored number carries ("206 555" finds "+1 (206) 555-0142",
 * which a contiguous pattern misses). A term with letters in it is matched
 * against the phone as typed, so "axis-1002" stays a PropLane ID search.
 */
export function profileSearchFilter(query: string): string | null {
  const term = query.trim();
  if (!term) return null;
  const pattern = `%${likeLiteral(term)}%`;
  const clauses = [`email.ilike.${pattern}`, `full_name.ilike.${pattern}`, `manager_id.ilike.${pattern}`];
  const termDigits = digits(term);
  const termIsANumber = /^[\d\s()+.-]+$/.test(term) && termDigits.length >= 3;
  clauses.push(termIsANumber ? `phone.ilike.%${termDigits.split("").join("%")}%` : `phone.ilike.${pattern}`);
  return clauses.join(",");
}

/**
 * Newest profiles, a window at a time, until `limit` rows survive `keep` or the
 * table runs out — never more than `PROFILE_SCAN_MAX_WINDOWS` windows, so a
 * term that matches everything still costs a fixed number of reads.
 *
 * `complete` says the scan reached the end of the matching rows, which is what
 * lets a caller report a total rather than a floor. Ordered by `created_at`
 * then `id`, so the windows never skip or repeat a row.
 */
export async function scanNewestProfiles<T>(
  db: SupabaseClient,
  opts: { match: string | null; limit: number },
  keep: (rows: AdminProfileScanRow[]) => Promise<T[]> | T[],
): Promise<{ kept: T[]; complete: boolean }> {
  const kept: T[] = [];
  for (let index = 0; index < PROFILE_SCAN_MAX_WINDOWS; index += 1) {
    const from = index * PROFILE_SCAN_WINDOW;
    let query = db
      .from("profiles")
      .select(PROFILE_SCAN_SELECT)
      .order("created_at", { ascending: false })
      .order("id")
      .range(from, from + PROFILE_SCAN_WINDOW - 1);
    if (opts.match) query = query.or(opts.match) as typeof query;
    const { data, error } = await query;
    if (error) throw error;
    const rows = ((data ?? []) as unknown as AdminProfileScanRow[]).filter(
      (row) => !isPortalSandboxEmail(row.email),
    );
    kept.push(...(await keep(rows)));
    const windowWasShort = ((data ?? []) as unknown[]).length < PROFILE_SCAN_WINDOW;
    if (windowWasShort) return { kept, complete: true };
    if (kept.length >= opts.limit) return { kept, complete: false };
  }
  return { kept, complete: false };
}

/**
 * Which kinds each scanned profile belongs to, by the same rule the id sets
 * use (`managerIdsFrom`) — resolved for these rows only, so it stays bounded.
 * A multi-role account (how the team dogfoods) belongs to every kind it holds.
 */
export async function resolveAccountKinds(
  db: SupabaseClient,
  rows: AdminProfileScanRow[],
): Promise<Map<string, AdminAccountKind[]>> {
  const out = new Map<string, AdminAccountKind[]>();
  if (rows.length === 0) return out;

  const chunks: string[][] = [];
  const ids = rows.map((row) => row.id);
  for (let index = 0; index < ids.length; index += ADMIN_PROFILE_ID_CHUNK) {
    chunks.push(ids.slice(index, index + ADMIN_PROFILE_ID_CHUNK));
  }

  const rolesById = new Map<string, Set<string>>();
  const withPurchase = new Set<string>();
  await mapWithBoundedConcurrency(chunks, 4, async (chunk) => {
    const [roleRes, purchaseRes] = await Promise.all([
      db.from("profile_roles").select("user_id, role").in("user_id", chunk),
      db.from("manager_purchases").select("user_id").in("user_id", chunk),
    ]);
    if (roleRes.error) throw roleRes.error;
    if (purchaseRes.error) throw purchaseRes.error;
    for (const row of (roleRes.data ?? []) as { user_id: string | null; role: string | null }[]) {
      const id = String(row.user_id ?? "").trim();
      const role = String(row.role ?? "").trim();
      if (!id || !role) continue;
      const roles = rolesById.get(id) ?? new Set<string>();
      roles.add(role);
      rolesById.set(id, roles);
    }
    for (const row of (purchaseRes.data ?? []) as { user_id: string | null }[]) {
      const id = String(row.user_id ?? "").trim();
      if (id) withPurchase.add(id);
    }
  });

  for (const row of rows) {
    const roles = new Set(rolesById.get(row.id) ?? []);
    const legacyRole = String(row.role ?? "").trim();
    if (legacyRole) roles.add(legacyRole);
    const isResident = roles.has("resident");
    const isVendor = roles.has("vendor");
    const holdsManagerRole = roles.has("manager");
    const widerManager = holdsManagerRole || Boolean(String(row.manager_id ?? "").trim()) || withPurchase.has(row.id);
    const kinds: AdminAccountKind[] = [];
    if (holdsManagerRole || (widerManager && !isResident && !isVendor)) kinds.push("manager");
    if (isResident) kinds.push("resident");
    if (isVendor) kinds.push("vendor");
    if (kinds.length > 0) out.set(row.id, kinds);
  }
  return out;
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
