import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import { parseOrFilterClauses } from "@/lib/supabase/or-filter";

/**
 * Fake supabase surface for RESIDENT tool tests. Extends the FakeQuery idea
 * from fake-agent-ctx.ts (deliberately not edited — manager tests own it) with:
 *
 *  - `.or("resident_user_id.eq.X,resident_email.eq.Y")` parsing, so a loader
 *    that forgets its resident scope actually returns foreign rows and fails
 *    the isolation tests;
 *  - JSON-path filters (`row_data->>senderUserId`) used by the scheduled-
 *    message storage helpers;
 *  - mutation recording (insert/upsert/update) including audit_log dedupe-key
 *    uniqueness (a duplicate insert returns Postgres code 23505), so tests can
 *    assert exactly which audit rows an executor wrote.
 *
 * `.eq` on a column the seeded row does not carry does NOT match (fail closed):
 * a mis-scoped filter can never accidentally pass.
 */
export type FakeRow = Record<string, unknown>;

export type FakeMutation = {
  table: string;
  kind: "insert" | "upsert" | "update" | "delete";
  values: FakeRow;
};

type Predicate = (row: FakeRow) => boolean;

function resolveColumn(row: FakeRow, col: string): unknown {
  const jsonPath = col.split("->>");
  if (jsonPath.length === 2) {
    const nested = row[jsonPath[0]!.trim()];
    if (!nested || typeof nested !== "object") return undefined;
    return (nested as Record<string, unknown>)[jsonPath[1]!.trim()];
  }
  return row[col];
}

function eqPredicate(col: string, val: unknown): Predicate {
  return (row) => {
    const resolved = resolveColumn(row, col);
    if (resolved === undefined || resolved === null) return false;
    return String(resolved) === String(val);
  };
}

/**
 * Parse a PostgREST `.or()` expression of `col.eq.value` clauses.
 *
 * Uses the SAME parser the filter builder is paired with
 * (`@/lib/supabase/or-filter`). Splitting on "," here modelled a PostgREST that
 * does not exist — one where a comma inside a value ends a clause — which is
 * exactly the class of bug the quoted builder exists to prevent.
 */
function orPredicate(expr: string): Predicate {
  const clauses = parseOrFilterClauses(expr).map(({ column, operator, value }) =>
    operator === "eq" ? eqPredicate(column, value) : () => false,
  );
  if (clauses.length === 0) return () => false;
  return (row) => clauses.some((match) => match(row));
}

class FakeResidentQuery {
  private predicates: Predicate[] = [];
  private ordering: { col: string; ascending: boolean } | null = null;
  private pending:
    | { kind: "insert"; values: FakeRow[] }
    | { kind: "upsert"; values: FakeRow[] }
    | { kind: "update"; values: FakeRow }
    | { kind: "delete" }
    | null = null;

  constructor(
    private table: string,
    private rows: FakeRow[],
    private mutations: FakeMutation[],
  ) {}

  select() {
    return this;
  }
  limit() {
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.ordering = { col, ascending: opts?.ascending !== false };
    return this;
  }
  eq(col: string, val: unknown) {
    this.predicates.push(eqPredicate(col, val));
    return this;
  }
  neq(col: string, val: unknown) {
    const match = eqPredicate(col, val);
    this.predicates.push((row) => !match(row));
    return this;
  }
  gte(col: string, val: unknown) {
    this.predicates.push((row) => {
      const resolved = resolveColumn(row, col);
      return resolved === undefined || String(resolved) >= String(val);
    });
    return this;
  }
  lte(col: string, val: unknown) {
    this.predicates.push((row) => {
      const resolved = resolveColumn(row, col);
      return resolved === undefined || String(resolved) <= String(val);
    });
    return this;
  }
  in(col: string, vals: unknown[]) {
    const set = new Set((vals ?? []).map((v) => String(v)));
    this.predicates.push((row) => {
      const resolved = resolveColumn(row, col);
      if (resolved === undefined || resolved === null) return false;
      return set.has(String(resolved));
    });
    return this;
  }
  or(expr: string) {
    this.predicates.push(orPredicate(expr));
    return this;
  }

  insert(values: FakeRow | FakeRow[]) {
    this.pending = { kind: "insert", values: Array.isArray(values) ? values : [values] };
    return this;
  }
  upsert(values: FakeRow | FakeRow[]) {
    this.pending = { kind: "upsert", values: Array.isArray(values) ? values : [values] };
    return this;
  }
  update(values: FakeRow) {
    this.pending = { kind: "update", values };
    return this;
  }
  delete() {
    this.pending = { kind: "delete" };
    return this;
  }

