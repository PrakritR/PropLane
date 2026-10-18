/**
 * Database helpers for the migration scripts: keyset paging (stable while rows change under us),
 * chunked writes, and the one rule every one-number read follows: Postgres 42P01 / 42703 and
 * PostgREST PGRST204 / PGRST205 mean "this migration has not run here", never a crash.
 */

export function isMissingSchema(error) {
  const code = String(error?.code ?? "");
  return code === "42P01" || code === "42703" || code === "PGRST204" || code === "PGRST205";
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Every row of `table` matching `filter`, newest-stable: keyset paging on `key` so a concurrent insert
 * or our own stamping never skips or repeats a row. `missing: true` = the table/column is not migrated.
 */
export async function fetchAll(db, table, columns, { key = "id", filter = (q) => q, pageSize = 1000, limit = Infinity, offsetPaging = false } = {}) {
  const rows = [];
  let last = null;
  for (;;) {
    let query = db.from(table).select(columns);
    query = filter(query);
    if (offsetPaging) {
      // For small tables with no single-column key (composite primary keys): stable because nothing writes while we read.
      query = query.order(key, { ascending: true }).range(rows.length, rows.length + pageSize - 1);
    } else {
      if (last !== null) query = query.gt(key, last);
      query = query.order(key, { ascending: true }).limit(pageSize);
    }
    const { data, error } = await query;
    if (error) {
      if (isMissingSchema(error)) return { rows: [], missing: true };
      throw new Error(`${table}: ${error.message ?? error.code ?? "read failed"}`);
    }
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize || rows.length >= limit) break;
    if (offsetPaging) continue;
    last = page[page.length - 1][key];
    if (last === undefined || last === null) throw new Error(`${table}: paging key "${key}" must be selected`);
  }
  return { rows, missing: false };
}

export async function countRows(db, table, filter = (q) => q) {
  const { count, error } = await filter(db.from(table).select("*", { count: "exact", head: true }));
  if (error) {
    if (isMissingSchema(error)) return { count: 0, missing: true };
    throw new Error(`${table}: ${error.message ?? error.code ?? "count failed"}`);
  }
  return { count: count ?? 0, missing: false };
}

export function unwrap(label, result) {
  if (result.error) throw new Error(`${label}: ${result.error.message ?? result.error.code ?? "failed"}`);
  return result.data;
}
