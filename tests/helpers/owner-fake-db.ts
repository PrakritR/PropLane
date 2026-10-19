/**
 * A stateful PostgREST fake for the owner-management tests: select / insert / update / delete chains with
 * eq, neq, in, is, not, gte, lte, lt, gt, or-less filters, order, limit, single / maybeSingle, select after write,
 * upsert, and `rpc(name, args)` answered by handlers the test supplies. A table in `broken` answers with
 * a Postgres "relation does not exist" error (code that runs before its migration).
 */
export type FakeRow = Record<string, unknown>;
export type RpcHandler = (args: Record<string, unknown>, db: OwnerFakeDb) => unknown | Promise<unknown>;

export type OwnerFakeDb = {
  db: never;
  rows: Record<string, FakeRow[]>;
  rpcCalls: { name: string; args: Record<string, unknown> }[];
  writes: { table: string; op: "insert" | "update" | "delete" | "upsert"; value?: FakeRow }[];
};

function read(row: FakeRow, column: string): unknown {
  if (column.includes("->>")) {
    const [base, key] = column.split("->>");
    const inner = row[base!];
    return inner && typeof inner === "object" ? (inner as FakeRow)[key!] : undefined;
  }
  return row[column];
}

let idCounter = 0;

export function fakeOwnerDb(
  seed: Record<string, FakeRow[]> = {},
  options: { broken?: string[]; rpc?: Record<string, RpcHandler>; uniques?: Record<string, string[][]> } = {},
): OwnerFakeDb {
  const rows: Record<string, FakeRow[]> = structuredClone(seed);
  const rpcCalls: OwnerFakeDb["rpcCalls"] = [];
  const writes: OwnerFakeDb["writes"] = [];
  const broken = new Set(options.broken ?? []);
  const self: OwnerFakeDb = { db: null as never, rows, rpcCalls, writes };

  const violatesUnique = (table: string, candidate: FakeRow, ignoreId?: unknown): boolean => {
    for (const cols of options.uniques?.[table] ?? []) {
      if (cols.some((c) => candidate[c] == null)) continue;
      if ((rows[table] ?? []).some((r) => r !== candidate && r.id !== ignoreId && cols.every((c) => r[c] === candidate[c]))) return true;
    }
    return false;
  };

  const db = {
    from(table: string) {
      const predicates: ((row: FakeRow) => boolean)[] = [];
      let maxRows = Infinity;
      let mode: "select" | "update" | "insert" | "delete" = "select";
      let patch: FakeRow = {};
      let inserted: FakeRow[] = [];
      let orderBy: { column: string; ascending: boolean }[] = [];
      let wantResult = false;

      const run = (): { data: FakeRow[] | null; error: { code: string; message: string } | null } => {
        if (broken.has(table)) return { data: null, error: { code: "42P01", message: "relation does not exist" } };
        const list = (rows[table] ??= []);
        if (mode === "insert") {
          const out: FakeRow[] = [];
          for (const raw of inserted) {
            const row = { id: raw.id ?? `fake-${++idCounter}`, created_at: new Date().toISOString(), ...raw };
            if (violatesUnique(table, row)) return { data: null, error: { code: "23505", message: "duplicate key" } };
            list.push(row);
            out.push(row);
          }
          return { data: out, error: null };
        }
        let matched = list.filter((row) => predicates.every((p) => p(row)));
        if (mode === "update") {
          for (const row of matched) {
            const next = { ...row, ...patch };
            if (violatesUnique(table, next, row.id)) return { data: null, error: { code: "23505", message: "duplicate key" } };
            Object.assign(row, patch);
          }
          return { data: matched, error: null };
        }
        if (mode === "delete") {
          rows[table] = list.filter((row) => !matched.includes(row));
          return { data: matched, error: null };
        }
        for (const o of [...orderBy].reverse()) {
          matched = [...matched].sort((a, b) => {
            const x = String(read(a, o.column) ?? "");
            const y = String(read(b, o.column) ?? "");
            return o.ascending ? x.localeCompare(y) : y.localeCompare(x);
          });
        }
        return { data: matched.slice(0, maxRows), error: null };
      };

      const query: Record<string, unknown> = {
        select() { wantResult = true; return query; },
        eq(column: string, value: unknown) { predicates.push((row) => read(row, column) === value); return query; },
        neq(column: string, value: unknown) { predicates.push((row) => read(row, column) !== value); return query; },
        in(column: string, values: unknown[]) { predicates.push((row) => values.includes(read(row, column))); return query; },
        is(column: string, value: unknown) { predicates.push((row) => (value === null ? read(row, column) == null : read(row, column) === value)); return query; },
        not(column: string, _op: string, value: unknown) { predicates.push((row) => (value === null ? read(row, column) != null : read(row, column) !== value)); return query; },
        gte(column: string, value: unknown) { predicates.push((row) => String(read(row, column) ?? "") >= String(value)); return query; },
        gt(column: string, value: unknown) { predicates.push((row) => String(read(row, column) ?? "") > String(value)); return query; },
        lte(column: string, value: unknown) { predicates.push((row) => String(read(row, column) ?? "") <= String(value)); return query; },
        lt(column: string, value: unknown) { predicates.push((row) => String(read(row, column) ?? "") < String(value)); return query; },
        order(column: string, opts?: { ascending?: boolean }) { orderBy.push({ column, ascending: opts?.ascending !== false }); return query; },
        limit(n: number) { maxRows = n; return query; },
        range() { return query; },
        update(value: FakeRow) { mode = "update"; patch = value; writes.push({ table, op: "update", value }); return query; },
        delete() { mode = "delete"; writes.push({ table, op: "delete" }); return query; },
        insert(value: FakeRow | FakeRow[]) {
          mode = "insert";
          inserted = Array.isArray(value) ? value : [value];
          for (const v of inserted) writes.push({ table, op: "insert", value: v });
          return query;
        },
        async upsert(value: FakeRow | FakeRow[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
          if (broken.has(table)) return { error: { code: "42P01" } };
          const list = (rows[table] ??= []);
          const keys = (opts?.onConflict ?? "id").split(",").map((k) => k.trim());
          for (const v of Array.isArray(value) ? value : [value]) {
            writes.push({ table, op: "upsert", value: v });
            const at = list.findIndex((row) => keys.every((k) => row[k] === v[k]));
            if (at === -1) list.push({ ...v });
            else if (!opts?.ignoreDuplicates) Object.assign(list[at]!, v);
          }
          return { error: null };
        },
        async maybeSingle() {
          const r = run();
          return { data: r.data?.[0] ?? null, error: r.error };
        },
        async single() {
          const r = run();
          const first = r.data?.[0] ?? null;
          return { data: first, error: r.error ?? (first ? null : { code: "PGRST116", message: "no rows" }) };
        },
        then(resolve: (result: unknown) => void, reject?: (e: unknown) => void) {
          try { const r = run(); resolve({ data: wantResult || mode === "select" ? r.data : null, error: r.error }); } catch (e) { reject?.(e); }
        },
      };
      return query;
    },
    async rpc(name: string, args: Record<string, unknown> = {}) {
      rpcCalls.push({ name, args });
      const handler = options.rpc?.[name];
      if (!handler) return { data: null, error: { code: "42883", message: `no handler for ${name}` } };
      try {
        return { data: await handler(args, self), error: null };
      } catch (e) {
        return { data: null, error: { code: "P0001", message: e instanceof Error ? e.message : "rpc failed" } };
      }
    },
  };
  self.db = db as never;
  return self;
}
