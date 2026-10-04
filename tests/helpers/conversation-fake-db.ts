import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A small multi-table in-memory Supabase fake for the conversation-key tests.
 * It implements just the query surface the resolver / thread helpers use
 * (select, eq, in, is, not, or, order, limit, maybeSingle, upsert, update,
 * rpc) and an atomic JS twin of `resolve_or_create_conversation` /
 * `adopt_conversation`, so "two creates -> one row" is tested against the RPC
 * CONTRACT (find-by-any-key-else-insert, serialized), not against app code.
 */
export type Row = Record<string, unknown>;

function cell(row: Row, column: string): unknown {
  if (column.includes("->>")) {
    const [base, key] = column.split("->>");
    const json = (row[base!] ?? {}) as Row;
    return json[key!];
  }
  return row[column];
}

function parseOr(filter: string): Array<(row: Row) => boolean> {
  // `col.eq."value"` , `col.is.null`
  const parts: string[] = [];
  const depth = 0;
  let current = "";
  let inQuote = false;
  for (const ch of filter) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === "," && !inQuote && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts.map((part) => {
    const match = /^([^.]+)\.(eq|is|ilike)\.(.*)$/.exec(part);
    if (!match) return () => false;
    const [, column, op, rawValue] = match;
    const value = rawValue!.startsWith('"') ? rawValue!.slice(1, -1).replace(/\\(["\\])/g, "$1") : rawValue!;
    if (op === "is") return (row: Row) => cell(row, column!) === null || cell(row, column!) === undefined;
    // `ilike` is a case-insensitive PATTERN, not an equality: PostgREST reads
    // `*` as `%`, and `%` / `_` are wildcards. Modelled here so a caller that
    // forgets to escape a value is caught by the fake rather than by production.
    if (op === "ilike") {
      const pattern = new RegExp(
        `^${value
          .replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? "%" : `\\${ch}`))
          .replace(/%/g, ".*")
          .replace(/_/g, ".")}$`,
        "i",
      );
      return (row: Row) => pattern.test(String(cell(row, column!) ?? ""));
    }
    return (row: Row) => String(cell(row, column!) ?? "") === value;
  });
}

export type FakeDb = SupabaseClient & {
  tables: Record<string, Row[]>;
  rpcCalls: { fn: string; args: Row }[];
  /** Make the next rpc of this name fail like a missing function. */
  failRpc: Set<string>;
  failUpsertColumns: { value: boolean };
};

export function createConversationFakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));
  const rpcCalls: { fn: string; args: Row }[] = [];
  const failRpc = new Set<string>();
  const failUpsertColumns = { value: false };

  const table = (name: string) => (tables[name] ??= []);

  function selectBuilder(name: string) {
    const predicates: Array<(row: Row) => boolean> = [];
    let orderBy: { column: string; ascending: boolean } | null = null;
    let max = Infinity;
    let offset = 0;
    const run = () => {
      let rows = table(name).filter((row) => predicates.every((p) => p(row)));
      if (orderBy) {
        const { column, ascending } = orderBy;
        rows = [...rows].sort((a, b) => {
          const left = String(cell(a, column) ?? "");
          const right = String(cell(b, column) ?? "");
          return ascending ? left.localeCompare(right) : right.localeCompare(left);
        });
      }
      return rows.slice(offset, offset + max).map((row) => ({ ...row }));
    };
    const builder: Record<string, unknown> = {
      eq(column: string, value: unknown) {
        predicates.push((row) => cell(row, column) === value);
        return builder;
      },
      in(column: string, values: unknown[]) {
        predicates.push((row) => values.includes(cell(row, column)));
        return builder;
      },
      is(column: string, value: unknown) {
        predicates.push((row) => (value === null ? cell(row, column) == null : cell(row, column) === value));
        return builder;
      },
      not(column: string, _op: string, value: unknown) {
        predicates.push((row) => (value === null ? cell(row, column) != null : cell(row, column) !== value));
        return builder;
      },
      or(filter: string) {
        const alts = parseOr(filter);
        predicates.push((row) => alts.some((p) => p(row)));
        return builder;
      },
      order(column: string, opts?: { ascending?: boolean }) {
        orderBy = { column, ascending: opts?.ascending !== false };
        return builder;
      },
      limit(n: number) {
        max = n;
        return builder;
      },
      range(from: number, to: number) {
        offset = from;
        max = to - from + 1;
        return builder;
      },
      maybeSingle() {
        const rows = run();
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then<T>(resolve: (value: { data: Row[]; error: null }) => T) {
        return Promise.resolve({ data: run(), error: null }).then(resolve);
      },
    };
    return builder;
  }

  const db = {
    tables,
    rpcCalls,
    failRpc,
    failUpsertColumns,
    from(name: string) {
      return {
        select: () => selectBuilder(name),
        upsert(payload: Row) {
          if (failUpsertColumns.value && ("conversation_key" in payload || "workspace_id" in payload)) {
            return Promise.resolve({
              error: { code: "PGRST204", message: "Could not find the 'conversation_key' column" },
            });
          }
          const rows = table(name);
          if (name === "portal_inbox_thread_records" && payload.conversation_key && payload.workspace_id && payload.owner_user_id) {
            const clash = rows.find(
              (row) =>
                row.id !== payload.id &&
                row.owner_user_id === payload.owner_user_id &&
                row.workspace_id === payload.workspace_id &&
                row.scope === (payload.scope ?? row.scope) &&
                row.conversation_key === payload.conversation_key,
            );
            if (clash) return Promise.resolve({ error: { code: "23505", message: "duplicate key value violates unique constraint" } });
          }
          const index = rows.findIndex((row) => row.id === payload.id);
          if (index >= 0) rows[index] = { ...rows[index], ...payload };
          else rows.push({ ...payload });
          return Promise.resolve({ error: null });
        },
      };
    },
    rpc(fn: string, args: Row) {
      rpcCalls.push({ fn, args });
      if (failRpc.has(fn)) {
        return Promise.resolve({
          data: null,
          error: { code: "PGRST202", message: `Could not find the function public.${fn}` },
        });
      }
      const threads = table("portal_inbox_thread_records");
      if (fn === "resolve_or_create_conversation") {
        const owner = (args.p_owner as string | null) ?? null;
        const keys = args.p_keys as string[];
        const email = String(args.p_participant_email ?? "").toLowerCase();
        const matches = threads
          .filter(
            (row) =>
              row.scope === args.p_scope &&
              row.workspace_id === args.p_workspace &&
              keys.includes(String(row.conversation_key)) &&
              (owner ? row.owner_user_id === owner : row.owner_user_id == null && String(row.participant_email ?? "").toLowerCase() === email),
          )
          .sort((a, b) => keys.indexOf(String(a.conversation_key)) - keys.indexOf(String(b.conversation_key)));
        if (matches[0]) {
          if (matches[0].conversation_key !== keys[0]) matches[0].conversation_key = keys[0];
          return Promise.resolve({ data: { id: matches[0].id, created: false }, error: null });
        }
        if (threads.some((row) => row.id === args.p_thread_id)) {
          return Promise.resolve({ data: null, error: { code: "23505", message: "Conversation id is already taken" } });
        }
        threads.push({
          id: args.p_thread_id,
          scope: args.p_scope,
          owner_user_id: owner,
          participant_email: args.p_participant_email ?? null,
          thread_type: args.p_thread_type,
          row_data: args.p_row_data,
          conversation_key: keys[0],
          workspace_id: args.p_workspace,
          updated_at: new Date().toISOString(),
        });
        return Promise.resolve({ data: { id: args.p_thread_id, created: true }, error: null });
      }
      if (fn === "adopt_conversation") {
        const row = threads.find((candidate) => candidate.id === args.p_thread_id);
        if (!row) return Promise.resolve({ data: { adopted: false, reason: "missing" }, error: null });
        const taken = threads.find(
          (other) =>
            other.id !== row.id &&
            other.scope === row.scope &&
            other.workspace_id === args.p_workspace &&
            other.conversation_key === args.p_key &&
            other.owner_user_id === row.owner_user_id,
        );
        if (taken) return Promise.resolve({ data: { adopted: false, reason: "key_taken", id: taken.id }, error: null });
        row.conversation_key = args.p_key;
        row.workspace_id = args.p_workspace;
        return Promise.resolve({ data: { adopted: true, id: row.id }, error: null });
      }
      if (fn === "stamp_sms_projection_conversation") {
        const row = table("sms_projection_conversations").find((candidate) => candidate.id === args.p_conversation_id);
        if (!row) return Promise.resolve({ data: false, error: null });
        const changed = row.conversation_key !== args.p_key || row.workspace_id !== args.p_workspace;
        row.conversation_key = args.p_key;
        row.workspace_id = args.p_workspace;
        return Promise.resolve({ data: changed, error: null });
      }
      return Promise.resolve({ data: null, error: { code: "42883", message: "unknown function" } });
    },
  };
  return db as unknown as FakeDb;
}
