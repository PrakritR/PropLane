import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const deliver = vi.fn(async () => ({ ok: true as const, recipientCount: 1 }));
vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalInboxMessage: (...args: unknown[]) => deliver(...(args as [])),
}));

import { emitActionEvent, retryDueActionEventDeliveries } from "@/lib/action-events.server";

type Row = Record<string, unknown> & { id: string };

function fakeDb() {
  const tables: Record<string, Row[]> = { action_events: [], action_event_deliveries: [] };
  let sequence = 0;
  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    const rows = () => tables[table]!;
    const matched = () => rows().filter((row) => filters.every((filter) => filter(row)));
    let mutation: Record<string, unknown> | null = null;
    let upserted: Row | null = null;
    let duplicateIgnored = false;
    let countOnly = false;
    const q = {
      select(_columns?: string, opts?: { count?: string; head?: boolean }) {
        countOnly = opts?.head === true;
        return q;
      },
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return q;
      },
      gte(column: string, value: string) {
        filters.push((row) => String(row[column] ?? "") >= value);
        return q;
      },
      lte(column: string, value: string) {
        filters.push((row) => String(row[column] ?? "") <= value);
        return q;
      },
      in(column: string, values: unknown[]) {
        filters.push((row) => values.includes(row[column]));
        return q;
      },
      order() { return q; },
      limit(limit: number) {
        return Promise.resolve({ data: matched().slice(0, limit), error: null });
      },
      upsert(payload: Record<string, unknown>, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        const keys = opts?.onConflict?.split(",") ?? ["id"];
        const existing = rows().find((row) => keys.every((key) => row[key] === payload[key]));
        if (existing && opts?.ignoreDuplicates) {
          upserted = null;
          duplicateIgnored = true;
        }
        else if (existing) upserted = Object.assign(existing, payload);
        else {
          upserted = { id: `${table}-${++sequence}`, created_at: new Date().toISOString(), attempts: 0, ...payload } as Row;
          rows().push(upserted);
        }
        return q;
      },
      update(payload: Record<string, unknown>) {
        mutation = payload;
        return q;
      },
      maybeSingle() {
        const selected = matched()[0] ?? null;
        if (mutation && selected) Object.assign(selected, mutation);
        const data = duplicateIgnored ? null : upserted ?? selected;
        return Promise.resolve({ data, error: null });
      },
      then<T>(resolve: (value: { data: Row[]; error: null; count?: number }) => T) {
        const data = matched();
        if (mutation) for (const row of data) Object.assign(row, mutation);
        return Promise.resolve({ data, error: null, ...(countOnly ? { count: data.length } : {}) }).then(resolve);
      },
    };
    return q;
  };
  return { db: { from } as unknown as SupabaseClient, tables };
}

const input = {
  eventId: "charge-1:payment_received:stripe-session-1",
  domain: "payment" as const,
  event: "payment_received",
  managerUserId: "manager-1",
  entityId: "charge-1",
  category: "payments" as const,
  senderUserId: "manager-1",
  senderEmail: "manager@example.com",
  recipients: [{
    audience: "resident" as const,
    userId: "resident-1",
    rendered: { subject: "Payment update", text: "Payment received." },
  }],
  now: new Date("2026-09-04T19:00:00.000Z"),
};

describe("action-event idempotent consumer", () => {
  beforeEach(() => deliver.mockClear());

  it("records and delivers the same event-recipient projection at most once", async () => {
    const { db, tables } = fakeDb();
    await emitActionEvent(db, input);
    await emitActionEvent(db, input);

    expect(tables.action_events).toHaveLength(1);
    expect(tables.action_event_deliveries).toHaveLength(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({
      eventCategory: "payments",
      messageId: "action-event:charge-1:payment_received:stripe-session-1:resident:resident-1",
    });
  });

  it("retries a due failed projection with the same deterministic message id", async () => {
    const { db, tables } = fakeDb();
    await emitActionEvent(db, input);
    Object.assign(tables.action_event_deliveries[0]!, {
      status: "failed",
      next_attempt_at: "2026-09-04T18:59:00.000Z",
    });

    const result = await retryDueActionEventDeliveries(db, { now: input.now });
    expect(result).toEqual({ attempted: 1, delivered: 1, failed: 0 });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[0]?.[1]?.messageId).toBe(deliver.mock.calls[1]?.[1]?.messageId);
    expect(tables.action_event_deliveries[0]?.status).toBe("delivered");
  });
});
