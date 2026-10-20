import { randomUUID } from "node:crypto";

/**
 * A stateful PostgREST fake for the phone-bound link tests. Supports the chains the link, code and
 * share-link modules use: select / insert / update / delete with eq, in, is, gte, gt, lt, not,
 * order, limit, `.select()` after a write, maybeSingle and single. A table in `broken` answers with
 * a Postgres "relation does not exist" error; a column in `missingColumns` makes any query that
 * names it answer 42703 (a database where a migration has not run yet).
 */
export type Row = Record<string, unknown>;

export type LinksFakeDb = {
  db: never;
  rows: Record<string, Row[]>;
  /** Every write, in order, for "what was stored" assertions. */
  writes: { table: string; op: "insert" | "update" | "delete"; value?: Row }[];
};

export function linksFakeDb(
  seed: Record<string, Row[]> = {},
  options: { broken?: string[]; missingColumns?: Record<string, string[]> } = {},
): LinksFakeDb {
  const rows: Record<string, Row[]> = structuredClone(seed);
  const writes: LinksFakeDb["writes"] = [];
  const broken = new Set(options.broken ?? []);
  const missing = options.missingColumns ?? {};

  const db = {
    from(table: string) {
      let op: "select" | "insert" | "update" | "delete" = "select";
      let patch: Row = {};
      let inserted: Row[] = [];
      let wantsReturn = false;
      let max = Infinity;
      let orderBy: { column: string; ascending: boolean } | null = null;
      const touched = new Set<string>();
      const predicates: ((row: Row) => boolean)[] = [];

      const touch = (column: string) => touched.add(column.split("->>")[0]!);
      const execute = (): { data: Row[] | null; error: { code: string; message: string } | null } => {
        if (broken.has(table)) return { data: null, error: { code: "42P01", message: "relation does not exist" } };
        const absent = (missing[table] ?? []).find((c) => touched.has(c));
        if (absent) return { data: null, error: { code: "42703", message: `column ${table}.${absent} does not exist` } };
        const list = (rows[table] ??= []);
        if (op === "insert") {
          for (const row of inserted) {
            const next: Row = { id: randomUUID(), created_at: new Date().toISOString(), ...row };
            if (table === "phone_bound_links") {
              next.open_count ??= 0;
              next.revoked_at ??= null;
              next.used_at ??= null;
            }
            if (table === "phone_otp_challenges") {
              next.attempts ??= 0;
              next.consumed_at ??= null;
            }
            list.push(next);
          }
          return { data: list.slice(-inserted.length), error: null };
        }
        const matched = list.filter((row) => predicates.every((p) => p(row)));
        if (op === "update") {
          for (const row of matched) Object.assign(row, patch);
          return { data: matched, error: null };
        }
        if (op === "delete") {
          rows[table] = list.filter((row) => !matched.includes(row));
          return { data: matched, error: null };
        }
        const sorted = orderBy
          ? [...matched].sort((a, b) => {
              const x = String(a[orderBy!.column] ?? "");
              const y = String(b[orderBy!.column] ?? "");
              return orderBy!.ascending ? x.localeCompare(y) : y.localeCompare(x);
            })
          : matched;
        return { data: sorted.slice(0, max), error: null };
      };

      const where = (column: string, test: (value: unknown) => boolean) => {
        touch(column);
        predicates.push((row) => test(row[column]));
        return query;
      };
      const query: Record<string, unknown> = {
        select(columns?: string) {
          if (op === "insert" || op === "update" || op === "delete") wantsReturn = true;
          if (typeof columns === "string") for (const c of columns.split(",")) touch(c.trim());
          return query;
        },
        insert(value: Row | Row[]) {
          op = "insert";
          inserted = Array.isArray(value) ? value : [value];
          for (const row of inserted) {
            writes.push({ table, op: "insert", value: row });
            for (const key of Object.keys(row)) touch(key);
          }
          return query;
        },
        update(value: Row) {
          op = "update";
          patch = value;
          writes.push({ table, op: "update", value });
          return query;
        },
        delete() {
          op = "delete";
          writes.push({ table, op: "delete" });
          return query;
        },
        eq: (column: string, value: unknown) => where(column, (v) => v === value),
        like: (column: string, pattern: string) => {
          const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`);
          return where(column, (v) => re.test(String(v ?? "")));
        },
        in: (column: string, values: unknown[]) => where(column, (v) => values.includes(v)),
        is: (column: string, value: unknown) => where(column, (v) => (value === null ? v == null : v === value)),
        not: (column: string, _op: string, value: unknown) => where(column, (v) => (value === null ? v != null : v !== value)),
        gte: (column: string, value: unknown) => where(column, (v) => String(v ?? "") >= String(value)),
        gt: (column: string, value: unknown) => where(column, (v) => String(v ?? "") > String(value)),
        lt: (column: string, value: unknown) => where(column, (v) => String(v ?? "") < String(value)),
        order(column: string, opts?: { ascending?: boolean }) {
          orderBy = { column, ascending: opts?.ascending !== false };
          return query;
        },
        limit(n: number) {
          max = n;
          return query;
        },
        async maybeSingle() {
          const result = execute();
          return { data: result.data?.[0] ?? null, error: result.error };
        },
        async single() {
          const result = execute();
          const first = result.data?.[0] ?? null;
          return { data: first, error: result.error ?? (first ? null : { code: "PGRST116", message: "no rows" }) };
        },
        then(resolve: (value: unknown) => void, reject?: (reason: unknown) => void) {
          try {
            const result = execute();
            // A bare write with no `.select()` has no rows to hand back.
            resolve({ data: wantsReturn || op === "select" ? result.data : null, error: result.error });
          } catch (error) {
            reject?.(error);
          }
        },
      };
      return query;
    },
  };
  return { db: db as never, rows, writes };
}
