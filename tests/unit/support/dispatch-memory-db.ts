import { createMemoryDb, type MemoryDb } from "./memory-supabase";

type Row = Record<string, unknown>;

/**
 * The in-memory client plus the one RPC the dispatch engine calls
 * (`next_vendor_dispatch_handle`, the per-owner run counter), behaving like its SQL.
 */
export function createDispatchDb(seed: Record<string, Row[]> = {}): MemoryDb {
  const base = createMemoryDb(seed);
  const counters = new Map<string, number>();
  return {
    ...base,
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { id } }, error: null }) } },
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      if (fn === "resolve_resident_dispatch_confirmation") {
        const run = base.__tables.vendor_dispatch_runs?.find((row) => row.id === args.p_run && row.owner_user_id === args.p_owner && row.source_type === "work_order" && row.status === "accepted" && row.completion_state === "awaiting_resident");
        const job = base.__tables.portal_work_order_records?.find((row) => row.id === run?.source_id && row.manager_user_id === args.p_owner && row.resident_user_id === args.p_resident);
        if (!run || !job) return { data: { applied: false }, error: null };
        run.status = args.p_verdict === "fixed" ? "completed" : "accepted";
        run.completion_state = args.p_verdict === "fixed" ? "confirmed" : "reopened";
        if (args.p_verdict === "fixed") job.row_data = { ...(job.row_data as Row), bucket: "completed", status: "Completed" };
        return { data: { applied: true }, error: null };
      }
      if (fn === "next_vendor_dispatch_handle") {
        const owner = String(args.p_owner ?? "");
        const next = (counters.get(owner) ?? 0) + 1;
        counters.set(owner, next);
        return { data: next, error: null };
      }
      return base.rpc(fn, args);
    },
  } as unknown as MemoryDb;
}
