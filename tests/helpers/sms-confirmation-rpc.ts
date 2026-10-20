import type { FakeDb } from "./fake-table-db";

/**
 * `sms_confirmation_phone_reserve` as supabase/migrations/20261020120000 defines it, for the in-memory fake: count the
 * phone's recent failure rows and, under the cap, insert this guess's row (returned by id); at the cap report locked.
 */
export function withSmsConfirmationReserveRpc<T extends FakeDb>(db: T, calls: Array<Record<string, unknown>> = []): T & { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> } {
  let n = 0;
  return Object.assign(db, {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, ...args });
      if (name !== "sms_confirmation_phone_reserve") return { data: null, error: { message: "unknown function" } };
      const rows = (db.tables.sms_confirmation_failures ??= []);
      const since = new Date(Date.parse(String(args.p_now)) - Number(args.p_window_seconds) * 1000).toISOString();
      const recent = rows.filter((r) => r.phone_hash === args.p_phone_hash && String(r.failed_at) >= since).length;
      if (recent >= Number(args.p_cap)) return { data: [{ locked: true, failure_id: null }], error: null };
      const id = `fail-${(n += 1)}`;
      rows.push({ id, phone_hash: args.p_phone_hash, failed_at: args.p_now });
      return { data: [{ locked: false, failure_id: id }], error: null };
    },
  });
}
