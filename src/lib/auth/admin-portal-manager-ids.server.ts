import type { SupabaseClient } from "@supabase/supabase-js";

export const ADMIN_PAGE_SIZE = 1000;
export const ADMIN_PROFILE_ID_CHUNK = 100;
/** Enough pages for 200k rows; past that the caller gets an error instead of an endless loop. */
const MAX_PAGES = 200;
/** Parallel id-chunk reads. Bounded so a large account table cannot open an unbounded fan-out. */
const ID_CHUNK_CONCURRENCY = 6;

type PageResult = { data: unknown; error: unknown };

/**
 * Every row a filtered select returns, read a page at a time.
 *
 * A bare `.limit(n)` silently truncated the admin account lists (and therefore
 * every count derived from them) once a role passed `n` holders: the page said
 * `n` with nothing on screen admitting it. Two rules keep paging honest, and
 * every caller must follow them: the query carries a stable `.order()` on a
 * unique column (OFFSET paging over an unordered select can skip a row that
 * moves between pages), and a failed page throws instead of returning a short
 * answer that reads like the whole set.
 */
export async function readAllPages<T>(page: (from: number, to: number) => PromiseLike<PageResult>): Promise<T[]> {
  const rows: T[] = [];
  for (let index = 0; index < MAX_PAGES; index += 1) {
    const from = index * ADMIN_PAGE_SIZE;
    const { data, error } = await page(from, from + ADMIN_PAGE_SIZE - 1);
    if (error) throw error;
    const batch = (Array.isArray(data) ? data : []) as T[];
    rows.push(...batch);
    if (batch.length < ADMIN_PAGE_SIZE) return rows;
  }
  throw new Error("Admin paged read did not finish within its page budget.");
}

/** `readAllPages`, reduced to the distinct ids in `column`. */
export async function collectIdsPaged(
  column: string,
  page: (from: number, to: number) => PromiseLike<PageResult>,
): Promise<Set<string>> {
  const rows = await readAllPages<Record<string, unknown>>(page);
  const ids = new Set<string>();
  for (const row of rows) {
    const id = String(row[column] ?? "").trim();
    if (id) ids.add(id);
  }
  return ids;
}

/** Run `fn` over `items`, at most `limit` at a time, results in input order. */
export async function mapWithBoundedConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function idChunks(ids: string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += ADMIN_PROFILE_ID_CHUNK) {
    chunks.push(ids.slice(index, index + ADMIN_PROFILE_ID_CHUNK));
  }
  return chunks;
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
      db.from("profile_roles").select("user_id").eq("role", "manager").order("user_id").range(from, to),
    ),
    collectIdsPaged("id", (from, to) =>
      db.from("profiles").select("id").eq("role", "manager").order("id").range(from, to),
    ),
    collectIdsPaged("id", (from, to) =>
      db.from("profiles").select("id").not("manager_id", "is", null).order("id").range(from, to),
    ),
    collectIdsPaged("user_id", (from, to) =>
      db.from("manager_purchases").select("user_id").not("user_id", "is", null).order("id").range(from, to),
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

  const batches = await mapWithBoundedConcurrency(idChunks(ids), ID_CHUNK_CONCURRENCY, async (chunk) => {
    const { data, error } = await db.from("profiles").select(select).in("id", chunk);
    if (error) throw error;
    // Through `unknown`: with a runtime `select` string the client types the
    // result as its error shape, which does not overlap T, so a direct cast is
    // a compile error rather than a widening.
    return (data ?? []) as unknown as T[];
  });

  return batches.flat();
}

/**
 * How many of `ids` a filtered count matches, counted in the database (`head`:
 * no row ever crosses the wire). The chunks run with the same bounded
 * concurrency the profile reads use.
 */
export async function countByIdChunks(
  ids: string[],
  count: (chunk: string[]) => PromiseLike<{ count: number | null; error: unknown }>,
): Promise<number> {
  if (ids.length === 0) return 0;
  const counts = await mapWithBoundedConcurrency(idChunks(ids), ID_CHUNK_CONCURRENCY, async (chunk) => {
    const { count: matched, error } = await count(chunk);
    if (error) throw error;
    return matched ?? 0;
  });
  return counts.reduce((total, matched) => total + matched, 0);
}
