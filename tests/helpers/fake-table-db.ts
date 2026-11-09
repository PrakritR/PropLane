/**
 * A small in-memory stand-in for the service-role Supabase client: each table is an array of
 * rows, and the query builder understands the handful of verbs the work-board code uses
 * (select / eq / neq / is / in / gt / not / order / limit / maybeSingle / single / insert / update /
 * upsert / delete, plus `row_data->>key` filters). It is NOT a SQL engine - just enough that a
 * test can seed rows, run the real code, and read back what was written.
 */
export type Row = Record<string, unknown>;

export type FakeDb = {
  tables: Record<string, Row[]>;
  from(table: string): FakeBuilder;
  rpc(name: string, args: Row): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
};

type Filter = (row: Row) => boolean;

function readPath(row: Row, column: string): unknown {
  const arrow = column.split("->>");
  if (arrow.length === 2) {
    const container = row[arrow[0]!] as Row | null | undefined;
    const value = container?.[arrow[1]!];
    return value === undefined || value === null ? null : String(value);
  }
  return row[column];
}

type FakeBuilder = PromiseLike<{ data: unknown; error: unknown; count?: number | null }> & Record<string, unknown>;

export type FakeDbOptions = {
  /** Return an error to make a write fail the way the database would (a capacity trigger, a constraint). */
  failWrite?: (table: string, mode: "insert" | "update" | "upsert" | "delete", payload: Row | Row[] | null) => { code?: string; message?: string } | null;
  /** Answer a named RPC. Return `undefined` to fall through to the built-in stand-ins. */
  rpc?: (name: string, args: Row) => { data?: unknown; error?: { code?: string; message?: string } | null } | undefined;
};

/**
 * `reserve_household_charge_refund` in miniature: the budget check against the payment ledger,
 * the operation-key replay with a full-basis comparison, and the one-unresolved-attempt-per-source
 * refusal. Enough that a test can exercise the coordinator's real branching without a database.
 */
const UNRESOLVED_REFUND_STATES = ["reserved", "pending", "unknown"];
function reserveHouseholdChargeRefund(tables: Record<string, Row[]>, args: Row, nextId: () => string) {
  const attempts = (tables.household_charge_refund_attempts ??= []);
  const charge = (tables.portal_household_charge_records ?? []).find((row) =>
    row.id === args.p_charge && row.manager_user_id === args.p_owner);
  if (!charge) return { data: null, error: { message: "Refund source not found" } };
  const payment = (tables.ledger_entries ?? []).find((row) =>
    row.source_charge_id === args.p_charge && row.entry_type === "payment");
  if (!payment || payment.stripe_charge_id !== args.p_stripe_charge || payment.manager_user_id !== undefined && payment.manager_user_id !== args.p_owner) {
    return { data: null, error: { message: "Refund payment evidence requires review" } };
  }
  const replay = attempts.find((row) => row.operation_key === args.p_operation_key);
  if (replay) {
    const differs = replay.source_charge_id !== args.p_charge || replay.manager_user_id !== args.p_owner ||
      replay.stripe_charge_id !== args.p_stripe_charge || replay.rail !== args.p_rail ||
      replay.amount_cents !== args.p_amount ||
      JSON.stringify(replay.basis) !== JSON.stringify(args.p_basis);
    return differs
      ? { data: null, error: { message: "Operation key differs from reservation" } }
      : { data: { ...replay, created: false }, error: null };
  }
  const refunded = Number((charge.row_data as Row | undefined)?.refundedCents ?? 0);
  const unresolved = attempts.filter((row) =>
    row.source_charge_id === args.p_charge && UNRESOLVED_REFUND_STATES.includes(String(row.status)));
  const held = unresolved.reduce((sum, row) => sum + Number(row.amount_cents ?? 0), 0);
  if (refunded + held + Number(args.p_amount) > Number(payment.amount_cents)) {
    return { data: null, error: { message: "Refund exceeds the payment's available balance" } };
  }
  if (unresolved.length) return { data: null, error: { message: "Refund requires reconciliation" } };
  const row: Row = {
    id: nextId(), operation_key: args.p_operation_key, source_charge_id: args.p_charge,
    manager_user_id: args.p_owner, stripe_charge_id: args.p_stripe_charge,
    stripe_payment_intent_id: args.p_payment_intent ?? null, rail: args.p_rail,
    platform_attempt_key: null, amount_cents: args.p_amount,
    baseline_refunded_cents: refunded, paid_cents: payment.amount_cents, basis: args.p_basis,
    provider_refund_id: null, status: "reserved", projected_at: null,
  };
  attempts.push(row);
  return { data: { ...row, created: true }, error: null };
}

