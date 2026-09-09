import { describe, expect, it } from "vitest";
import { reconcileSubmittedSmsConversationLogs } from "@/lib/sms/owner-sms-dispatcher.server";

type Row = Record<string, unknown>;

function fakeDb(rows: Row[], onMessageInsert?: () => void) {
  const messages: Row[] = [];
  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let update: Row | null = null;
    const q: Record<string, unknown> = {
      select() { return q; },
      in(column: string, values: unknown[]) { filters.push((r) => values.includes(r[column])); return q; },
      not(column: string, _op: string, value: unknown) { filters.push((r) => r[column] !== value); return q; },
      lte(column: string, value: string) { filters.push((r) => String(r[column] ?? "") <= value); return q; },
      eq(column: string, value: unknown) { filters.push((r) => r[column] === value); return q; },
      order() { return q; },
      // A database query is a snapshot. Returning row references here would let
      // a concurrent fake update rewrite another worker's already-read due key.
      limit() { return Promise.resolve({ data: (table === "sms_outbox" ? rows : messages).filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null }); },
      update(payload: Row) { update = payload; return q; },
      insert(payload: Row) { messages.push(payload); onMessageInsert?.(); return Promise.resolve({ error: null }); },
      maybeSingle() {
        const list = (table === "sms_outbox" ? rows : messages).filter((r) => filters.every((f) => f(r)));
        const row = list[0] ?? null;
        if (row && update) Object.assign(row, update);
        return Promise.resolve({ data: row, error: null });
      },
      then(resolve: (value: { data: Row | null; error: null }) => unknown) {
        const list = (table === "sms_outbox" ? rows : messages).filter((r) => filters.every((f) => f(r)));
        if (update) list.forEach((row) => Object.assign(row, update));
        return Promise.resolve({ data: list[0] ?? null, error: null }).then(resolve);
      },
    };
    return q;
  };
  return { db: { from } as never, messages };
}

const due = "2020-01-01T00:00:00.000Z";
const row = (patch: Row = {}): Row => ({
  id: "outbox-1", manager_user_id: "manager-1", actor_user_id: "manager-1", recipient_user_id: null,
  recipient_email: "prospect@example.com", recipient_phone: "+12065550142", body: "Approved", send_class: "transactional",
  purpose: "application_approved_notification", conversation_key: "manager-1:prospect:+12065550142", counterparty_role: "prospect",
  property_id: "property-1", recipient_timezone: "America/Los_Angeles", dedupe_key: "approval-1", trace_id: null, segment_count: 1,
  provider_message_sid: "SM-original", provider_from_phone: "+12065550100", conversation_log_status: "failed", conversation_log_attempts: 1,
  conversation_log_next_attempt_at: due, status: "submitted", ...patch,
});

describe("submitted SMS conversation-log repair", () => {
  it("claims once and writes one durable conversation record using the original SID, key, and sender", async () => {
    const { db, messages } = fakeDb([row()]);
    const [first, second] = await Promise.all([
      reconcileSubmittedSmsConversationLogs(db, 10),
      reconcileSubmittedSmsConversationLogs(db, 10),
    ]);
    expect(first.attempted + second.attempted).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ message_sid: "SM-original", conversation_key: "manager-1:prospect:+12065550142", from_phone: "+12065550100" });
  });

  it("does not repair unknown submissions, missing original senders, or non-due rows", async () => {
    const { db, messages } = fakeDb([
      row({ id: "unknown", status: "unknown" }),
      row({ id: "missing-from", provider_from_phone: null }),
      row({ id: "later", conversation_log_next_attempt_at: "2999-01-01T00:00:00.000Z" }),
    ]);
    await expect(reconcileSubmittedSmsConversationLogs(db, 10)).resolves.toEqual({ ok: true, attempted: 0, persisted: 0, failed: 0 });
    expect(messages).toHaveLength(0);
  });

  it("repairs a submitted pending marker left by a crash before the first log write", async () => {
    const crashedSubmission = row({
      conversation_log_status: "pending",
      conversation_log_attempts: 0,
      conversation_log_next_attempt_at: due,
    });
    const { db, messages } = fakeDb([crashedSubmission]);
    await expect(reconcileSubmittedSmsConversationLogs(db, 10)).resolves.toEqual({ ok: true, attempted: 1, persisted: 1, failed: 0 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      message_sid: "SM-original",
      conversation_key: "manager-1:prospect:+12065550142",
      from_phone: "+12065550100",
    });
    expect(crashedSubmission).toMatchObject({ conversation_log_status: "persisted", conversation_log_attempts: 1 });
  });

  it("does not let an expired repair finalizer regress a newer persisted projection", async () => {
    const staleCandidate = row();
    const { db } = fakeDb([staleCandidate], () => {
      // Simulate a newer worker finishing after this worker's five-minute claim
      // expired but before this worker performs its final marker write.
      staleCandidate.conversation_log_status = "persisted";
      staleCandidate.conversation_log_next_attempt_at = null;
      staleCandidate.conversation_log_attempts = 2;
    });
    await expect(reconcileSubmittedSmsConversationLogs(db, 10)).resolves.toEqual({ ok: true, attempted: 1, persisted: 0, failed: 0 });
    expect(staleCandidate).toMatchObject({ conversation_log_status: "persisted", conversation_log_attempts: 2 });
  });

  it("reports inventory and claim database failures instead of a zero-work success", async () => {
    const inventoryDb = {
      from: () => {
        const q = {
          select: () => q, in: () => q, not: () => q, lte: () => q, order: () => q,
          limit: async () => ({ data: null, error: { message: "inventory unavailable" } }),
        };
        return q;
      },
    } as never;
    await expect(reconcileSubmittedSmsConversationLogs(inventoryDb, 10))
      .resolves.toEqual({ ok: false, error: "inventory_unavailable", attempted: 0, persisted: 0, failed: 0 });

    const candidate = row();
    const claimDb = {
      from: () => {
        const q = {
          select: () => q, in: () => q, not: () => q, lte: () => q, order: () => q,
          limit: async () => ({ data: [candidate], error: null }),
          update: () => q, eq: () => q,
          maybeSingle: async () => ({ data: null, error: { message: "claim unavailable" } }),
        };
        return q;
      },
    } as never;
    await expect(reconcileSubmittedSmsConversationLogs(claimDb, 10))
      .resolves.toEqual({ ok: false, error: "claim_unavailable", attempted: 0, persisted: 0, failed: 0 });
  });
});
