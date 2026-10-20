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
    /**
     * `phone_otp_start` as supabase/migrations/20261020160000 defines it: under a per-phone lock, the purpose's
     * hourly allowance, the phone's ceiling across every purpose, the 24-hour failed-code cap - all three taken
     * from the caller's arguments - then retire this phone + purpose + subject's live codes and insert the new
     * one. A missing table answers like the database; a missing or nonsensical cap refuses.
     */
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      if (fn !== "phone_otp_start") return { data: null, error: { code: "PGRST202", message: `no function ${fn}` } };
      if (broken.has("phone_otp_challenges")) return { data: null, error: { code: "42P01", message: "relation does not exist" } };
      const list = (rows.phone_otp_challenges ??= []);
      const phoneKey = String(args.p_phone_key ?? "");
      const purpose = String(args.p_purpose ?? "");
      const subject = (args.p_subject ?? null) as string | null;
      const now = args.p_now ? Date.parse(String(args.p_now)) : Date.now();
      const since = (ms: number) => (row: Row) => Date.parse(String(row.created_at ?? 0)) > now - ms;
      const cap = (value: unknown) => (Number.isInteger(Number(value)) && Number(value) >= 1 ? Number(value) : null);
      const perPurpose = cap(args.p_max_per_purpose);
      const perPhone = cap(args.p_max_per_phone);
      const maxFailed = cap(args.p_max_failed);
      if (perPurpose === null || perPhone === null || maxFailed === null) return { data: false, error: null };
      const hour = list.filter((r) => r.phone_key === phoneKey).filter(since(60 * 60 * 1000));
      if (hour.filter((r) => r.purpose === purpose).length >= perPurpose) return { data: false, error: null };
      if (hour.length >= perPhone) return { data: false, error: null };
      const failures = list
        .filter((r) => r.phone_key === phoneKey && r.purpose === purpose)
        .filter(since(24 * 60 * 60 * 1000))
        .reduce((sum, r) => sum + Math.max((Number(r.attempts) || 0) - (r.verified_at ? 1 : 0), 0), 0);
      if (failures >= maxFailed) return { data: false, error: null };
      for (const row of list) {
        if (row.phone_key === phoneKey && row.purpose === purpose && (row.subject_id ?? null) === subject && !row.consumed_at) {
          row.consumed_at = new Date(now).toISOString();
        }
      }
      list.push({
        id: args.p_id, phone_key: phoneKey, purpose, subject_id: subject, code_hash: args.p_code_hash,
        attempts: 0, created_at: new Date(now).toISOString(),
        expires_at: new Date(now + Number(args.p_ttl_minutes ?? 10) * 60_000).toISOString(),
      });
      return { data: true, error: null };
    },
    from(table: string) {
      let op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
      let conflict: string[] = [];
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
        if (op === "upsert") {
          for (const row of inserted) {
            const existing = conflict.length ? list.find((r) => conflict.every((c) => r[c] === row[c])) : undefined;
            if (existing) Object.assign(existing, row);
            else list.push({ id: randomUUID(), created_at: new Date().toISOString(), ...row });
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
          if (op === "insert" || op === "update" || op === "delete" || op === "upsert") wantsReturn = true;
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
        upsert(value: Row | Row[], options?: { onConflict?: string }) {
          op = "upsert";
          inserted = Array.isArray(value) ? value : [value];
          conflict = (options?.onConflict ?? "").split(",").map((c) => c.trim()).filter(Boolean);
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
        lte: (column: string, value: unknown) => where(column, (v) => String(v ?? "") <= String(value)),
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
