import type { AgentContext } from "@/lib/tools/context";
import { buildRegistry, previewWriteTool, type ActionPreview } from "@/lib/tools/registry";

/**
 * A record as stored in a `portal_*` / `manager_*` table: the scope columns the
 * tool loaders filter on, plus the `row_data` JSON payload the UI persists.
 */
export type FakeRecord = {
  id?: string;
  manager_user_id?: string | null;
  scope?: string | null;
  owner_user_id?: string | null;
  resident_email?: string | null;
  property_id?: string | null;
  updated_at?: string | null;
  row_data: unknown;
};

/**
 * Minimal chainable stand-in for a supabase-js query builder. It records `.eq`
 * filters and applies them against the seeded rows, so a tool that forgets its
 * landlord scope would actually return another landlord's rows and fail the
 * test. The builder is awaitable (for `await query`) and exposes `.range` for
 * the paginated loader — mirroring how the real client is consumed.
 */
class FakeQuery {
  private filters: [string, unknown][] = [];
  private orGroups: ((r: FakeRecord) => boolean)[] = [];
  constructor(private rows: FakeRecord[]) {}

  select() {
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push([col, val]);
    return this;
  }
  is(col: string, val: unknown) {
    return this.eq(col, val);
  }
  in(col: string, vals: unknown[]) {
    this.filters.push([`in:${col}`, vals]);
    return this;
  }
  neq(col: string, val: unknown) {
    this.filters.push([`!${col}`, val]);
    return this;
  }
  gte(col: string, val: unknown) {
    this.filters.push([`>=${col}`, val]);
    return this;
  }
  lte(col: string, val: unknown) {
    this.filters.push([`<=${col}`, val]);
    return this;
  }
  /** Just enough of PostgREST's `.or("a.in.(x,y),a.is.null")` grammar for the shapes these tools issue. */
  or(expr: string) {
    const matchers = expr.split(",").map((clause) => {
      const c = clause.trim();
      const inMatch = c.match(/^(\w+)\.in\.\(([^)]*)\)$/);
      if (inMatch) {
        const [, col, list] = inMatch;
        const vals = list!.split(",").map((v) => v.trim()).filter(Boolean);
        return (r: FakeRecord) => vals.includes(String((r as Record<string, unknown>)[col!]));
      }
      const isNullMatch = c.match(/^(\w+)\.is\.null$/);
      if (isNullMatch) {
        const [, col] = isNullMatch;
        return (r: FakeRecord) => (r as Record<string, unknown>)[col!] == null;
      }
      const eqMatch = c.match(/^(\w+)\.eq\.(.+)$/);
      if (eqMatch) {
        const [, col, val] = eqMatch;
        return (r: FakeRecord) => String((r as Record<string, unknown>)[col!]) === val;
      }
      throw new Error(`FakeQuery.or: unhandled clause "${c}"`);
    });
    this.orGroups.push((r) => matchers.some((m) => m(r)));
    return this;
  }

  private apply(): FakeRecord[] {
    return this.rows.filter((r) => {
      if (!this.orGroups.every((group) => group(r))) return false;
      return this.filters.every(([col, val]) => {
        const rec = r as Record<string, unknown>;
        if (col.startsWith("!")) return rec[col.slice(1)] !== val;
        if (col.startsWith(">=")) {
          const c = col.slice(2);
          return !(c in r) || String(rec[c] ?? "") >= String(val ?? "");
        }
        if (col.startsWith("<=")) {
          const c = col.slice(2);
          return !(c in r) || String(rec[c] ?? "") <= String(val ?? "");
        }
        if (col.startsWith("in:")) {
          const c = col.slice(3);
          const allowed = new Set((val as unknown[]).map((v) => String(v)));
          return allowed.has(String(rec[c] ?? ""));
        }
        // Unknown projected columns (e.g. JSON path filters) are not modeled.
        if (!(col in r)) return true;
        return rec[col] === val;
      });
    });
  }

  range(from: number, to: number) {
    return Promise.resolve({ data: this.apply().slice(from, to + 1), error: null });
  }

  maybeSingle() {
    return Promise.resolve({ data: this.apply()[0] ?? null, error: null });
  }

  single() {
    return Promise.resolve({ data: this.apply()[0] ?? null, error: null });
  }

  // Thenable: `await query` resolves to the filtered rows.
  then<T>(resolve: (v: { data: FakeRecord[]; error: null }) => T) {
    return Promise.resolve({ data: this.apply(), error: null }).then(resolve);
  }
}

