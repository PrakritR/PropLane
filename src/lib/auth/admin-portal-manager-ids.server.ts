import type { SupabaseClient } from "@supabase/supabase-js";

const PAGE_SIZE = 1000;
export const ADMIN_PROFILE_ID_CHUNK = 100;

/**
 * Every id a filtered select returns, read a page at a time.
 *
 * A bare `.limit(n)` silently truncated the admin account lists (and therefore
 * every count derived from them) once a role passed `n` holders: the page said
 * `n` with nothing on screen admitting it. Paging until a short page arrives
 * cannot truncate, and the counts stay a count of real rows.
 */
export async function collectIdsPaged(
  column: string,
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) break;
    const rows = (Array.isArray(data) ? data : []) as Record<string, unknown>[];
    for (const row of rows) {
      const id = String(row[column] ?? "").trim();
      if (id) ids.add(id);
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return ids;
}

/**
 * Every manager the admin Accounts tab should list. Role tables alone miss
 * production managers whose `profile_roles` row was never backfilled but who
 * already have a `manager_purchases` row, a PropLane `manager_id`, or property
 * records — they can use the manager portal while staying invisible here.
 */
export async function listAdminPortalManagerUserIds(db: SupabaseClient): Promise<string[]> {
  const sources = await Promise.all([
    collectIdsPaged("user_id", (from, to) =>
      db.from("profile_roles").select("user_id").eq("role", "manager").range(from, to),
    ),
    collectIdsPaged("id", (from, to) => db.from("profiles").select("id").eq("role", "manager").range(from, to)),
    collectIdsPaged("id", (from, to) =>
      db.from("profiles").select("id").not("manager_id", "is", null).range(from, to),
    ),
    collectIdsPaged("user_id", (from, to) =>
      db.from("manager_purchases").select("user_id").not("user_id", "is", null).range(from, to),
    ),
  ]);

  const ids = new Set<string>();
  for (const source of sources) for (const id of source) ids.add(id);
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
