/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles stand in for a PostgREST client and untyped .mjs scripts */
/**
 * An in-memory port of the three burst-debounce functions in
 * supabase/migrations/20261018210000_one_number_feel.sql (sms_debounce_register / _claim / _settle) and of the
 * one table read the code makes (`sms_reply_debounce.revision`). The port is checked against recorded output of
 * the real SQL in tests/unit/one-number-debounce-sql-parity.test.ts, so a load test that uses it stands on the
 * database's actual semantics rather than on a guess.
 */
type Entry = { sid: string; body: string; rev: number; at: number };
type Row = { revision: number; entries: Entry[] };

export function debounceSqlPort(now: () => number = () => Date.now()) {
  const table = new Map<string, Row>();

  const register = (scope: string, sid: string, body: string) => {
    if (!scope || !sid) return { data: null, error: { message: "invalid debounce scope" } };
    const at = now();
    const row = table.get(scope);
    if (!row) {
      table.set(scope, { revision: 1, entries: [{ sid, body, rev: 1, at }] });
      return { data: 1, error: null };
    }
    if (!row.entries.some((e) => e.sid === sid)) {
      const kept = row.entries.filter((e) => e.at > at - 90_000).sort((a, b) => a.rev - b.rev);
      row.entries = [...kept, { sid, body, rev: row.revision + 1, at }];
      row.revision += 1;
    }
    const mine = row.entries.find((e) => e.sid === sid);
    return { data: mine?.rev ?? row.revision, error: null };
  };
  const claim = (scope: string, rev: number) => {
    const row = table.get(scope);
    if (!row || row.revision !== rev) return { data: null, error: null };
    return { data: row.entries.filter((e) => e.rev <= rev).sort((a, b) => a.rev - b.rev).map((e) => ({ ...e })), error: null };
  };
  const settle = (scope: string, rev: number) => {
    const row = table.get(scope);
    if (row) row.entries = row.entries.filter((e) => e.rev > rev).sort((a, b) => a.rev - b.rev);
    return { data: null, error: null };
  };

  return {
    table,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "sms_debounce_register") return register(String(args.p_scope), String(args.p_sid), String(args.p_body));
      if (fn === "sms_debounce_claim") return claim(String(args.p_scope), Number(args.p_rev));
      if (fn === "sms_debounce_settle") return settle(String(args.p_scope), Number(args.p_rev));
      return { data: null, error: { message: `unknown function ${fn}` } };
    },
    /** `.from("sms_reply_debounce").select("revision").eq("scope_key", s).maybeSingle()` */
    from: (name: string) => {
      let scope = "";
      const q: any = {
        select: () => q,
        eq: (_c: string, v: string) => { scope = v; return q; },
        maybeSingle: async () => ({ data: name === "sms_reply_debounce" && table.has(scope) ? { revision: table.get(scope)!.revision } : null, error: null }),
      };
      return q;
    },
  };
}
