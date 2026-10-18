import { describe, expect, it } from "vitest";
import { debounceInbound, debounceScopeKey } from "@/lib/one-number/debounce.server";

type Entry = { sid: string; body: string; rev: number };

/** An in-memory stand-in for the three SQL functions, with the same semantics. */
function fakeDb(opts: { failRegister?: boolean } = {}) {
  const rows = new Map<string, { revision: number; entries: Entry[] }>();
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      const scope = String(args.p_scope);
      if (name === "sms_debounce_register") {
        if (opts.failRegister) return { data: null, error: { code: "42883" } };
        const row = rows.get(scope) ?? { revision: 0, entries: [] };
        const existing = row.entries.find((e) => e.sid === args.p_sid);
        if (!existing) {
          row.revision += 1;
          row.entries.push({ sid: String(args.p_sid), body: String(args.p_body), rev: row.revision });
        }
        rows.set(scope, row);
        return { data: (existing ?? row.entries.at(-1)!).rev, error: null };
      }
      if (name === "sms_debounce_claim") {
        const row = rows.get(scope);
        if (!row || row.revision !== Number(args.p_rev)) return { data: null, error: null };
        return { data: row.entries.filter((e) => e.rev <= Number(args.p_rev)), error: null };
      }
      if (name === "sms_debounce_settle") {
        const row = rows.get(scope);
        if (row) row.entries = row.entries.filter((e) => e.rev > Number(args.p_rev));
        return { data: null, error: null };
      }
      return { data: null, error: { code: "42883" } };
    },
    from: () => ({
      select: () => ({
        eq: (_c: string, scope: string) => ({ maybeSingle: async () => ({ data: rows.has(scope) ? { revision: rows.get(scope)!.revision } : null, error: null }) }),
      }),
    }),
  };
  return { db: db as never, rows };
}

const base = { ownerUserId: "owner-1", role: "resident" as const, phone: "+12065550101", waitMs: 1500 };

describe("debounceInbound", () => {
  it("does nothing (no wait, no merge) when the window is 0", async () => {
    const { db, rows } = fakeDb();
    const sleeps: number[] = [];
    const out = await debounceInbound(db, { ...base, waitMs: 0, messageSid: "SM1", body: "hi", sleep: async (ms) => { sleeps.push(ms); } });
    expect(out).toMatchObject({ proceed: true, body: "hi", mergedCount: 1 });
    expect(sleeps).toEqual([]);
    expect(rows.size).toBe(0);
  });

  it("waits the quiet window, then answers a lone text", async () => {
    const { db } = fakeDb();
    const sleeps: number[] = [];
    const out = await debounceInbound(db, { ...base, messageSid: "SM1", body: "wifi?", sleep: async (ms) => { sleeps.push(ms); } });
    expect(sleeps).toEqual([1500]);
    expect(out).toMatchObject({ proceed: true, body: "wifi?", mergedCount: 1, waitedMs: 1500 });
  });

  it("the newest of a burst answers all of them, oldest first; older invocations yield", async () => {
    const { db } = fakeDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Texts 1 and 2 are both asleep when text 3 registers; they wake after it.
    const first = debounceInbound(db, { ...base, messageSid: "SM1", body: "hey", sleep: () => gate });
    const second = debounceInbound(db, { ...base, messageSid: "SM2", body: "quick question", sleep: () => gate });
    await new Promise((r) => setTimeout(r, 0));
    const third = debounceInbound(db, { ...base, messageSid: "SM3", body: "is the wifi down", sleep: () => gate });
    await new Promise((r) => setTimeout(r, 0));
    release();
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(a).toEqual({ proceed: false });
    expect(b).toEqual({ proceed: false });
    expect(c).toMatchObject({ proceed: true, body: "hey\nquick question\nis the wifi down", mergedCount: 3 });
  });

  it("settle drops the answered texts so the next burst starts clean", async () => {
    const { db } = fakeDb();
    const sleep = async () => {};
    const one = await debounceInbound(db, { ...base, messageSid: "SM1", body: "a", sleep });
    if (!one.proceed) throw new Error("expected proceed");
    await one.settle();
    const two = await debounceInbound(db, { ...base, messageSid: "SM2", body: "b", sleep });
    expect(two).toMatchObject({ proceed: true, body: "b", mergedCount: 1 });
  });

  it("a retried message sid does not count twice", async () => {
    const { db } = fakeDb();
    const sleep = async () => {};
    await debounceInbound(db, { ...base, messageSid: "SM1", body: "a", sleep });
    const again = await debounceInbound(db, { ...base, messageSid: "SM1", body: "a", sleep });
    expect(again).toMatchObject({ proceed: true, mergedCount: 1, body: "a" });
  });

  it("an immediate text (photo) registers and merges but does not wait", async () => {
    const { db } = fakeDb();
    const sleeps: number[] = [];
    const out = await debounceInbound(db, { ...base, messageSid: "SM1", body: "here is the leak", immediate: true, sleep: async (ms) => { sleeps.push(ms); } });
    expect(sleeps).toEqual([]);
    expect(out).toMatchObject({ proceed: true, body: "here is the leak" });
  });

  it("fails open: any RPC trouble answers at once with just this text", async () => {
    const { db } = fakeDb({ failRegister: true });
    const sleeps: number[] = [];
    const out = await debounceInbound(db, { ...base, messageSid: "SM1", body: "hello", sleep: async (ms) => { sleeps.push(ms); } });
    expect(out).toMatchObject({ proceed: true, body: "hello", mergedCount: 1 });
    expect(sleeps).toEqual([]);
    const thrown = await debounceInbound({ rpc: () => { throw new Error("boom"); } } as never, { ...base, messageSid: "SM2", body: "x" });
    expect(thrown).toMatchObject({ proceed: true, body: "x" });
  });

  it("scopes by owner, role and phone digits", () => {
    expect(debounceScopeKey({ ownerUserId: "o", role: "vendor", phone: "+1 (206) 555-0101" })).toBe("o:vendor:12065550101");
    const { db, rows } = fakeDb();
    return Promise.all([
      debounceInbound(db, { ...base, role: "resident", messageSid: "SM1", body: "a", sleep: async () => {} }),
      debounceInbound(db, { ...base, role: "manager", messageSid: "SM2", body: "b", sleep: async () => {} }),
    ]).then(([r, m]) => {
      expect(r).toMatchObject({ proceed: true, body: "a" });
      expect(m).toMatchObject({ proceed: true, body: "b" });
      expect(rows.size).toBe(2);
    });
  });
});
