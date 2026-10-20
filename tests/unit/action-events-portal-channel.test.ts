import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Web vs Messages on the notice bus: the RESIDENT copy of an event for a request made in the portal is
 * delivered email + inbox with a /resident link and never as a text (quiet hours and retries included); the
 * manager's copy and a text-channel event are unchanged.
 */
const deliver = vi.fn(async () => ({ ok: true as const, recipientCount: 1 }));
vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalInboxMessage: (...args: unknown[]) => deliver(...(args as [])),
}));

const queueDraft = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/lib/action-event-draft-review.server", () => ({
  queueActionEventDraftForReview: (...args: unknown[]) => queueDraft(...(args as [])),
  queueTeamThreadDraftForReview: (...args: unknown[]) => queueDraft(...(args as [])),
}));

vi.mock("@/lib/automated-messages-settings.server", () => ({
  loadAutomatedMessageSettings: vi.fn(async () => ({})),
}));

vi.mock("@/lib/automation-send-mode.server", () => ({
  resolveAutomationSendModeForEvent: vi.fn(async () => ({ partyFacing: "auto", team: "auto" })),
}));

import { emitActionEvent, retryDueActionEventDeliveries } from "@/lib/action-events.server";

type Row = Record<string, unknown> & { id: string };

function fakeDb() {
  const tables: Record<string, Row[]> = { action_events: [], action_event_deliveries: [] };
  let sequence = 0;
  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    const rows = () => (tables[table] ??= []);
    const matched = () => rows().filter((f) => filters.every((filter) => filter(f)));
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
      order() {
        return q;
      },
      limit(limit: number) {
        return Promise.resolve({ data: matched().slice(0, limit), error: null });
      },
      upsert(payload: Record<string, unknown>, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        const keys = opts?.onConflict?.split(",") ?? ["id"];
        const existing = rows().find((row) => keys.every((key) => row[key] === payload[key]));
        if (existing && opts?.ignoreDuplicates) {
          upserted = null;
          duplicateIgnored = true;
        } else if (existing) upserted = Object.assign(existing, payload);
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
        return Promise.resolve({ data: duplicateIgnored ? null : upserted ?? selected, error: null });
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


const base = {
  domain: "application" as const,
  event: "application_approved",
  managerUserId: "owner-1",
  entityId: "A1",
  category: "applications" as const,
  senderUserId: "owner-1",
  senderEmail: "owner@proplane.test",
  senderName: "Ambika",
  recipients: [
    { audience: "resident" as const, userId: "res-1", email: "priya@example.com", rendered: { subject: "Approved", text: "Your application was approved.", smsText: "PropLane: approved" } },
    { audience: "manager" as const, userId: "owner-1", rendered: { subject: "You approved Priya", text: "You approved Priya's application." } },
  ],
};
// 1 am Pacific: inside quiet hours, so an ordinary text would be DEFERRED to the morning.
const quiet = new Date("2026-10-20T08:00:00.000Z");
const midday = new Date("2026-10-20T19:00:00.000Z");
const residentCall = () => deliver.mock.calls.map((c) => c[1] as unknown as Record<string, unknown>).find((o) => (o.toUserIds as string[] | undefined)?.includes("res-1"));

beforeEach(() => deliver.mockClear());

describe("a portal-channel resident copy is email + inbox, never a text", () => {
  it("hard-suppresses SMS, links the resident portal, and is delivered at once even in quiet hours", async () => {
    const { db, tables } = fakeDb();
    const result = await emitActionEvent(db, { ...base, eventId: "portal-quiet", channel: "portal", now: quiet });
    const call = residentCall()!;
    expect(call.suppressSms).toBe(true);
    expect(String(call.text)).toContain("https://proplane.ai/resident/applications");
    expect(String(call.text)).not.toMatch(/\/l\/|sms:|tel:/);
    const delivery = tables.action_event_deliveries.find((d) => d.audience === "resident")!;
    expect(delivery).toMatchObject({ status: "delivered", sms_deferred_until: null, next_attempt_at: null });
    expect(result.deferred).toBe(0);
    expect(tables.action_events[0]!.payload).toMatchObject({ __noticeChannel: "portal" });
  });

  it("a text-channel (or unstamped) event is exactly what it was: texts allowed by day, deferred in quiet hours", async () => {
    const day = fakeDb();
    await emitActionEvent(day.db, { ...base, eventId: "sms-day", now: midday });
    expect(residentCall()!.suppressSms).toBeFalsy();
    expect(String(residentCall()!.text)).toBe("Your application was approved.");
    expect(day.tables.action_events[0]!.payload).not.toHaveProperty("__noticeChannel");
    deliver.mockClear();
    const night = fakeDb();
    await emitActionEvent(night.db, { ...base, eventId: "sms-night", channel: "sms", now: quiet });
    expect(residentCall()!.suppressSms).toBe(true);
    expect(night.tables.action_event_deliveries.find((d) => d.audience === "resident")).toMatchObject({ status: "deferred" });
  });

  it("only the RESIDENT copy changes: the manager's copy is untouched by the channel", async () => {
    const { db } = fakeDb();
    await emitActionEvent(db, { ...base, eventId: "portal-manager", channel: "portal", now: midday });
    const manager = deliver.mock.calls.map((c) => c[1] as unknown as Record<string, unknown>).find((o) => String(o.subject) === "You approved Priya");
    expect(manager ?? {}).not.toHaveProperty("toUserIds", ["res-1"]);
    expect(String((manager?.text as string | undefined) ?? "")).not.toContain("See it in your portal");
  });

  it("a retry of a failed portal delivery keeps the channel (still no text)", async () => {
    const { db, tables } = fakeDb();
    deliver.mockResolvedValueOnce({ ok: false, error: "transport down" } as never);
    await emitActionEvent(db, { ...base, recipients: [base.recipients[0]!], eventId: "portal-retry", channel: "portal", now: midday });
    const row = tables.action_event_deliveries[0]!;
    expect(row).toMatchObject({ status: "failed" });
    deliver.mockClear();
    row.status = "pending";
    row.attempts = 0;
    await retryDueActionEventDeliveries(db, { now: new Date(String(row.next_attempt_at)) });
    const retried = deliver.mock.calls[0]![1] as unknown as Record<string, unknown>;
    expect(retried.suppressSms).toBe(true);
    expect(String(retried.text)).toContain("/resident/applications");
  });
});
