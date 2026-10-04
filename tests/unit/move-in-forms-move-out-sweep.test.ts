/**
 * The daily "Before move-out" send: `sweepMoveOutForms` (gated to the 8 o'clock Pacific hour and to one
 * claimed pass per Pacific day) and the ungated `runMoveOutDispatch` it calls. The send itself (`dispatchMoveInFormsForResidency`) has its own
 * tests in move-in-forms-server.test.ts; here it is mocked so the sweep's own choices are what is
 * asserted: which leases are looked at, which residencies get a dispatch, with which `daysUntilLeaseEnd`
 * and `secondaryMember`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/move-in-forms/move-in-form-events.server", () => ({ emitMoveInFormEvent: vi.fn(async () => undefined) }));
const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/move-in-forms/server", () => ({ dispatchMoveInFormsForResidency: dispatch }));

import { runMoveOutDispatch, sweepMoveOutForms } from "@/lib/reminders/subjects/move-in-forms.server";

type Row = Record<string, unknown>;
let leaseRows: Row[];
let applicationRows: Row[];
let failTable: string | null;
let selects: { table: string; ids?: number }[];
/** The unique `audit_log.dedupe_key` column, which is what makes the day claim a claim. */
let auditKeys: Map<string, Row>;

/** `alias:column->>key` and `alias:column->a->>key` selects, resolved against a row_data-shaped record. */
function project(row: Row, columns: string): Row {
  const out: Row = {};
  for (const part of columns.split(",")) {
    const [alias, path] = part.includes(":") ? part.split(":") : [part, part];
    const [column, ...keys] = path!.split(/->>|->/);
    let cell: unknown = row[column!];
    for (const key of keys) cell = cell && typeof cell === "object" ? (cell as Record<string, unknown>)[key] ?? null : null;
    out[alias!] = cell ?? null;
  }
  return out;
}

function cell(row: Row, key: string): unknown {
  const [column, ...keys] = key.split(/->>|->/);
  let value: unknown = row[column!];
  for (const next of keys) value = value && typeof value === "object" ? (value as Record<string, unknown>)[next] ?? null : null;
  return value ?? null;
}

function builder(table: string) {
  const filters: ((row: Row) => boolean)[] = [];
  let columns = "*";
  let from = 0;
  let to = Infinity;
  const rows = () => (table === "portal_lease_pipeline_records" ? leaseRows : table === "manager_application_records" ? applicationRows : []);
  const run = () => {
    if (failTable === table) return { data: null, error: { message: `${table} down` } };
    const matched = rows().filter((row) => filters.every((f) => f(row))).slice(from, to + 1);
    return { data: matched.map((row) => project(row, columns)), error: null };
  };
  const q: Record<string, unknown> = {
    select: (cols: string) => { columns = cols; return q; },
    order: () => q,
    range: (a: number, b: number) => { from = a; to = b; return q; },
    // `.not(col, "is", null)` = has a value; `.is(col, null)` = has none.
    not: (key: string, op: string, v: unknown) => { filters.push((row) => op === "is" ? cell(row, key) !== v : true); return q; },
    is: (key: string, v: unknown) => { filters.push((row) => cell(row, key) === v); return q; },
    in: (key: string, v: unknown[]) => { selects.push({ table, ids: v.length }); filters.push((row) => v.includes(cell(row, key))); return q; },
    // audit_log: the insert is the claim, so a repeated dedupe_key is a 23505 like the real unique index.
    insert: (row: Row) => {
      if (failTable === table) return Promise.resolve({ error: { message: `${table} down` } });
      const key = String(row.dedupe_key ?? "");
      if (auditKeys.has(key)) return Promise.resolve({ error: { code: "23505", message: "duplicate key" } });
      auditKeys.set(key, { ...row });
      return Promise.resolve({ error: null });
    },
    update: (patch: Row) => ({
      eq: (_column: string, value: unknown) => {
        const found = auditKeys.get(String(value));
        if (found) {
          auditKeys.delete(String(value));
          const next = { ...found, ...patch };
          if (next.dedupe_key) auditKeys.set(String(next.dedupe_key), next);
        }
        return Promise.resolve({ error: null });
      },
    }),
    then: (resolve: (v: ReturnType<typeof run>) => unknown) => Promise.resolve(run()).then(resolve),
  };
  return q;
}
const db = { from: builder } as never;