  private apply(): FakeRow[] {
    const matched = this.rows.filter((row) => this.predicates.every((match) => match(row)));
    if (this.ordering) {
      const { col, ascending } = this.ordering;
      matched.sort((a, b) => {
        const cmp = String(resolveColumn(a, col) ?? "").localeCompare(String(resolveColumn(b, col) ?? ""));
        return ascending ? cmp : -cmp;
      });
    }
    return matched;
  }

  private run(): { data: FakeRow[] | null; error: { code?: string; message: string } | null } {
    if (!this.pending) return { data: this.apply(), error: null };

    if (this.pending.kind === "insert" || this.pending.kind === "upsert") {
      for (const values of this.pending.values) {
        // audit_log dedupe: a second insert with the same non-null dedupe_key
        // violates the unique index, exactly like production.
        if (this.pending.kind === "insert" && this.table === "audit_log" && values.dedupe_key != null) {
          const clash = this.rows.some((row) => row.dedupe_key != null && row.dedupe_key === values.dedupe_key);
          if (clash) return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
        const existingIdx =
          values.id != null ? this.rows.findIndex((row) => String(row.id) === String(values.id)) : -1;
        if (this.pending.kind === "upsert" && existingIdx >= 0) {
          this.rows[existingIdx] = { ...this.rows[existingIdx], ...values };
        } else {
          this.rows.push({ ...values });
        }
        this.mutations.push({ table: this.table, kind: this.pending.kind, values: { ...values } });
      }
      return { data: null, error: null };
    }

    if (this.pending.kind === "update") {
      const patch = this.pending.values;
      for (const row of this.apply()) Object.assign(row, patch);
      this.mutations.push({ table: this.table, kind: "update", values: { ...patch } });
      return { data: null, error: null };
    }

    const remaining = this.rows.filter((row) => !this.predicates.every((match) => match(row)));
    this.rows.length = 0;
    this.rows.push(...remaining);
    this.mutations.push({ table: this.table, kind: "delete", values: {} });
    return { data: null, error: null };
  }

  maybeSingle() {
    const rows = this.apply();
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }

  range(from: number, to: number) {
    return Promise.resolve({ data: this.apply().slice(from, to + 1), error: null });
  }

  // Thenable: `await query` resolves selects and pending mutations alike.
  then<T>(resolve: (v: { data: FakeRow[] | null; error: { code?: string; message: string } | null }) => T) {
    return Promise.resolve(this.run()).then(resolve);
  }
}

export type FakeResidentSetup = {
  ctx: ResidentAgentContext;
  mutations: FakeMutation[];
  tables: Record<string, FakeRow[]>;
};

/**
 * Build a ResidentAgentContext whose service-role db serves the given per-table
 * rows. Defaults to resident A ("resident_a" / resa@axis.test) linked to
 * "manager_1", approved phase, paid manager tier.
 */
export function makeResidentToolCtx(
  tables: Record<string, FakeRow[]>,
  overrides: Partial<ResidentAgentContext> = {},
): FakeResidentSetup {
  const mutations: FakeMutation[] = [];
  const db = {
    async rpc(name: string, args: FakeRow) {
      if (name !== "commit_room_lease_extension") throw new Error(`Unexpected RPC ${name}`);
      const lease = tables.portal_lease_pipeline_records?.find(r => r.id === args.p_lease_id && r.manager_user_id === args.p_owner);
      const application = tables.manager_application_records?.find(r => r.id === args.p_application_id && r.manager_user_id === args.p_owner);
      if (!lease || !application) return { error: { code: "40001" } };
      lease.row_data = args.p_next_lease;
      mutations.push({ table: "portal_lease_pipeline_records", kind: "update", values: { row_data: args.p_next_lease } });
      return { error: null };
    },
    from(table: string) {
      return new FakeResidentQuery(table, (tables[table] ??= []), mutations);
    },
  };
  const ctx = {
    kind: "resident",
    userId: "resident_a",
    email: "resa@axis.test",
    managerIds: ["manager_1"],
    phase: "approved",
    managerTier: "paid",
    landlordId: "resident_a",
    db,
    ...overrides,
  } as unknown as ResidentAgentContext;
  return { ctx, mutations, tables };
}
