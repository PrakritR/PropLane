/**
 * A small thenable PostgREST fake for the Unassigned-leads tests: select / insert / update / upsert
 * with eq, in, is, not, lt, gt, like, order, limit, range, `.select()` on a write, maybeSingle, and
 * `count: "exact"`. A table can carry a constraint function that rejects an insert with a Postgres
 * code (23505 for a unique index). Rows get an `id` and an increasing `created_at` when they have none.
 */
export type LeadRow = Record<string, unknown>;

type Constraint = (row: LeadRow, existing: LeadRow[]) => string | null;

export type LeadFakeDb = {
  db: never;
  rows: Record<string, LeadRow[]>;
  /** Every `{ table, op }` in order. */
  log: { table: string; op: "select" | "insert" | "update" | "upsert" | "delete" }[];
};

const read = (row: LeadRow, column: string): unknown => row[column];

export function leadFakeDb(
  seed: Record<string, LeadRow[]> = {},
  options: {
    constraints?: Record<string, Constraint>;
    /** Tables that are not there at all (42P01). */
    broken?: string[];
    /**
     * Tables that ARE there but whose reads and writes fail. Unlike `broken`, this is the shape of a transient
     * failure (a statement timeout, a connection drop), which callers must tell apart from a missing migration.
     */
    failing?: string[];
  } = {},
): LeadFakeDb {
  const rows: Record<string, LeadRow[]> = structuredClone(seed);
  const log: LeadFakeDb["log"] = [];
  let counter = 0;
  const tick = () => new Date(Date.UTC(2026, 9, 18, 10, 0, counter++)).toISOString();

  const db = {
    from(table: string) {
      const filters: ((row: LeadRow) => boolean)[] = [];
      let mode: "select" | "insert" | "update" | "upsert" | "delete" = "select";
      let payload: LeadRow[] = [];
      let patch: LeadRow = {};
      let returning = false;
      let single = false;
      let wantCount = false;
      let orderBy: { column: string; ascending: boolean } | null = null;
      let limit = Infinity;
      let from = 0;
      let onConflict: string[] = [];

      const run = (): { data: unknown; error: { code: string; message: string } | null; count?: number } => {
        log.push({ table, op: mode });
        if ((options.broken ?? []).includes(table)) return { data: null, error: { code: "42P01", message: "relation does not exist" } };
        if ((options.failing ?? []).includes(table)) return { data: null, error: { code: "57014", message: "statement timeout" } };
        const list = (rows[table] ??= []);
        if (mode === "insert" || mode === "upsert") {
          const inserted: LeadRow[] = [];
          for (const raw of payload) {
            const row: LeadRow = { ...raw };
            if (mode === "upsert" && onConflict.length) {
              const at = list.findIndex((r) => onConflict.every((k) => r[k] === row[k]));
              if (at !== -1) {
                Object.assign(list[at]!, row);
                inserted.push(list[at]!);
                continue;
              }
            }
            const code = options.constraints?.[table]?.(row, list) ?? null;
            if (code) return { data: null, error: { code, message: `constraint ${code}` } };
            if (row.id === undefined && !["sms_line_sessions"].includes(table)) row.id = `${table}-${list.length + 1}`;
            if (row.created_at === undefined) row.created_at = tick();
            if (row.updated_at === undefined) row.updated_at = row.created_at;
            list.push(row);
            inserted.push(row);
          }
          return { data: returning ? inserted : null, error: null };
        }
        const matched = list.filter((row) => filters.every((f) => f(row)));
        if (mode === "delete") {
          const doomed = list.filter((row) => filters.every((f) => f(row)));
          rows[table] = list.filter((row) => !doomed.includes(row));
          return { data: returning ? doomed : null, error: null };
        }
        if (mode === "update") {
          for (const row of matched) Object.assign(row, patch);
          return { data: returning ? matched : null, error: null };
        }
        let out = [...matched];
        if (orderBy) {
          const { column, ascending } = orderBy;
          out.sort((a, b) => {
            const x = String(read(a, column) ?? "");
            const y = String(read(b, column) ?? "");
            return ascending ? x.localeCompare(y) : y.localeCompare(x);
          });
        }
        const total = out.length;
        // Reads return copies, like a real database: a row read before a write does not change under the reader.
        out = out.slice(from, from + limit).map((r) => ({ ...r }));
        return { data: out, error: null, ...(wantCount ? { count: total } : {}) };
      };

      const finish = () => {
        const result = run();
        if (single) {
          const first = Array.isArray(result.data) ? (result.data[0] ?? null) : result.data;
          return { data: first, error: result.error };
        }
        return result;
      };

      const q: Record<string, unknown> = {
        select(_cols?: string, opts?: { count?: string }) {
          if (mode === "select") mode = "select";
          else returning = true;
          if (opts?.count) wantCount = true;
          return q;
        },
        insert(value: LeadRow | LeadRow[]) { mode = "insert"; payload = Array.isArray(value) ? value : [value]; return q; },
        upsert(value: LeadRow | LeadRow[], opts?: { onConflict?: string }) {
          mode = "upsert";
          payload = Array.isArray(value) ? value : [value];
          onConflict = (opts?.onConflict ?? "id").split(",").map((k) => k.trim());
          return q;
        },
        delete() { mode = "delete"; return q; },
        update(value: LeadRow) { mode = "update"; patch = value; return q; },
        eq(column: string, value: unknown) { filters.push((r) => read(r, column) === value); return q; },
        in(column: string, values: unknown[]) { filters.push((r) => values.includes(read(r, column))); return q; },
        is(column: string, value: unknown) { filters.push((r) => (value === null ? read(r, column) == null : read(r, column) === value)); return q; },
        not(column: string, _op: string, value: unknown) { filters.push((r) => (value === null ? read(r, column) != null : read(r, column) !== value)); return q; },
        lt(column: string, value: unknown) { filters.push((r) => String(read(r, column) ?? "") < String(value)); return q; },
        gt(column: string, value: unknown) { filters.push((r) => String(read(r, column) ?? "") > String(value)); return q; },
        like(column: string, pattern: string) {
          const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`);
          filters.push((r) => re.test(String(read(r, column) ?? "")));
          return q;
        },
        order(column: string, opts?: { ascending?: boolean }) { orderBy = { column, ascending: opts?.ascending !== false }; return q; },
        limit(n: number) { limit = n; return q; },
        range(a: number, b: number) { from = a; limit = b - a + 1; return q; },
        maybeSingle() { single = true; return Promise.resolve(finish()); },
        single() { single = true; return Promise.resolve(finish()); },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve(finish()).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return { db: db as never, rows, log };
}

/** The constraints the real tables carry that the lead code leans on. */
export const LEAD_CONSTRAINTS: Record<string, Constraint> = {
  sms_unassigned_leads: (row, existing) =>
    row.status === "open" && existing.some((r) => r.status === "open" && r.phone_key === row.phone_key) ? "23505" : null,
  sms_unassigned_lead_turns: (row, existing) =>
    row.message_sid != null && existing.some((r) => r.message_sid === row.message_sid) ? "23505" : null,
  sms_onboarding_replies: (row, existing) => (existing.some((r) => r.message_sid === row.message_sid) ? "23505" : null),
  sms_entry_codes: (row, existing) => (existing.some((r) => r.code === row.code) ? "23505" : null),
};
