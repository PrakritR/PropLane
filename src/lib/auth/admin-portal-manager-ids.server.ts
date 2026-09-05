import type { SupabaseClient } from "@supabase/supabase-js";

const ROW_LIMIT = 5000;
export const ADMIN_PROFILE_ID_CHUNK = 100;

/**
 * Every manager the admin Accounts tab should list. Role tables alone miss
 * production managers whose `profile_roles` row was never backfilled but who
 * already have a `manager_purchases` row, a PropLane `manager_id`, or property
 * records — they can use the manager portal while staying invisible here.
 */
export async function listAdminPortalManagerUserIds(db: SupabaseClient): Promise<string[]> {
  const ids = new Set<string>();

  const { data: roleRows } = await db
    .from("profile_roles")
    .select("user_id")
    .eq("role", "manager")
    .limit(ROW_LIMIT);
  for (const row of roleRows ?? []) {
    const id = String(row.user_id ?? "").trim();
    if (id) ids.add(id);
  }

  const { data: legacyRoleRows } = await db
    .from("profiles")
    .select("id")
    .eq("role", "manager")
    .limit(ROW_LIMIT);
  for (const row of legacyRoleRows ?? []) {
    const id = String(row.id ?? "").trim();
    if (id) ids.add(id);
  }

  const { data: managerIdRows } = await db
    .from("profiles")
    .select("id")
    .not("manager_id", "is", null)
    .limit(ROW_LIMIT);
  for (const row of managerIdRows ?? []) {
    const id = String(row.id ?? "").trim();
    if (id) ids.add(id);
  }

  const { data: purchaseRows } = await db
    .from("manager_purchases")
    .select("user_id")
    .not("user_id", "is", null)
    .limit(ROW_LIMIT);
  for (const row of purchaseRows ?? []) {
    const id = String(row.user_id ?? "").trim();
    if (id) ids.add(id);
  }

  return [...ids];
}

export async function loadProfilesByIdChunks<T extends Record<string, unknown>>(
  db: SupabaseClient,
  ids: string[],
  select: string,
): Promise<T[]> {
  if (ids.length === 0) return [];

  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += ADMIN_PROFILE_ID_CHUNK) {
    chunks.push(ids.slice(index, index + ADMIN_PROFILE_ID_CHUNK));
  }

  const rows: T[] = [];
  for (const chunk of chunks) {
    const { data, error } = await db.from("profiles").select(select).in("id", chunk);
    if (error) throw error;
    // Through `unknown`: with a runtime `select` string the client types the
    // result as its error shape, which does not overlap T, so a direct cast is
    // a compile error rather than a widening.
    rows.push(...((data ?? []) as unknown as T[]));
  }
  return rows;
}
