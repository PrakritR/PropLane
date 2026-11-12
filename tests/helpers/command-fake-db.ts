/**
 * A small in-memory Supabase stand-in for the manager text-command tests: select / insert / upsert / update / delete with
 * eq, neq, gt, gte, lt, lte, in, is, order, limit, maybeSingle, plus a storage bucket map. Unique keys are declared per
 * table so a duplicate insert answers 23505 like Postgres does.
 */
export type Row = Record<string, unknown>;

export type FakeDbOptions = {
  unique?: Record<string, string[]>;
  /** Tables whose reads should fail, to prove a fail-closed path. */
  failReads?: string[];
};

export function makeCommandDb(seed: Record<string, Row[]> = {}, options: FakeDbOptions = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));
  const buckets = new Map<string, Map<string, { bytes: Buffer; contentType: string }>>();
  let seq = 1;

  const rowsOf = (table: string) => (tables[table] ??= []);
  const cmp = (a: unknown, b: unknown) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

  function builder(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let mode: "select" | "insert" | "update" | "delete" | "upsert" = "select";
    let payload: Row | Row[] = {};
    let orderBy: { col: string; asc: boolean } | null = null;
    let max = Infinity;
    let onConflict: string[] = [];

    const matched = () => rowsOf(table).filter((row) => filters.every((fn) => fn(row)));

    function execute(): { data: Row[] | null; error: { code?: string; message: string } | null } {
      if (mode === "select" && options.failReads?.includes(table)) return { data: null, error: { message: "read failed" } };
      if (mode === "insert" || mode === "upsert") {
        const inputs = Array.isArray(payload) ? payload : [payload];
        const out: Row[] = [];
        for (const input of inputs) {
          const keys = mode === "upsert" ? onConflict : [];
          const existing = keys.length ? rowsOf(table).find((row) => keys.every((k) => row[k] === input[k])) : undefined;
          if (existing) {
            Object.assign(existing, input);
            out.push({ ...existing });
            continue;
          }
          const unique = options.unique?.[table];
          if (unique && rowsOf(table).some((row) => unique.every((k) => row[k] === input[k]))) {
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
          const row: Row = { id: `${table}-${seq++}`, created_at: new Date().toISOString(), ...input };
          rowsOf(table).push(row);
          out.push({ ...row });
        }
        return { data: out, error: null };
      }
      const hits = matched();
      if (mode === "update") {
        for (const hit of hits) Object.assign(hit, payload);
        return { data: hits.map((h) => ({ ...h })), error: null };
      }
      if (mode === "delete") {
        for (const hit of hits) rowsOf(table).splice(rowsOf(table).indexOf(hit), 1);
        return { data: hits.map((h) => ({ ...h })), error: null };
      }
      let out = hits.map((h) => ({ ...h }));
      if (orderBy) out = out.sort((a, b) => (orderBy!.asc ? 1 : -1) * cmp(a[orderBy!.col], b[orderBy!.col]));
      return { data: out.slice(0, max), error: null };
    }

    const api: Record<string, unknown> = {
      select: () => api,
      insert: (vals: Row | Row[]) => ((mode = "insert"), (payload = vals), api),
      upsert: (vals: Row | Row[], opts?: { onConflict?: string }) => (
        (mode = "upsert"), (payload = vals), (onConflict = (opts?.onConflict ?? "id").split(",").map((s) => s.trim())), api
      ),
      update: (vals: Row) => ((mode = "update"), (payload = vals), api),
      delete: () => ((mode = "delete"), api),
      eq: (col: string, val: unknown) => (filters.push((r) => r[col] === val), api),
      neq: (col: string, val: unknown) => (filters.push((r) => r[col] !== val), api),
      gt: (col: string, val: unknown) => (filters.push((r) => cmp(r[col], val) > 0), api),
      gte: (col: string, val: unknown) => (filters.push((r) => cmp(r[col], val) >= 0), api),
      lt: (col: string, val: unknown) => (filters.push((r) => cmp(r[col], val) < 0), api),
      lte: (col: string, val: unknown) => (filters.push((r) => cmp(r[col], val) <= 0), api),
      in: (col: string, vals: unknown[]) => (filters.push((r) => vals.includes(r[col])), api),
      is: (col: string, val: unknown) => (filters.push((r) => (r[col] ?? null) === val), api),
      order: (col: string, opts?: { ascending?: boolean }) => ((orderBy = { col, asc: opts?.ascending !== false }), api),
      limit: (n: number) => ((max = n), api),
      maybeSingle: () => {
        const result = execute();
        return Promise.resolve({ data: result.data?.[0] ?? null, error: result.error });
      },
      single: () => {
        const result = execute();
        return Promise.resolve({ data: result.data?.[0] ?? null, error: result.error });
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(execute()).then(resolve, reject),
    };
    return api;
  }

  const storage = {
    from(bucket: string) {
      const files = buckets.get(bucket) ?? new Map();
      buckets.set(bucket, files);
      return {
        upload: async (path: string, bytes: Buffer, opts?: { contentType?: string }) => {
          files.set(path, { bytes: Buffer.from(bytes), contentType: opts?.contentType ?? "application/octet-stream" });
          return { data: { path }, error: null };
        },
        download: async (path: string) => {
          const file = files.get(path);
          if (!file) return { data: null, error: { message: "not found" } };
          const blob = new Blob([new Uint8Array(file.bytes)], { type: file.contentType });
          return { data: blob, error: null };
        },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://example.test/storage/v1/object/public/${bucket}/${path}` } }),
      };
    },
  };

  return {
    from: (table: string) => builder(table),
    storage,
    rpc: async () => ({ data: null, error: null }),
    tables,
    bucket: (name: string) => buckets.get(name) ?? new Map(),
  };
}