/**
 * Build an AgentContext whose service-role db serves the given per-table rows.
 * Tables not seeded return an empty set. landlordId/userId default to
 * "manager_a" so tests can seed rows for that scope and a foreign scope.
 */
export function makeManagerRowsCtx(
  tables: Record<string, FakeRecord[]>,
  overrides: Partial<AgentContext> = {},
): AgentContext {
  const db = {
    from(table: string) {
      return new FakeQuery(tables[table] ?? []);
    },
  };
  return {
    landlordId: "manager_a",
    userId: "manager_a",
    email: "manager@axis.test",
    roles: ["manager"],
    isAdmin: false,
    db,
    ...overrides,
  } as unknown as AgentContext;
}

/** Wrap a row_data payload with its scope columns for a manager-scoped table. */
export function managerRow(managerUserId: string, rowData: unknown, id?: string): FakeRecord {
  return {
    id: id ?? (rowData as { id?: string })?.id ?? `row_${Math.random().toString(36).slice(2)}`,
    manager_user_id: managerUserId,
    row_data: rowData,
  };
}

type Row = Record<string, unknown>;

/**
 * Read/write fake for the gated write tools: supports the read chains the
 * loaders use plus insert (with audit_log dedupe_key UNIQUE semantics),
 * upsert (by id), and update(...).eq/gt(...).select(). Tables are plain
 * arrays exposed on `store` so tests can assert exactly what was written.
 */
class FakeWriteQuery {
  private filters: ((r: Row) => boolean)[] = [];
  private mode: "select" | "insert" | "update" | "upsert" = "select";
  private pendingInsert: Row | null = null;
  private pendingUpdate: Row | null = null;
  private wantSingle = false;

  constructor(
    private store: Record<string, Row[]>,
    private table: string,
  ) {
    if (!store[table]) store[table] = [];
  }

  private rows(): Row[] {
    return this.store[this.table]!;
  }

  select() {
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push((r) => r[col] === val);
    return this;
  }
  is(col: string, val: unknown) {
    return this.eq(col, val);
  }
  in(col: string, vals: unknown[]) {
    const set = new Set(vals.map((v) => String(v)));
    this.filters.push((r) => set.has(String(r[col] ?? "")));
    return this;
  }
  gt(col: string, val: unknown) {
    this.filters.push((r) => String(r[col] ?? "") > String(val ?? ""));
    return this;
  }
  gte(col: string, val: unknown) {
    this.filters.push((r) => r[col] != null && String(r[col]) >= String(val ?? ""));
    return this;
  }
  single() {
    this.wantSingle = true;
    return this;
  }
  maybeSingle() {
    this.wantSingle = true;
    return this;
  }
  range(from: number, to: number) {
    const matched = this.rows().filter((r) => this.filters.every((f) => f(r)));
    return Promise.resolve({ data: matched.slice(from, to + 1), error: null });
  }

  insert(row: Row) {
    this.mode = "insert";
    // Model the partial UNIQUE index on audit_log.dedupe_key (NULLs never collide).
    if (
      this.table === "audit_log" &&
      row.dedupe_key != null &&
      this.rows().some((r) => r.dedupe_key === row.dedupe_key)
    ) {
      this.pendingInsert = null;
      return this;
    }
    if (
      this.table === "agent_messages" &&
      row.source_message_sid != null &&
      this.rows().some((r) => r.source_message_sid === row.source_message_sid && r.role === row.role)
    ) {
      this.pendingInsert = null;
      return this;
    }
    // Column defaults from the agent_pending_actions migration, so the claim
    // path (status/expiry filters) behaves like the real table.
    const defaults =
      this.table === "agent_pending_actions"
        ? { status: "proposed", expires_at: new Date(Date.now() + 15 * 60_000).toISOString() }
        : {};
    const withId = {
      id: `id_${this.rows().length}_${Math.random().toString(36).slice(2, 8)}`,
      created_at: new Date().toISOString(),
      ...defaults,
      ...row,
    };
    this.rows().push(withId);
    this.pendingInsert = withId;
    return this;
  }

