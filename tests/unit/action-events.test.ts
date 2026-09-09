import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const deliver = vi.fn(async () => ({ ok: true as const, recipientCount: 1 }));
vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalInboxMessage: (...args: unknown[]) => deliver(...(args as [])),
}));

import { emitActionEvent, retryDueActionEventDeliveries } from "@/lib/action-events.server";

type Row = Record<string, unknown> & { id: string };

function fakeDb(opts: { failClaim?: boolean; failFinalize?: boolean } = {}) {
  const tables: Record<string, Row[]> = { action_events: [], action_event_deliveries: [] };
  const claimDeadlines: string[] = [];
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
        if (opts.failClaim && table === "action_event_deliveries" && mutation?.next_attempt_at && !mutation.status) {
          return Promise.resolve({ data: null, error: { message: "claim unavailable" } });
        }
        if (opts.failFinalize && table === "action_event_deliveries" && mutation?.status) {
          return Promise.resolve({ data: null, error: { message: "finalize unavailable" } });
        }
        const selected = matched()[0] ?? null;
        if (table === "action_event_deliveries" && selected && mutation?.next_attempt_at && !mutation.status) {
          claimDeadlines.push(String(mutation.next_attempt_at));
        }
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
  return { db: { from } as unknown as SupabaseClient, tables, claimDeadlines };
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

  it("preserves the scheduled retry time when quiet hours defer only SMS", async () => {
    const { db, tables } = fakeDb();
    await emitActionEvent(db, { ...input, eventId: "quiet-event", now: new Date("2026-09-04T08:00:00.000Z") });
    expect(tables.action_event_deliveries[0]).toMatchObject({ status: "deferred" });
    expect(String(tables.action_event_deliveries[0]?.next_attempt_at)).not.toBe("");
    expect(tables.action_event_deliveries[0]?.next_attempt_at).not.toBeNull();
  });

  it("retries failed email during quiet hours and preserves the deferred SMS without resending email", async () => {
    const { db, tables } = fakeDb();
    const quietNow = new Date("2026-09-04T08:00:00.000Z");
    deliver.mockResolvedValueOnce({
      ok: true,
      recipientCount: 1,
      emailOutcomes: [{ recipientEmail: "resident@example.com", status: "failed" }],
      smsOutcomes: [],
    } as never);
    await emitActionEvent(db, { ...input, eventId: "quiet-email-failure", now: quietNow });
    const row = tables.action_event_deliveries[0]!;
    const retainedDue = String(row.sms_deferred_until);
    expect(row).toMatchObject({ status: "channels_failed", delivered_at: null });
    expect(Date.parse(retainedDue)).toBeGreaterThan(quietNow.getTime());
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ suppressSms: true });

    const firstEmailRetryAt = String(row.next_attempt_at);
    deliver.mockResolvedValueOnce({ ok: false, error: "email transport unavailable" } as never);
    await retryDueActionEventDeliveries(db, { now: new Date(firstEmailRetryAt) });
    expect(deliver.mock.calls[1]?.[1]).toMatchObject({ suppressSms: true, suppressInbox: true });
    expect(row).toMatchObject({ status: "channels_failed", sms_deferred_until: retainedDue, delivered_at: null });

    const secondEmailRetryAt = String(row.next_attempt_at);
    deliver.mockResolvedValueOnce({
      ok: true,
      recipientCount: 1,
      emailOutcomes: [{ recipientEmail: "resident@example.com", status: "submitted" }],
      smsOutcomes: [],
    } as never);
    await retryDueActionEventDeliveries(db, { now: new Date(secondEmailRetryAt) });
    expect(deliver.mock.calls[2]?.[1]).toMatchObject({ suppressSms: true, suppressInbox: true });
    expect(row).toMatchObject({ status: "deferred", next_attempt_at: retainedDue, sms_deferred_until: null, delivered_at: null });

    deliver.mockResolvedValueOnce({
      ok: true,
      recipientCount: 1,
      emailOutcomes: [{ recipientEmail: "resident@example.com", status: "skipped" }],
      smsOutcomes: [{ recipientEmail: "resident@example.com", status: "queued" }],
    } as never);
    await retryDueActionEventDeliveries(db, { now: new Date(retainedDue) });
    expect(deliver.mock.calls[3]?.[1]).toMatchObject({ suppressEmail: true, suppressInbox: true });
    expect(row).toMatchObject({ status: "submitted", delivered_at: null });
  });

  it("does not turn an ordinary email-only retry into a second SMS attempt", async () => {
    const { db, tables } = fakeDb();
    await emitActionEvent(db, input);
    const row = tables.action_event_deliveries[0]!;
    Object.assign(row, {
      status: "email_failed",
      next_attempt_at: "2026-09-04T18:59:00.000Z",
      sms_deferred_until: null,
      delivered_at: null,
    });
    deliver.mockClear().mockResolvedValueOnce({
      ok: true,
      recipientCount: 1,
      emailOutcomes: [{ recipientEmail: "resident@example.com", status: "failed" }],
      smsOutcomes: [{ recipientEmail: "resident@example.com", status: "skipped" }],
    } as never);
    await retryDueActionEventDeliveries(db, { now: input.now });
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ suppressSms: true, suppressInbox: true });
    expect(row).toMatchObject({ status: "email_failed", sms_deferred_until: null });
  });

  it("does not send SMS early when the whole initial quiet-hours delivery throws", async () => {
    const { db, tables } = fakeDb();
    const quietNow = new Date("2026-09-04T08:00:00.000Z");
    deliver.mockResolvedValueOnce({ ok: false, error: "inbox unavailable" } as never);
    await emitActionEvent(db, { ...input, eventId: "quiet-total-failure", now: quietNow });
    const row = tables.action_event_deliveries[0]!;
    const retainedDue = String(row.sms_deferred_until);
    expect(row.status).toBe("failed");

    deliver.mockResolvedValueOnce({ ok: true, recipientCount: 1, emailOutcomes: [{ status: "submitted" }], smsOutcomes: [] } as never);
    await retryDueActionEventDeliveries(db, { now: new Date(String(row.next_attempt_at)) });
    expect(deliver.mock.calls[1]?.[1]).toMatchObject({ suppressSms: true, suppressInbox: false });
    expect(row).toMatchObject({ status: "deferred", next_attempt_at: retainedDue, sms_deferred_until: null });
  });

  it("counts provider-accepted SMS as submitted rather than delivered or failed", async () => {
    const { db } = fakeDb();
    deliver.mockResolvedValueOnce({
      ok: true, recipientCount: 1, emailOutcomes: [{ status: "submitted" }], smsOutcomes: [{ status: "queued" }],
    } as never);
    await expect(emitActionEvent(db, { ...input, eventId: "accepted-sms" })).resolves.toMatchObject({
      delivered: 0, submitted: 1, failed: 0,
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
    expect(result).toEqual({ attempted: 1, delivered: 1, submitted: 0, failed: 0 });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[0]?.[1]?.messageId).toBe(deliver.mock.calls[1]?.[1]?.messageId);
    expect(tables.action_event_deliveries[0]?.status).toBe("delivered");
  });

  it("delivers an atomically enqueued pending projection", async () => {
    const { db, tables } = fakeDb();
    await emitActionEvent(db, input);
    Object.assign(tables.action_event_deliveries[0]!, {
      status: "pending", next_attempt_at: "2026-09-04T18:59:00.000Z", delivered_at: null,
    });
    deliver.mockClear();
    await expect(retryDueActionEventDeliveries(db, { now: input.now }))
      .resolves.toEqual({ attempted: 1, delivered: 1, submitted: 0, failed: 0 });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("fails loudly when claim or final marker persistence is unavailable", async () => {
    for (const option of [{ failClaim: true }, { failFinalize: true }]) {
      const { db, tables } = fakeDb(option);
      await emitActionEvent(db, input);
      Object.assign(tables.action_event_deliveries[0]!, { status: "pending", next_attempt_at: "2026-09-04T18:59:00.000Z" });
      await expect(retryDueActionEventDeliveries(db, { now: input.now })).rejects.toThrow(/action-event delivery/i);
    }
  });

  it("does not let a stale finalizer count or overwrite a newer worker", async () => {
    const { db, tables } = fakeDb();
    await emitActionEvent(db, input);
    const row = tables.action_event_deliveries[0]!;
    Object.assign(row, { status: "pending", next_attempt_at: "2026-09-04T18:59:00.000Z", delivered_at: null });
    deliver.mockClear().mockImplementationOnce(async () => {
      Object.assign(row, { status: "delivered", next_attempt_at: null, delivered_at: "2026-09-04T19:00:01.000Z" });
      return { ok: true as const, recipientCount: 1 };
    });
    await expect(retryDueActionEventDeliveries(db, { now: input.now }))
      .resolves.toEqual({ attempted: 1, delivered: 0, submitted: 0, failed: 0 });
    expect(row.status).toBe("delivered");
  });

  it("starts a fresh claim lease for later rows after a slow delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T19:00:00.000Z"));
    const { db, tables, claimDeadlines } = fakeDb();
    await emitActionEvent(db, input);
    const first = tables.action_event_deliveries[0]!;
    Object.assign(first, { status: "pending", next_attempt_at: "2026-09-04T18:59:00.000Z" });
    tables.action_event_deliveries.push({ ...first, id: "delivery-2", recipient_key: "resident-2" });
    deliver.mockClear()
      .mockImplementationOnce(async () => {
        vi.setSystemTime(new Date("2026-09-04T19:04:00.000Z"));
        return { ok: true as const, recipientCount: 1 };
      })
      .mockResolvedValueOnce({ ok: true as const, recipientCount: 1 });
    await retryDueActionEventDeliveries(db);
    expect(claimDeadlines).toEqual(["2026-09-04T19:05:00.000Z", "2026-09-04T19:09:00.000Z"]);
    vi.useRealTimers();
  });

  it("retries only SMS after a partial SMS failure and records accepted SMS as submitted", async () => {
    const { db, tables } = fakeDb();
    await emitActionEvent(db, input);
    const row = tables.action_event_deliveries[0]!;
    Object.assign(row, { status: "pending", next_attempt_at: "2026-09-04T18:59:00.000Z" });
    deliver.mockClear().mockResolvedValueOnce({
      ok: true, recipientCount: 1, smsOutcomes: [{ recipientEmail: "resident@example.com", status: "failed" }],
    } as never);
    await expect(retryDueActionEventDeliveries(db, { now: input.now })).resolves.toEqual({ attempted: 1, delivered: 0, submitted: 0, failed: 1 });
    expect(row).toMatchObject({ status: "sms_failed", delivered_at: null });

    row.next_attempt_at = "2026-09-04T18:59:00.000Z";
    deliver.mockResolvedValueOnce({ ok: false, error: "recipient lookup unavailable" } as never);
    await expect(retryDueActionEventDeliveries(db, { now: input.now })).resolves.toEqual({ attempted: 1, delivered: 0, submitted: 0, failed: 1 });
    expect(deliver.mock.calls[1]?.[1]).toMatchObject({ suppressEmail: true, suppressInbox: true });
    expect(row.status).toBe("sms_failed");

    row.next_attempt_at = "2026-09-04T18:59:00.000Z";
    deliver.mockResolvedValueOnce({
      ok: true, recipientCount: 1, smsOutcomes: [{ recipientEmail: "resident@example.com", status: "queued" }],
    } as never);
    await expect(retryDueActionEventDeliveries(db, { now: input.now })).resolves.toEqual({ attempted: 1, delivered: 0, submitted: 1, failed: 0 });
    expect(deliver.mock.calls[2]?.[1]).toMatchObject({ suppressEmail: true, suppressInbox: true });
    expect(row).toMatchObject({ status: "submitted", delivered_at: null });
  });
});
