import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const cands = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("@/lib/manager-assistant-email/channel-guest-message.server", () => ({ loadChannelRoomCandidates: vi.fn(async () => []) }));

import { ingestChannelFinanceMail } from "@/lib/channel-finance/ingest.server";
import { recordFinanceFacts } from "@/lib/channel-finance/store.server";
import type { FinanceRoomCandidate } from "@/lib/channel-finance/match";

type Row = Record<string, unknown>;

/** The nil uuid `channel_payout_records.workspace_key` folds a null workspace to (20261112250000_*). */
const NIL_WORKSPACE = "00000000-0000-0000-0000-000000000000";

/** A tiny in-memory stand-in for the three tables, honouring eq / in / is / or filters and upsert onConflict. */
function fakeDb() {
  const tables: Record<string, Row[]> = { channel_payout_records: [], channel_finance_mail: [], external_calendar_connections: [] };
  let seq = 0;
  // The stored generated column, materialised exactly as the migration defines it, so the conflict key is the real one.
  const generated = (name: string, row: Row): Row =>
    name === "channel_payout_records" ? { ...row, workspace_key: (row.workspace_id as string | null) ?? NIL_WORKSPACE } : row;
  const from = (name: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let op: "select" | "upsert" | "update" | "delete" = "select";
    let payload: Row = {};
    let conflict: string[] = [];
    const run = () => {
      const rows = tables[name] ?? [];
      if (op === "select") return { data: rows.filter((r) => filters.every((f) => f(r))), error: null };
      if (op === "delete") {
        tables[name] = rows.filter((r) => !filters.every((f) => f(r)));
        return { data: null, error: null };
      }
      if (op === "update") {
        rows.filter((r) => filters.every((f) => f(r))).forEach((r) => Object.assign(r, generated(name, { ...r, ...payload })));
        return { data: null, error: null };
      }
      const values = generated(name, payload);
      const hit = rows.find((r) => conflict.every((k) => r[k] === values[k]));
      if (hit) Object.assign(hit, values);
      else rows.push({ id: `id-${++seq}`, ...values });
      return { data: hit ?? rows[rows.length - 1], error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), b),
      in: (k: string, v: unknown[]) => (filters.push((r) => v.includes(r[k])), b),
      // PostgREST's `or("col.eq.v,col.is.null")`: one OR group ANDed with the other filters.
      or: (expr: string) => {
        const terms = expr.split(",").map((term) => term.split("."));
        filters.push((r) => terms.some(([k, test, v]) => (test === "is" ? (r[k!] ?? null) === null : r[k!] === v)));
        return b;
      },
      order: () => b,
      limit: () => b,
      update: (p: Row) => ((op = "update"), (payload = p), b),
      delete: () => ((op = "delete"), b),
      upsert: (p: Row, o: { onConflict: string }) => ((op = "upsert"), (payload = p), (conflict = o.onConflict.split(",")), b),
      maybeSingle: async () => {
        const r = run();
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: null };
      },
      then: (res: (v: unknown) => unknown) => Promise.resolve(run()).then(res),
    };
    return b;
  };
  return { db: { from } as never, tables };
}

const room: FinanceRoomCandidate = { propertyId: "p1", propertyLabel: "5257 Brooklyn Ave", roomId: "r6", roomLabel: "Room 6", reservationCodes: [], connectionId: "c6", ranges: [{ code: "HMABC12345", start: "2026-10-07", end: "2026-10-10", sourceUid: "uid-6" }] };

const payoutMail = {
  subject: "Your payout was sent",
  text: "We've sent your payout\nPayout for Juan's stay HMABC12345\nCheck-in: Oct 7, 2026\nCheck-out: Oct 11, 2026\nGuest paid $480.00\nHost service fee -$14.40\nTotal payout $465.60\nPayout date: Oct 8, 2026",
  receivedAt: "2026-10-08T15:00:00Z",
};