  upsert(row: Row) {
    this.mode = "upsert";
    const idx = this.rows().findIndex((r) => r.id === row.id);
    if (idx >= 0) this.rows()[idx] = { ...this.rows()[idx], ...row };
    else this.rows().push({ ...row });
    return this;
  }

  update(vals: Row) {
    this.mode = "update";
    this.pendingUpdate = vals;
    return this;
  }

  private resolve(): { data: unknown; error: { code: string; message: string } | null } {
    if (this.mode === "insert") {
      if (!this.pendingInsert) {
        return { data: null, error: { code: "23505", message: "duplicate key value" } };
      }
      return { data: this.wantSingle ? this.pendingInsert : [this.pendingInsert], error: null };
    }
    if (this.mode === "upsert") return { data: null, error: null };
    const matched = this.rows().filter((r) => this.filters.every((f) => f(r)));
    if (this.mode === "update") {
      for (const r of matched) Object.assign(r, this.pendingUpdate);
      return { data: matched, error: null };
    }
    return { data: this.wantSingle ? (matched[0] ?? null) : matched, error: null };
  }

  then<T>(onFulfilled: (v: { data: unknown; error: { code: string; message: string } | null }) => T) {
    return Promise.resolve(this.resolve()).then(onFulfilled);
  }
}

/**
 * Build an AgentContext over a writable in-memory store. Seeded tables are
 * deep-referenced (not copied): mutate/inspect them directly in assertions.
 */
export function makeWritableCtx(
  tables: Record<string, Row[]> = {},
  overrides: Partial<AgentContext> = {},
): { ctx: AgentContext; store: Record<string, Row[]> } {
  const store: Record<string, Row[]> = tables;
  const db = {
    from(table: string) {
      return new FakeWriteQuery(store, table);
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name !== "find_or_create_manager_sms_portal_session") {
        return { data: null, error: { message: `unsupported rpc: ${name}` } };
      }
      const sessions = (store.agent_sessions ??= []);
      const existing = sessions
        .filter((row) => row.kind === "portal_chat" && row.portal === "manager"
          && row.user_id === args.p_actor_user_id && row.landlord_id === args.p_actor_user_id
          && (row.workspace_id ?? null) === (args.p_workspace_id ?? null))
        .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))[0];
      if (existing?.id) return { data: existing.id, error: null };
      const id = `session_${sessions.length}`;
      sessions.push({
        id,
        landlord_id: args.p_actor_user_id,
        user_id: args.p_actor_user_id,
        workspace_id: args.p_workspace_id ?? null,
        portal: "manager",
        kind: "portal_chat",
        title: "PropLane Assistant",
        status: "active",
        updated_at: new Date().toISOString(),
      });
      return { data: id, error: null };
    },
  };
  const ctx = {
    landlordId: "manager_a",
    userId: "manager_a",
    email: "manager@axis.test",
    roles: ["manager"],
    isAdmin: false,
    db,
    ...overrides,
  } as unknown as AgentContext;
  return { ctx, store };
}

/**
 * Test adapters for the one framework's write contract. `previewWrite` drives
 * the REAL `previewWriteTool` gate (Zod validation, the throw→error mapping,
 * and the `confirmedInput` pin), so a test sees exactly what the model loop
 * would; `executeWrite` wraps the gated handler back into a result object so a
 * failure message can be asserted without try/catch.
 */
export async function previewWrite<Ctx>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: any,
  ctx: Ctx,
  input: unknown,
): Promise<{ ok: true; input: unknown; preview: ActionPreview; destructive: boolean } | { ok: false; error: string }> {
  const registry = buildRegistry<Ctx>([tool]);
  return previewWriteTool(registry, ctx, tool.name, input);
}

/** Run a write tool's gated handler, mapping a throw back to `{ ok: false }`. */
export async function executeWrite<Ctx>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: any,
  ctx: Ctx,
  input: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  try {
    return { ok: true, ...((await tool.handler(ctx, input)) as Record<string, unknown>) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
