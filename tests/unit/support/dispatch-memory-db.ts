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
    rpc: async (fn, args = {}) => {
      if (fn === "next_vendor_dispatch_handle") {
        const owner = String(args.p_owner ?? "");
        const next = (counters.get(owner) ?? 0) + 1;
        counters.set(owner, next);
        return { data: next, error: null };
      }
      return base.rpc(fn, args);
    },
  };
}
