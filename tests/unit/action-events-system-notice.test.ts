import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A system notice is PropLane speaking for itself. The manager-automation rail
 * — the per-event on/off switch, the manager template, draft-for-review — must
 * not touch it: a vendor's "your account was restricted" cannot be muted,
 * rewritten or queued for someone's approval by a workspace that did not send
 * it. Both gates are stubbed HOSTILE here (event off, party-facing drafted), so
 * a regression that reconnects either one fails.
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
  loadAutomatedMessageSettings: vi.fn(async () => ({
    "vendor_banking:account_restricted:vendor": { enabled: false },
  })),
}));

vi.mock("@/lib/automation-send-mode.server", () => ({
  resolveAutomationSendModeForEvent: vi.fn(async () => ({ partyFacing: "draft", team: "draft" })),
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
  domain: "vendor_banking" as const,
  event: "account_restricted",
  managerUserId: "proplane-ops",
  entityId: "account:acct_1:restricted",
  category: "payments" as const,
  senderUserId: "proplane-ops",
  senderEmail: "founders@axis-seattle-housing.com",
  senderName: "PropLane",
  recipients: [
    {
      audience: "vendor" as const,
      userId: "vendor-1",
      rendered: { subject: "Your account was restricted", text: "Stripe restricted your account." },
    },
  ],
  // Midday Pacific: outside quiet hours, so nothing here is deferred for that reason.
  now: new Date("2026-10-06T19:00:00.000Z"),
};

beforeEach(() => {
  deliver.mockClear();
  queueDraft.mockClear();
});

describe("system notices bypass the manager-automation rail", () => {
  it("an ordinary event is still muted by the workspace's per-event switch", async () => {
    const { db, tables } = fakeDb();
    await emitActionEvent(db, { ...base, eventId: "ordinary" });
    expect(tables.action_event_deliveries).toHaveLength(0);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("a system notice sends immediately: not muted, not drafted", async () => {
    const { db, tables } = fakeDb();
    const result = await emitActionEvent(db, { ...base, eventId: "system", systemNotice: true });
    expect(result.delivered).toBe(1);
    expect(queueDraft).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(tables.action_event_deliveries[0]).toMatchObject({ draft_for_review: false, status: "delivered" });
  });

  it("a recipient that asks to be drafted is still sent: a notice no workspace owns is not approvable", async () => {
    const { db, tables } = fakeDb();
    await emitActionEvent(db, {
      ...base,
      eventId: "system-no-draft",
      systemNotice: true,
      recipients: [{ ...base.recipients[0]!, draftForReview: true }],
    });
    expect(queueDraft).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(tables.action_event_deliveries[0]).toMatchObject({ draft_for_review: false, status: "delivered" });
  });

  it("the copy that goes out is PropLane's own, never a manager's template", async () => {
    const { db } = fakeDb();
    await emitActionEvent(db, { ...base, eventId: "system-copy", systemNotice: true });
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({
      subject: "Your account was restricted",
      text: "Stripe restricted your account.",
    });
  });

  it("is marked on the stored event, so a retry of a failed first attempt is never turned into a draft", async () => {
    const { db, tables } = fakeDb();
    deliver.mockResolvedValueOnce({ ok: false, error: "transport down" } as never);
    await emitActionEvent(db, { ...base, eventId: "system-retry", systemNotice: true });
    const row = tables.action_event_deliveries[0]!;
    expect(row).toMatchObject({ status: "failed", attempts: 1 });
    expect(tables.action_events[0]?.payload).toMatchObject({ __systemNotice: true });

    row.status = "pending";
    row.attempts = 0;
    await retryDueActionEventDeliveries(db, { now: new Date(String(row.next_attempt_at)) });
    expect(queueDraft).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});
