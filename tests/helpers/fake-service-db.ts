/**
 * A tiny in-memory stand-in for the Supabase service-role client, enough for route tests that
 * must prove WHICH rows a handler can reach: select / insert / update / delete chained with
 * eq / in / is / order, ending in maybeSingle / single / await. Storage records its calls.
 */
export type FakeRow = Record<string, unknown>;

export type FakeStorageCall = { op: "upload" | "remove" | "sign"; bucket: string; path: string; ttl?: number };

export function makeFakeServiceDb(rows: FakeRow[], storage: FakeStorageCall[] = []) {
  let nextId = 1;

  function builder(table: string) {
    const filters: Array<(row: FakeRow) => boolean> = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: FakeRow = {};

    const matched = () => rows.filter((row) => row.__table === table && filters.every((fn) => fn(row)));
    const strip = (row: FakeRow) => {
      const { __table: _table, ...rest } = row;
      void _table;
      return rest;
    };

    function run(): { data: FakeRow[]; error: null } {
      if (mode === "insert") {
        const row: FakeRow = {
          __table: table,
          id: `${table}-${nextId++}`,
          created_at: "2026-10-07T00:00:00.000Z",
          receipt_path: null,
          ...payload,
        };
        rows.push(row);
        return { data: [strip(row)], error: null };
      }
      const hits = matched();
      if (mode === "update") for (const hit of hits) Object.assign(hit, payload);
      if (mode === "delete") for (const hit of hits) rows.splice(rows.indexOf(hit), 1);
      return { data: hits.map(strip), error: null };
    }

    const api = {
      select() {
        return api;
      },
      insert(vals: FakeRow) {
        mode = "insert";
        payload = vals;
        return api;
      },
      update(vals: FakeRow) {
        mode = "update";
        payload = vals;
        return api;
      },
      delete() {
        mode = "delete";
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push((row) => row[col] === val);
        return api;
      },
      in(col: string, vals: unknown[]) {
        filters.push((row) => vals.includes(row[col]));
        return api;
      },
      is(col: string, val: unknown) {
        filters.push((row) => (row[col] ?? null) === val);
        return api;
      },
      order() {
        return api;
      },
      maybeSingle() {
        const result = run();
        return Promise.resolve({ data: result.data[0] ?? null, error: null });
      },
      single() {
        const result = run();
        return Promise.resolve({ data: result.data[0] ?? null, error: result.data[0] ? null : { message: "no row" } });
      },
      then(resolve: (value: { data: FakeRow[]; error: null }) => unknown) {
        return Promise.resolve(run()).then(resolve);
      },
    };
    return api;
  }

  return {
    from: builder,
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => {
          storage.push({ op: "upload", bucket, path });
          return { error: null };
        },
        remove: async (paths: string[]) => {
          for (const path of paths) storage.push({ op: "remove", bucket, path });
          return { error: null };
        },
        createSignedUrl: async (path: string, ttl: number) => {
          storage.push({ op: "sign", bucket, path, ttl });
          return { data: { signedUrl: `https://storage.example/${path}?sig=1` }, error: null };
        },
      }),
    },
  };
}