export function createFakeDb(seed: Record<string, Row[]> = {}, options: FakeDbOptions = {}): FakeDb {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));
  let counter = 0;

  function from(table: string): FakeBuilder {
    tables[table] ??= [];
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" | "delete" | "upsert" = "select";
    let payload: Row | Row[] | null = null;
    let upsertConflict: string[] = [];
    let upsertIgnoreDuplicates = false;
    let limitN: number | null = null;
    let rangeFrom = 0;
    let orderBy: { column: string; ascending: boolean } | null = null;
    let wantsCount = false;
    let head = false;

    const matches = (row: Row) => filters.every((f) => f(row));

    function execute(): { data: unknown; error: unknown; count?: number | null } {
      const rows = tables[table]!;
      if (mode !== "select") {
        const failure = options.failWrite?.(table, mode, payload);
        if (failure) return { data: null, error: failure };
      }
      if (mode === "insert") {
        const items = (Array.isArray(payload) ? payload : [payload]) as Row[];
        const created = items.map((item) => ({ id: `${table}-${++counter}`, created_at: new Date().toISOString(), ...item }));
        rows.push(...created);
        return { data: created, error: null };
      }
      if (mode === "upsert") {
        const item = payload as Row;
        const existing = rows.find((row) => upsertConflict.every((key) => row[key] === item[key]));
        if (existing) {
          // PostgREST's `resolution=ignore-duplicates`: the conflicting row is left alone and not returned.
          if (upsertIgnoreDuplicates) return { data: [], error: null };
          Object.assign(existing, item);
          return { data: [existing], error: null };
        }
        const created = { id: `${table}-${++counter}`, ...item };
        rows.push(created);
        return { data: [created], error: null };
      }
      if (mode === "update") {
        const hit = rows.filter(matches);
        for (const row of hit) Object.assign(row, payload);
        return { data: hit, error: null };
      }
      if (mode === "delete") {
        const hit = rows.filter(matches);
        tables[table] = rows.filter((row) => !matches(row));
        return { data: hit, error: null };
      }
      let out = rows.filter(matches);
      if (orderBy) {
        const { column, ascending } = orderBy;
        out = [...out].sort((a, b) => String(readPath(a, column) ?? "").localeCompare(String(readPath(b, column) ?? "")) * (ascending ? 1 : -1));
      }
      const total = out.length;
      if (rangeFrom > 0) out = out.slice(rangeFrom);
      if (limitN !== null) out = out.slice(0, limitN);
      return { data: head ? null : out, error: null, count: wantsCount ? total : null };
    }

    const builder: Record<string, unknown> = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        wantsCount = opts?.count === "exact";
        head = opts?.head === true;
        return builder;
      },
      // PostgREST's generic `.filter(column, "eq", value)` (what a `row_data->>key` match uses).
      filter: (column: string, op: string, value: unknown) => {
        if (op === "eq") filters.push((row) => readPath(row, column) === value);
        return builder;
      },
      eq: (column: string, value: unknown) => (filters.push((row) => readPath(row, column) === value), builder),
      neq: (column: string, value: unknown) => (filters.push((row) => readPath(row, column) !== value), builder),
      is: (column: string, value: unknown) => (filters.push((row) => (readPath(row, column) ?? null) === value), builder),
      in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(readPath(row, column))), builder),
      gt: (column: string, value: unknown) => (filters.push((row) => String(readPath(row, column) ?? "") > String(value)), builder),
      gte: (column: string, value: unknown) => (filters.push((row) => String(readPath(row, column) ?? "") >= String(value)), builder),
      like: (column: string, pattern: string) => {
        const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`);
        filters.push((row) => re.test(String(readPath(row, column) ?? "")));
        return builder;
      },
      lt: (column: string, value: unknown) => (filters.push((row) => readPath(row, column) != null && String(readPath(row, column)) < String(value)), builder),
      // PostgREST's array/jsonb containment (`charge_ids @> ["x"]`).
      contains: (column: string, values: unknown[]) => {
        filters.push((row) => {
          const stored = readPath(row, column);
          return Array.isArray(stored) && values.every((value) => stored.includes(value));
        });
        return builder;
      },
      not: (column: string, op: string, value: unknown) => {
        if (op === "is") filters.push((row) => (readPath(row, column) ?? null) !== value);
        return builder;
      },
      or: () => builder,
      order: (column: string, opts?: { ascending?: boolean }) => ((orderBy = { column, ascending: opts?.ascending !== false }), builder),
      limit: (n: number) => ((limitN = n), builder),
      range: (from: number, to: number) => ((rangeFrom = from), (limitN = to - from + 1), builder),
      insert: (row: Row | Row[]) => ((mode = "insert"), (payload = row), builder),
      update: (row: Row) => ((mode = "update"), (payload = row), builder),
      upsert: (row: Row, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) => (
        (mode = "upsert"),
        (payload = row),
        (upsertConflict = (opts?.onConflict ?? "id").split(",").map((s) => s.trim())),
        (upsertIgnoreDuplicates = opts?.ignoreDuplicates === true),
        builder
      ),
      delete: () => ((mode = "delete"), builder),
      maybeSingle: async () => {
        const result = execute();
        const list = (result.data as Row[] | null) ?? [];
        return { data: list[0] ?? null, error: result.error };
      },
      single: async () => {
        const result = execute();
        const list = (result.data as Row[] | null) ?? [];
        return { data: list[0] ?? null, error: list[0] ? null : { message: "no rows" } };
      },
      then: (resolve: (value: ReturnType<typeof execute>) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve().then(execute).then(resolve, reject),
    };
    return builder as unknown as FakeBuilder;
  }

  async function rpc(name: string, args: Row = {}) {
    const override = options.rpc?.(name, args);
    if (override) return { data: override.data ?? null, error: override.error ?? null };
    if (name === "ensure_default_portal_workspace") {
      if (typeof args.p_owner !== "string" || !args.p_owner) return { data: null, error: { message: "Workspace owner required" } };
      const workspaces = (tables.portal_workspaces ??= []);
      let workspace = workspaces.find((row) => row.owner_user_id === args.p_owner && row.is_default === true);
      if (!workspace) {
        workspace = { id: `workspace-${++counter}`, owner_user_id: args.p_owner, name: "My workspace", is_default: true, is_service: false, created_at: new Date().toISOString() };
        workspaces.push(workspace);
      }
      return { data: workspace.id, error: null };
    }
    if (name === "reserve_household_charge_refund") {
      return reserveHouseholdChargeRefund(tables, args, () => `hcra_${++counter}`);
    }
    if (name === "stamp_household_charge_refund_platform_key") {
      const row = (tables.household_charge_refund_attempts ?? []).find((item) => item.id === args.p_attempt);
      if (!row) return { data: null, error: { message: "Refund attempt not found" } };
      row.platform_attempt_key = args.p_key;
      return { data: { ...row }, error: null };
    }
    return { data: null, error: { message: `Unsupported fake RPC: ${name}` } };
  }

  return { tables, from, rpc };
}