describe("recordFinanceFacts", () => {
  beforeEach(() => void cands.list.splice(0));
  const facts = { platform: "airbnb" as const, kind: "payout" as const, confirmationCode: "HMABC12345", grossCents: 48000, hostFeeCents: 1440, payoutCents: 46560, currency: "USD", paidOn: "2026-10-08", checkIn: "2026-10-07", checkOut: "2026-10-11" };
  it("is idempotent on (platform, code, kind) and matches the synced stay by code", async () => {
    const { db, tables } = fakeDb();
    const input = { ownerUserId: "u1", workspaceId: null, facts, source: "csv" as const, review: "ok" as const, candidates: [room] };
    await recordFinanceFacts(db, input);
    await recordFinanceFacts(db, input);
    expect(tables.channel_payout_records).toHaveLength(1);
    expect(tables.channel_payout_records[0]).toMatchObject({ room_id: "r6", connection_id: "c6", source_uid: "uid-6", review_status: "ok", payout_cents: 46560 });
    // The other kind of the same booking is its own row.
    await recordFinanceFacts(db, { ...input, facts: { ...facts, kind: "reservation" } });
    expect(tables.channel_payout_records).toHaveLength(2);
  });
  it("the same code in another of the owner's workspaces is its own row: an import never moves income across workspaces", async () => {
    const { db, tables } = fakeDb();
    const base = { ownerUserId: "u1", facts, source: "csv" as const, review: "ok" as const, candidates: [room] };
    await recordFinanceFacts(db, { ...base, workspaceId: "ws-a" });
    await recordFinanceFacts(db, { ...base, workspaceId: "ws-b" });
    expect(tables.channel_payout_records).toHaveLength(2);
    expect(tables.channel_payout_records.map((r) => r.workspace_id).sort()).toEqual(["ws-a", "ws-b"]);
    // ... and each one is still idempotent inside its own workspace.
    await recordFinanceFacts(db, { ...base, workspaceId: "ws-a" });
    expect(tables.channel_payout_records.filter((r) => r.workspace_id === "ws-a")).toHaveLength(1);
    // An import that still knows no workspace never claims a placed row: it files its own.
    await recordFinanceFacts(db, { ...base, workspaceId: null });
    expect(tables.channel_payout_records).toHaveLength(3);
    expect(tables.channel_payout_records.filter((r) => r.workspace_id === null)).toHaveLength(1);
  });

  it("a row filed before any workspace was known is PLACED by the next import, never twinned", async () => {
    const { db, tables } = fakeDb();
    const base = { ownerUserId: "u1", facts, source: "csv" as const, review: "ok" as const, candidates: [room] };
    await recordFinanceFacts(db, { ...base, workspaceId: null, source: "email", review: "needs_review" });
    const unplaced = tables.channel_payout_records[0]!;
    expect(unplaced).toMatchObject({ workspace_id: null, review_status: "needs_review" });
    const out = await recordFinanceFacts(db, { ...base, workspaceId: "ws-a" });
    expect(tables.channel_payout_records).toHaveLength(1);
    expect(tables.channel_payout_records[0]).toMatchObject({ id: unplaced.id, workspace_id: "ws-a", review_status: "ok" });
    expect(out).toMatchObject({ id: unplaced.id, created: false });
  });

  it("an unplaced row is never claimed out of another workspace's placed row", async () => {
    const { db, tables } = fakeDb();
    const base = { ownerUserId: "u1", facts, source: "csv" as const, review: "ok" as const, candidates: [room] };
    await recordFinanceFacts(db, { ...base, workspaceId: "ws-a" });
    const inA = { ...tables.channel_payout_records[0]! };
    await recordFinanceFacts(db, { ...base, workspaceId: "ws-b", facts: { ...facts, payoutCents: 11100 } });
    expect(tables.channel_payout_records).toHaveLength(2);
    expect(tables.channel_payout_records.find((r) => r.id === inA.id)).toMatchObject({ workspace_id: "ws-a", payout_cents: 46560 });
    expect(tables.channel_payout_records.find((r) => r.id !== inA.id)).toMatchObject({ workspace_id: "ws-b", payout_cents: 11100 });
  });

  it("an unmatched booking is kept as 'needs_room', never dropped", async () => {
    const { db, tables } = fakeDb();
    await recordFinanceFacts(db, { ownerUserId: "u1", workspaceId: null, facts: { ...facts, confirmationCode: "HMZZZ99999", checkIn: "2027-01-01", checkOut: "2027-01-04" }, source: "csv", review: "ok", candidates: [room] });
    expect(tables.channel_payout_records[0]).toMatchObject({ review_status: "needs_room", room_id: null, payout_cents: 46560 });
  });
  it("an uncertain re-read never downgrades or overwrites a confirmed record", async () => {
    const { db, tables } = fakeDb();
    await recordFinanceFacts(db, { ownerUserId: "u1", workspaceId: null, facts, source: "csv", review: "ok", candidates: [room] });
    const out = await recordFinanceFacts(db, { ownerUserId: "u1", workspaceId: null, facts: { ...facts, payoutCents: 1 }, source: "email", review: "needs_review", candidates: [room] });
    expect(out?.unchanged).toBe(true);
    expect(tables.channel_payout_records[0]).toMatchObject({ review_status: "ok", payout_cents: 46560 });
  });
});

