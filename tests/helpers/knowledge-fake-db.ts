/**
 * An in-memory PostgREST fake for the one-number knowledge tests: select / insert / update / delete /
 * upsert with eq, neq, in, is, not, gte, gt, lt, lte, order, limit, maybeSingle. A table listed in
 * `broken` answers with Postgres 42P01 (relation does not exist), like code running before its migration.
 */
export type Row = Record<string, unknown>;

export type KnowledgeFakeDb = {
  db: never;
  rows: Record<string, Row[]>;
  /** Table names touched, in order. */
  touched: string[];
};

function read(row: Row, column: string): unknown {
  if (column.includes("->>")) {
    const [base, key] = column.split("->>");
    const inner = row[base];
    return inner && typeof inner === "object" ? (inner as Row)[key] : undefined;
  }
  return row[column];
}

export function knowledgeFakeDb(seed: Record<string, Row[]> = {}, options: { broken?: string[] } = {}): KnowledgeFakeDb {
  const rows: Record<string, Row[]> = structuredClone(seed);
  const touched: string[] = [];
  const broken = new Set(options.broken ?? []);
  let counter = 0;

  const db = {
    from(table: string) {
      touched.push(table);
      const predicates: ((row: Row) => boolean)[] = [];
      let mode: "select" | "update" | "delete" | "insert" = "select";
      let patch: Row = {};
      let inserted: Row[] = [];
      let orderBy: { column: string; ascending: boolean } | null = null;
      let maxRows = Infinity;
      const brokenResult = () => ({ data: null, error: { code: "42P01", message: "relation does not exist" } });

      const execute = () => {
        if (broken.has(table)) return brokenResult();
        const list = (rows[table] ??= []);
        if (mode === "insert") {
          for (const row of inserted) {
            if (row.id === undefined && !["sms_knowledge_digests", "sms_topic_reply_modes"].includes(table)) row.id = `gen-${(counter += 1)}`;
            list.push(row);
          }
          return { data: inserted, error: null };
        }
        let matched = list.filter((row) => predicates.every((p) => p(row)));
        if (mode === "update") {
          for (const row of matched) Object.assign(row, patch);
          return { data: matched, error: null };
        }
        if (mode === "delete") {
          rows[table] = list.filter((row) => !matched.includes(row));
          return { data: matched, error: null };
        }
        if (orderBy) {
          const { column, ascending } = orderBy;
          matched = [...matched].sort((a, b) => {
            const x = String(read(a, column) ?? "");
            const y = String(read(b, column) ?? "");
            return ascending ? x.localeCompare(y) : y.localeCompare(x);
          });
        }
        return { data: matched.slice(0, maxRows), error: null };
      };

      const query: Record<string, unknown> = {
        select() { return query; },
        eq(column: string, value: unknown) { predicates.push((row) => read(row, column) === value); return query; },
        neq(column: string, value: unknown) { predicates.push((row) => read(row, column) !== value); return query; },
        in(column: string, values: unknown[]) { predicates.push((row) => values.includes(read(row, column))); return query; },
        is(column: string, value: unknown) { predicates.push((row) => (value === null ? read(row, column) == null : read(row, column) === value)); return query; },
        not(column: string, _op: string, value: unknown) { predicates.push((row) => (value === null ? read(row, column) != null : read(row, column) !== value)); return query; },
        gte(column: string, value: unknown) { predicates.push((row) => String(read(row, column) ?? "") >= String(value)); return query; },
        gt(column: string, value: unknown) { predicates.push((row) => String(read(row, column) ?? "") > String(value)); return query; },
        lt(column: string, value: unknown) { predicates.push((row) => String(read(row, column) ?? "") < String(value)); return query; },
        lte(column: string, value: unknown) { predicates.push((row) => String(read(row, column) ?? "") <= String(value)); return query; },
        order(column: string, opts?: { ascending?: boolean }) { orderBy = { column, ascending: opts?.ascending !== false }; return query; },
        limit(n: number) { maxRows = n; return query; },
        update(value: Row) { mode = "update"; patch = value; return query; },
        delete() { mode = "delete"; return query; },
        insert(value: Row | Row[]) {
          mode = "insert";
          inserted = (Array.isArray(value) ? value : [value]).map((r) => ({ ...r }));
          return query;
        },
        upsert(value: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
          if (broken.has(table)) return Promise.resolve({ error: { code: "42P01" } });
          const list = (rows[table] ??= []);
          const keys = (opts?.onConflict ?? "id").split(",").map((k) => k.trim());
          for (const item of Array.isArray(value) ? value : [value]) {
            const at = list.findIndex((row) => keys.every((k) => row[k] === item[k]));
            if (at === -1) list.push({ ...item });
            else if (!opts?.ignoreDuplicates) Object.assign(list[at], item);
          }
          return Promise.resolve({ error: null });
        },
        async maybeSingle() {
          const result = execute();
          const first = Array.isArray(result.data) ? result.data[0] : null;
          return { data: first ?? null, error: result.error };
        },
        then(resolve: (result: unknown) => void) { resolve(execute()); },
      };
      return query;
    },
  };
  return { db: db as never, rows, touched };
}
