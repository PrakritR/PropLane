/**
 * Minimal generic fake of the supabase-js query builder shape vendor-banking
 * server modules use: table-backed rows, chained `.eq()`, `.select()`,
 * `.insert()`, `.update()`, `.maybeSingle()`, and `.rpc()` for the two
 * shortfall functions. Not a full supabase-js emulation — only what these
 * modules actually call.
 */
export type Row = Record<string, unknown>;

type RpcHandler = (params: Record<string, unknown>) => { data: unknown; error: null } | Promise<{ data: unknown; error: null }>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private negatedFilters: Array<[string, unknown]> = [];
  private mode: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private upsertConflictCol: string | null = null;
  private payload: Row | null = null;
  private cols: string | null = null;
  constructor(
    private rows: Row[],
    private table: string,
    private inserts: Array<{ table: string; row: Row }>,
  ) {}
  select(cols?: string) {
    this.cols = cols ?? null;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push([col, val]);
    return this;
  }
  in(col: string, values: unknown[]) {
    this.filters.push([col, values]);
    return this;
  }
  neq(col: string, val: unknown) {
    this.negatedFilters.push([col, val]);
    return this;
  }
  delete() {
    this.mode = "delete";
    return this;
  }
  lt(_col: string, _val: unknown) {
    return this;
  }
  gte(_col: string, _val: unknown) {
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  insert(row: Row) {
    this.mode = "insert";
    this.payload = row;
    return this;
  }
  update(row: Row) {
    this.mode = "update";
    this.payload = row;
    return this;
  }
  upsert(row: Row, opts?: { onConflict?: string }) {
    this.mode = "upsert";
    this.payload = row;
    this.upsertConflictCol = opts?.onConflict ?? null;
    return this;
  }
  private matched(): Row[] {
    return this.rows.filter(
      (r) =>
        this.filters.every(([c, v]) => (Array.isArray(v) ? v.includes(r[c]) : r[c] === v)) &&
        this.negatedFilters.every(([c, v]) => (r[c] ?? null) !== v),
    );
  }
  private exec(): { data: unknown; error: null } {
    if (this.mode === "insert") {
      const row = { id: `${this.table}_${this.rows.length + 1}`, ...this.payload! };
      this.rows.push(row);
      this.inserts.push({ table: this.table, row });
      return { data: [row], error: null };
    }
    if (this.mode === "update") {
      const matched = this.matched();
      for (const r of matched) Object.assign(r, this.payload);
      // PostgREST returns the updated rows only when the caller chains `.select()`; callers rely on
      // that to tell a compare-and-swap that matched from one that did not.
      return { data: this.cols ? matched : null, error: null };
    }
    if (this.mode === "delete") {
      for (const hit of this.matched()) this.rows.splice(this.rows.indexOf(hit), 1);
      return { data: null, error: null };
    }
    if (this.mode === "upsert") {
      const col = this.upsertConflictCol;
      const existing = col ? this.rows.find((r) => r[col] === this.payload![col]) : undefined;
      if (existing) Object.assign(existing, this.payload);
      else this.rows.push({ ...this.payload! });
      return { data: null, error: null };
    }
    return { data: this.matched(), error: null };
  }
  maybeSingle() {
    const res = this.exec();
    const data = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data;
    return Promise.resolve({ data, error: null });
  }
  then<T>(resolve: (v: { data: unknown; error: null }) => T) {
    return Promise.resolve(this.exec()).then(resolve);
  }
}

export function makeFakeDb(tables: Record<string, Row[]> = {}, rpcs: Record<string, RpcHandler> = {}) {
  const inserts: Array<{ table: string; row: Row }> = [];
  return {
    _tables: tables,
    _inserts: inserts,
    from(table: string) {
      if (!tables[table]) tables[table] = [];
      return new FakeQuery(tables[table]!, table, inserts);
    },
    async rpc(name: string, params: Record<string, unknown>) {
      const handler = rpcs[name];
      if (!handler) throw new Error(`unmocked rpc ${name}`);
      return handler(params);
    },
  };
}