const lease = (axisId: string, extra: Row = {}): Row => ({
  id: `lease-${axisId}`,
  row_data: { axisId, fullySignedAt: "2026-09-01T00:00:00Z", voidedAt: null, jointLeaseMembers: null, ...extra },
});
const application = (id: string, leaseEnd: string | null): Row => ({ id, row_data: { application: { leaseEnd } } });

/** 08:00 Pacific on 2026-10-10 (daylight time). */
const EIGHT_AM = new Date("2026-10-10T15:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  dispatch.mockImplementation(async () => ({ sent: 1, failed: 0 }));
  leaseRows = [];
  applicationRows = [];
  failTable = null;
  selects = [];
  auditKeys = new Map();
});

describe("sweepMoveOutForms only runs in the 8 o'clock Pacific hour", () => {
  beforeEach(() => {
    leaseRows = [lease("A")];
    applicationRows = [application("A", "2026-10-20")];
  });

  it("runs on the first tick of the 8 o'clock Pacific hour", async () => {
    expect(await sweepMoveOutForms(db, new Date("2026-10-10T15:00:00Z"))).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does nothing at 07:59 or 09:00 Pacific", async () => {
    expect(await sweepMoveOutForms(db, new Date("2026-10-10T14:59:59Z"))).toBe(0);
    expect(await sweepMoveOutForms(db, new Date("2026-10-10T16:00:00Z"))).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("runs the pass once a day, however many ticks land in its hour", async () => {
    const ran: number[] = [];
    for (let hour = 0; hour < 24; hour++) {
      for (const minute of [0, 5, 30, 55]) {
        const now = new Date(Date.UTC(2026, 9, 10, hour, minute));
        dispatch.mockClear();
        await sweepMoveOutForms(db, now);
        if (dispatch.mock.calls.length > 0) ran.push(hour);
      }
    }
    // 08:00-08:59 PDT is 15:00-15:59Z: the first of its four ticks claims the day, the rest skip.
    expect(ran).toEqual([15]);
  });

  it("the twelve later ticks of the hour read no leases at all", async () => {
    expect(await sweepMoveOutForms(db, new Date("2026-10-10T15:00:00Z"))).toBe(1);
    selects = [];
    const from = vi.fn(builder);
    const counted = { from } as never;
    for (let minute = 5; minute < 60; minute += 5) {
      expect(await sweepMoveOutForms(counted, new Date(Date.UTC(2026, 9, 10, 15, minute)))).toBe(0);
    }
    expect(from.mock.calls.map(([table]) => table)).toEqual(Array.from({ length: 11 }, () => "audit_log"));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("claims each Pacific day on its own, so the next morning runs again", async () => {
    expect(await sweepMoveOutForms(db, new Date("2026-10-10T15:00:00Z"))).toBe(1);
    expect(await sweepMoveOutForms(db, new Date("2026-10-11T15:00:00Z"))).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect([...auditKeys.keys()]).toEqual([
      "move_in_form_move_out_sweep:2026-10-10",
      "move_in_form_move_out_sweep:2026-10-11",
    ]);
  });

  it("releases the day when the pass fails, so a later tick retries it", async () => {
    failTable = "portal_lease_pipeline_records";
    await expect(sweepMoveOutForms(db, new Date("2026-10-10T15:00:00Z"))).rejects.toThrow(/portal_lease_pipeline_records down/);
    expect(auditKeys.size).toBe(0);
    failTable = null;
    expect(await sweepMoveOutForms(db, new Date("2026-10-10T15:05:00Z"))).toBe(1);
  });

  it("releases the day when a dispatch reported a failure, even though nothing threw", async () => {
    dispatch.mockImplementation(async () => ({ sent: 0, failed: 1 }));
    expect(await sweepMoveOutForms(db, new Date("2026-10-10T15:00:00Z"))).toBe(0);
    expect(auditKeys.size).toBe(0);
    dispatch.mockImplementation(async () => ({ sent: 1, failed: 0 }));
    expect(await sweepMoveOutForms(db, new Date("2026-10-10T15:05:00Z"))).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("closes a clean day that had nothing to send, so it is not retried", async () => {
    applicationRows = [application("A", "2027-06-01")];
    expect(await sweepMoveOutForms(db, new Date("2026-10-10T15:00:00Z"))).toBe(0);
    expect([...auditKeys.keys()]).toEqual(["move_in_form_move_out_sweep:2026-10-10"]);
    expect(await sweepMoveOutForms(db, new Date("2026-10-10T15:05:00Z"))).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("follows the Pacific clock through the change to standard time (08:00 PST is 16:00Z)", async () => {
    applicationRows = [application("A", "2026-12-20")];
    expect(await sweepMoveOutForms(db, new Date("2026-12-10T15:00:00Z"))).toBe(0);
    expect(await sweepMoveOutForms(db, new Date("2026-12-10T16:00:00Z"))).toBe(1);
    expect(await sweepMoveOutForms(db, new Date("2026-12-10T17:00:00Z"))).toBe(0);
  });

  it("the gated run reads nothing from the database outside its hour", async () => {
    const from = vi.fn(() => { throw new Error("must not query"); });
    await expect(sweepMoveOutForms({ from } as never, new Date("2026-10-10T20:00:00Z"))).resolves.toBe(0);
    expect(from).not.toHaveBeenCalled();
  });
});

describe("runMoveOutDispatch", () => {
  it("dispatches a before-move-out send for each lease ending in 0..30 days, with the days left", async () => {
    leaseRows = [lease("today"), lease("two-weeks"), lease("edge")];
    applicationRows = [application("today", "2026-10-10"), application("two-weeks", "2026-10-24"), application("edge", "2026-11-09")];
    expect(await runMoveOutDispatch(db, EIGHT_AM)).toEqual({ sent: 3, failed: 0 });
    const byId = Object.fromEntries(dispatch.mock.calls.map(([id, , options]) => [id, options.daysUntilLeaseEnd]));
    expect(byId).toEqual({ today: 0, "two-weeks": 14, edge: 30 });
    for (const [, trigger, options] of dispatch.mock.calls) {
      expect(trigger).toBe("before-move-out");
      expect(options.db).toBe(db);
    }
  });

  it("skips leases that already ended or end more than 30 days away", async () => {
    leaseRows = [lease("ended"), lease("far"), lease("just-far"), lease("yesterday")];
    applicationRows = [
      application("ended", "2026-09-01"), application("far", "2027-06-01"),
      application("just-far", "2026-11-10"), application("yesterday", "2026-10-09"),
    ];
    expect(await runMoveOutDispatch(db, EIGHT_AM)).toEqual({ sent: 0, failed: 0 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("skips a lease that is not fully signed or is voided", async () => {
    leaseRows = [
      lease("unsigned", { fullySignedAt: null }),
      lease("voided", { voidedAt: "2026-10-01T00:00:00Z" }),
      lease("ok"),
    ];
    applicationRows = [application("unsigned", "2026-10-20"), application("voided", "2026-10-20"), application("ok", "2026-10-20")];
    expect(await runMoveOutDispatch(db, EIGHT_AM)).toEqual({ sent: 1, failed: 0 });
    expect(dispatch.mock.calls.map(([id]) => id)).toEqual(["ok"]);
  });

  it("skips an application with no usable lease end", async () => {
    leaseRows = [lease("blank"), lease("junk"), lease("missing"), lease("ok")];
    applicationRows = [application("blank", ""), application("junk", "someday"), application("missing", null), application("ok", "2026-10-12")];
    expect(await runMoveOutDispatch(db, EIGHT_AM)).toEqual({ sent: 1, failed: 0 });
    expect(dispatch.mock.calls.map(([id]) => id)).toEqual(["ok"]);
  });

  it("accepts a lease end written as a timestamp", async () => {
    leaseRows = [lease("A")];
    applicationRows = [application("A", "2026-10-15T00:00:00.000Z")];
    await runMoveOutDispatch(db, EIGHT_AM);
    expect(dispatch.mock.calls[0]![2].daysUntilLeaseEnd).toBe(5);
  });

  it("joint lease members are dispatched with secondaryMember true; the primary signer with false", async () => {
    leaseRows = [lease("A", { jointLeaseMembers: [{ applicationId: "B" }, { applicationId: "C" }, { applicationId: "" }, {}] })];
    applicationRows = [application("A", "2026-10-20"), application("B", "2026-10-20"), application("C", "2026-10-20")];
    expect(await runMoveOutDispatch(db, EIGHT_AM)).toEqual({ sent: 3, failed: 0 });
    const secondary = Object.fromEntries(dispatch.mock.calls.map(([id, , options]) => [id, options.secondaryMember]));
    expect(secondary).toEqual({ A: false, B: true, C: true });
    for (const [, , options] of dispatch.mock.calls) expect(options.daysUntilLeaseEnd).toBe(10);
  });

  it("a member listed on one lease who is the primary signer of another is treated as primary", async () => {
    leaseRows = [lease("A", { jointLeaseMembers: [{ applicationId: "B" }, { applicationId: "A" }] }), lease("B")];
    applicationRows = [application("A", "2026-10-20"), application("B", "2026-10-20")];
    await runMoveOutDispatch(db, EIGHT_AM);
    const secondary = Object.fromEntries(dispatch.mock.calls.map(([id, , options]) => [id, options.secondaryMember]));
    expect(secondary).toEqual({ A: false, B: false });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("a lease with no members, or members that are not a list, dispatches the primary only", async () => {
    leaseRows = [lease("A", { jointLeaseMembers: "nope" }), lease("B", { jointLeaseMembers: [] })];
    applicationRows = [application("A", "2026-10-20"), application("B", "2026-10-20")];
    await runMoveOutDispatch(db, EIGHT_AM);
    expect(dispatch.mock.calls.map(([id, , options]) => [id, options.secondaryMember])).toEqual([["A", false], ["B", false]]);
  });

  it("each residency gets its own days-left from its own lease end", async () => {
    leaseRows = [lease("A", { jointLeaseMembers: [{ applicationId: "B" }] })];
    applicationRows = [application("A", "2026-10-20"), application("B", "2026-10-31")];
    await runMoveOutDispatch(db, EIGHT_AM);
    const days = Object.fromEntries(dispatch.mock.calls.map(([id, , options]) => [id, options.daysUntilLeaseEnd]));
    expect(days).toEqual({ A: 10, B: 21 });
  });

  it("counts days on the Pacific calendar, not UTC's", async () => {
    leaseRows = [lease("A")];
    applicationRows = [application("A", "2026-10-10")];
    // 8 p.m. Pacific on Oct 9 is already Oct 10 in UTC: the lease ends tomorrow, not today.
    await runMoveOutDispatch(db, new Date("2026-10-10T03:00:00Z"));
    expect(dispatch.mock.calls[0]![2].daysUntilLeaseEnd).toBe(1);
  });

  it("adds up what the dispatches sent", async () => {
    leaseRows = [lease("A"), lease("B"), lease("C")];
    applicationRows = [application("A", "2026-10-20"), application("B", "2026-10-20"), application("C", "2026-10-20")];
    dispatch.mockImplementation(async (id: string) => ({ sent: id === "B" ? 0 : 2, failed: 0 }));
    expect(await runMoveOutDispatch(db, EIGHT_AM)).toEqual({ sent: 4, failed: 0 });
  });

  it("does nothing and dispatches nothing with no leases", async () => {
    expect(await runMoveOutDispatch(db, EIGHT_AM)).toEqual({ sent: 0, failed: 0 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("pages through many leases and looks applications up 100 at a time", async () => {
    const total = 520;
    leaseRows = Array.from({ length: total }, (_, i) => lease(`R${i}`));
    applicationRows = Array.from({ length: total }, (_, i) => application(`R${i}`, "2026-10-20"));
    expect(await runMoveOutDispatch(db, EIGHT_AM)).toEqual({ sent: total, failed: 0 });
    expect(dispatch).toHaveBeenCalledTimes(total);
    const lookups = selects.filter((entry) => entry.table === "manager_application_records");
    expect(lookups.map((entry) => entry.ids)).toEqual([100, 100, 100, 100, 100, 20]);
  });

  it("throws when the lease list cannot be read, and when the applications cannot", async () => {
    leaseRows = [lease("A")];
    applicationRows = [application("A", "2026-10-20")];
    failTable = "portal_lease_pipeline_records";
    await expect(runMoveOutDispatch(db, EIGHT_AM)).rejects.toThrow(/portal_lease_pipeline_records down/);
    failTable = "manager_application_records";
    await expect(runMoveOutDispatch(db, EIGHT_AM)).rejects.toThrow(/manager_application_records down/);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