describe("ingestChannelFinanceMail", () => {
  it("an unauthenticated mail writes nothing", async () => {
    const { db, tables } = fakeDb();
    const r = await ingestChannelFinanceMail(db, { ownerUserId: "u1", workspaceId: null, platform: "airbnb", emailId: "e1", authenticated: false, ...payoutMail });
    expect(r.status).toBe("unauthenticated");
    expect(tables.channel_payout_records).toHaveLength(0);
    expect(tables.channel_finance_mail).toHaveLength(0);
  });
  it("a cross-checked payout is recorded (needs a room without a synced stay); replays do not duplicate; mail is logged once", async () => {
    const { db, tables } = fakeDb();
    const input = { ownerUserId: "u1", workspaceId: null, platform: "airbnb" as const, emailId: "e1", authenticated: true, ...payoutMail };
    expect((await ingestChannelFinanceMail(db, input)).status).toBe("recorded");
    await ingestChannelFinanceMail(db, input);
    expect(tables.channel_payout_records).toHaveLength(1);
    expect(tables.channel_payout_records[0]).toMatchObject({ review_status: "needs_room", payout_cents: 46560, paid_at: "2026-10-08T12:00:00Z" });
    expect(tables.channel_finance_mail).toHaveLength(1);
  });
  it("an amount the parser cannot vouch for is stored flagged 'needs_review', and an unreadable mail is flagged with no record", async () => {
    const { db, tables } = fakeDb();
    const unvouched = { subject: "Payout sent", text: "We've sent your payout HMQQQ11111\nTotal payout $200.00\nGuest paid $300.00", receivedAt: "2026-10-08T15:00:00Z" };
    // payout stated without gross/fee pair cross-check and the parser is unverified -> review, not counted
    const r = await ingestChannelFinanceMail(db, { ownerUserId: "u1", workspaceId: null, platform: "airbnb", emailId: "e2", authenticated: true, ...unvouched });
    expect(r.status).toBe("flagged");
    expect(tables.channel_payout_records[0]).toMatchObject({ review_status: "needs_review", payout_cents: 20000 });
    const u = await ingestChannelFinanceMail(db, { ownerUserId: "u1", workspaceId: null, platform: "airbnb", emailId: "e3", authenticated: true, subject: "Payout sent", text: "Total payout $10.00", receivedAt: "2026-10-08T15:00:00Z" });
    expect(u.status).toBe("flagged");
    expect(tables.channel_finance_mail.find((m) => m.email_id === "e3")).toMatchObject({ status: "flagged", record_id: null });
    expect(tables.channel_payout_records).toHaveLength(1);
  });
});
