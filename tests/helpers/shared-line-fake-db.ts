/**
 * A small stateful PostgREST fake for the shared-line router tests: select with
 * eq / in / not / is / order / limit, `row_data->>x` paths, upsert (with onConflict and
 * ignoreDuplicates), insert and update. A table listed in `broken` answers with a
 * Postgres "relation does not exist" error, like code that runs before its migration.
 */
export type FakeRow = Record<string, unknown>;

export type FakeSharedLineDb = {
  db: never;
  rows: Record<string, FakeRow[]>;
  upserts: { table: string; row: FakeRow }[];
  /** Every table name that was read or written, in order. */
  touched: string[];
};

function read(row: FakeRow, column: string): unknown {
  if (column.includes("->>")) {
    const [base, key] = column.split("->>");
    const inner = row[base];
    return inner && typeof inner === "object" ? (inner as FakeRow)[key] : undefined;
  }
  return row[column];
}

export function fakeSharedLineDb(
  seed: Record<string, FakeRow[]> = {},
  options: { broken?: string[] } = {},
): FakeSharedLineDb {
  const rows: Record<string, FakeRow[]> = structuredClone(seed);
  const upserts: { table: string; row: FakeRow }[] = [];
  const touched: string[] = [];
  const broken = new Set(options.broken ?? []);

  const db = {
    from(table: string) {
      touched.push(table);
      const predicates: ((row: FakeRow) => boolean)[] = [];
      let maxRows = Infinity;
      let mode: "select" | "update" = "select";
      let patch: FakeRow = {};
      const execute = () => {
        if (broken.has(table)) return { data: null, error: { code: "42P01", message: "relation does not exist" } };
        const list = (rows[table] ??= []);
        const matched = list.filter((row) => predicates.every((p) => p(row)));
        if (mode === "update") {
          for (const row of matched) Object.assign(row, patch);
          return { data: matched, error: null };
        }
        return { data: matched.slice(0, maxRows), error: null };
      };
      const query: Record<string, unknown> = {
        select() { return query; },
        eq(column: string, value: unknown) { predicates.push((row) => read(row, column) === value); return query; },
        in(column: string, values: unknown[]) { predicates.push((row) => values.includes(read(row, column))); return query; },
        is(column: string, value: unknown) { predicates.push((row) => (value === null ? read(row, column) == null : read(row, column) === value)); return query; },
        not(column: string, _op: string, value: unknown) { predicates.push((row) => (value === null ? read(row, column) != null : read(row, column) !== value)); return query; },
        order() { return query; },
        limit(n: number) { maxRows = n; return query; },
        update(value: FakeRow) { mode = "update"; patch = value; return query; },
        async maybeSingle() {
          const result = execute();
          const first = Array.isArray(result.data) ? result.data[0] : null;
          return { data: first ?? null, error: result.error };
        },
        async insert(value: FakeRow | FakeRow[]) {
          if (broken.has(table)) return { error: { code: "42P01" } };
          (rows[table] ??= []).push(...(Array.isArray(value) ? value : [value]));
          return { error: null };
        },
        async upsert(value: FakeRow, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
          if (broken.has(table)) return { error: { code: "42P01" } };
          upserts.push({ table, row: value });
          const list = (rows[table] ??= []);
          const keys = (opts?.onConflict ?? "id").split(",").map((k) => k.trim());
          const at = list.findIndex((row) => keys.every((k) => row[k] === value[k]));
          if (at === -1) list.push({ ...value });
          else if (!opts?.ignoreDuplicates) Object.assign(list[at], value);
          return { error: null };
        },
        then(resolve: (result: unknown) => void) { resolve(execute()); },
      };
      return query;
    },
  };
  return { db: db as never, rows, upserts, touched };
}
