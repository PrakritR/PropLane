import type { SupabaseClient } from "@supabase/supabase-js";
// The in-memory adapter accepts arbitrary PostgREST row shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
export class MemoryDb {
 tables: Record<string, Row[]> = { sms_ingress_envelopes: [], sms_platform_replies: [], sms_inbound_receipts: [] };
 failOutcome = false;
 from(table: string) { return new Query(this, table); }
 async rpc(name: string, args: Row) {
  if (name === "sms_ingress_claim") {
   const row = this.tables.sms_ingress_envelopes.find(r => r.id === args.p_id && r.runtime === args.p_runtime && r.account_sid === args.p_account && r.status === "accepted" && r.expires_at > new Date().toISOString());
   if (!row) return { data: null, error: null };
   if ((row.attempts ?? 0) >= 3 || (row.next_attempt_at && row.next_attempt_at > new Date().toISOString())) return { data: null, error: null };
   row.attempts++;
   Object.assign(row, { status: "executing", lease_token: args.p_token, lease_until: new Date(Date.now() + 120_000).toISOString() });
   return { data: { ...row }, error: null };
  }
  if (name === "sms_ingress_checkpoint") {
   const row = this.tables.sms_ingress_envelopes.find(r => r.id === args.p_id && r.status === "executing" && r.lease_token === args.p_token);
   if (!row) return { data: false, error: null };
   Object.assign(row, { checkpoint_stage: args.p_stage, control_keyword: args.p_control ?? row.control_keyword, delegated_sid: args.p_delegated_sid ?? row.delegated_sid });
   return { data: true, error: null };
  }
  if (name === "sms_ingress_reconcile") {
   for (const row of this.tables.sms_ingress_envelopes.filter(r => r.runtime === args.p_runtime && r.account_sid === args.p_account && r.status === "needs_review")) {
    if (row.reason === "delegated_receipt" && this.tables.sms_inbound_receipts.some(r => r.message_sid === row.delegated_sid && r.status === "completed")) row.status = "completed";
    const replies = this.tables.sms_platform_replies.filter(r => r.envelope_id === row.id);
    if (row.reason === "delivery_unknown" && row.expires_at > new Date().toISOString() && replies.length && replies.every(r => ["accepted", "prepared"].includes(r.status))) row.status = "prepared";
   }
   return { data: null, error: null };
  }
  if (name === "sms_ingress_prepare") {
   const row = this.tables.sms_ingress_envelopes.find(r => r.id === args.p_id && r.status === "executing" && r.lease_token === args.p_token);
   if (!row) return { data: false, error: null };
   args.p_bubbles.forEach((bubble: Row, index: number) => this.tables.sms_platform_replies.push({ id: `reply-${index}`, envelope_id: row.id, bubble_index: index, body: bubble.body, media_urls: bubble.mediaUrls ?? [], wire_from: args.p_sender, wire_to: row.wire_from, runtime: row.runtime, account_sid: row.account_sid, callback_token: "11111111-1111-4111-8111-111111111111", status: "prepared", attempt_count: 0 }));
   row.status = args.p_bubbles.length ? "prepared" : "completed";
   return { data: true, error: null };
  }
  throw Error(`Unexpected RPC ${name}`);
 }
 asClient() { return this as unknown as SupabaseClient; }
}
class Query {
 private filters: ((r: Row) => boolean)[] = []; private action = "select"; private values: Row = {}; private singleRow = false; private limitCount = Infinity; private head = false;
 constructor(private db: MemoryDb, private table: string) {}
 insert(v: Row) { this.action = "insert"; this.values = v; return this; }
 update(v: Row) { this.action = "update"; this.values = v; return this; }
 select(_fields: string, options?: { head?: boolean }) { this.head = !!options?.head; return this; }
 eq(k: string, v: unknown) { this.filters.push(r => r[k] === v); return this; }
 lt(k: string, v: string) { this.filters.push(r => r[k] != null && r[k] < v); return this; }
 gt(k: string, v: string) { this.filters.push(r => r[k] != null && r[k] > v); return this; }
 in(k: string, v: unknown[]) { this.filters.push(r => v.includes(r[k])); return this; }
 order() { return this; }
 limit(n: number) { this.limitCount = n; return this; }
 single() { this.singleRow = true; return this; }
 maybeSingle() { this.singleRow = true; return this; }
 abortSignal() { return this; }
 then(resolve: (v: Row) => unknown, reject: (e: unknown) => unknown) { return Promise.resolve().then(() => this.run()).then(resolve, reject); }
 private run() {
  const rows = this.db.tables[this.table];
  if (this.action === "insert") {
   if (rows.some(r => r.message_sid === this.values.message_sid)) return { data: null, error: { code: "23505" } };
   const row = { id: "envelope", status: "accepted", attempts: 0, checkpoint_stage: "unstarted", expires_at: new Date(Date.now() + 86_400_000).toISOString(), ...this.values };
   rows.push(row); return { data: { ...row }, error: null };
  }
  const matches = rows.filter(r => this.filters.every(f => f(r))).slice(0, this.limitCount);
  if (this.action === "update") {
   if (this.db.failOutcome && this.table === "sms_platform_replies" && this.values.status === "accepted") return { data: null, error: { code: "db_failed" } };
   matches.forEach(r => Object.assign(r, this.values));
  }
  const copies = matches.map(r => ({ ...r }));
  return { data: this.head ? null : this.singleRow ? copies[0] ?? null : copies, count: matches.length, error: null };
 }
}
