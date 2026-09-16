import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const deliver = vi.fn(async () => ({ ok: true as const, recipientCount: 1, emailOutcomes: [], smsOutcomes: [] }));
vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalInboxMessage: (...args: unknown[]) => deliver(...(args as [])),
}));

const postTeamThreadMessage = vi.fn(async () => ({ ok: true as const, posted: true }));
const mirrorTeamThreadMessageToSms = vi.fn(async () => []);
vi.mock("@/lib/team-comms.server", () => ({
  postTeamThreadMessage: (...args: unknown[]) => postTeamThreadMessage(...(args as [])),
  mirrorTeamThreadMessageToSms: (...args: unknown[]) => mirrorTeamThreadMessageToSms(...(args as [])),
}));

const queueActionEventDraftForReview = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/lib/action-event-draft-review.server", () => ({
  queueActionEventDraftForReview: (...args: unknown[]) => queueActionEventDraftForReview(...(args as [])),
}));

import { emitActionEvent } from "@/lib/action-events.server";

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
      eq(column: string, value: unknown) { filters.push((row) => row[column] === value); return q; },
      gte(column: string, value: string) { filters.push((row) => String(row[column] ?? "") >= value); return q; },
      lte() { return q; },
      in(column: string, values: unknown[]) { filters.push((row) => values.includes(row[column])); return q; },
      order() { return q; },
      limit(limit: number) { return Promise.resolve({ data: matched().slice(0, limit), error: null }); },
      upsert(payload: Record<string, unknown>, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        const keys = opts?.onConflict?.split(",") ?? ["id"];
        const existing = rows().find((row) => keys.every((key) => row[key] === payload[key]));
        if (existing && opts?.ignoreDuplicates) { upserted = null; duplicateIgnored = true; }
        else if (existing) upserted = Object.assign(existing, payload);
        else {
          upserted = { id: `${table}-${++sequence}`, created_at: new Date().toISOString(), attempts: 0, ...payload } as Row;
          rows().push(upserted);
        }
        return q;
      },
      update(payload: Record<string, unknown>) { mutation = payload; return q; },
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

describe("action-events: team audience (WS5)", () => {
  beforeEach(() => {
    postTeamThreadMessage.mockClear();
    mirrorTeamThreadMessageToSms.mockClear();
    deliver.mockClear();
    queueActionEventDraftForReview.mockClear();
  });

  const baseInput = {
    eventId: "app-1:application_approved:approved",
    domain: "application" as const,
    event: "application_approved",
    managerUserId: "owner-1",
    entityId: "app-1",
    category: "applications" as const,
    senderUserId: "owner-1",
    senderEmail: "owner@example.com",
    senderName: "Owner",
    now: new Date("2026-09-16T20:00:00.000Z"),
  };

  it("posts once to the team thread and mirrors to SMS, and finalizes the delivery as delivered", async () => {
    const { db, tables } = fakeDb();
    const result = await emitActionEvent(db, {
      ...baseInput,
      recipients: [
        { audience: "team", userId: "owner-1", rendered: { subject: "Approved", text: "I approved Alex's application." } },
      ],
    });
    expect(result.delivered).toBe(1);
    expect(postTeamThreadMessage).toHaveBeenCalledTimes(1);
    expect(postTeamThreadMessage).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        ownerManagerUserId: "owner-1",
        actorUserId: "owner-1",
        actorName: "Owner",
        messageId: "action-event:app-1:application_approved:approved:team:owner-1",
      }),
    );
    expect(mirrorTeamThreadMessageToSms).toHaveBeenCalledTimes(1);
    expect(tables.action_event_deliveries[0]!.status).toBe("delivered");
    expect(deliver).not.toHaveBeenCalled(); // team never goes through the person-inbox delivery path
  });

  it("marks the delivery failed and retryable when the team-thread post fails", async () => {
    postTeamThreadMessage.mockResolvedValueOnce({ ok: false, error: "Could not post to the team thread." });
    const { db, tables } = fakeDb();
    const result = await emitActionEvent(db, {
      ...baseInput,
      recipients: [
        { audience: "team", userId: "owner-1", rendered: { subject: "Approved", text: "I approved Alex's application." } },
      ],
    });
    expect(result.failed).toBe(1);
    expect(tables.action_event_deliveries[0]!.status).toBe("failed");
    expect(tables.action_event_deliveries[0]!.next_attempt_at).toBeTruthy();
  });

  it("a failed SMS mirror never fails the team-thread post itself", async () => {
    mirrorTeamThreadMessageToSms.mockRejectedValueOnce(new Error("sms down"));
    const { db, tables } = fakeDb();
    const result = await emitActionEvent(db, {
      ...baseInput,
      recipients: [
        { audience: "team", userId: "owner-1", rendered: { subject: "Approved", text: "I approved Alex's application." } },
      ],
    });
    expect(result.delivered).toBe(1);
    expect(tables.action_event_deliveries[0]!.status).toBe("delivered");
  });

  it("draft-for-review queues a resident recipient as a pending draft instead of sending, and never retries into a real send", async () => {
    const { db, tables } = fakeDb();
    const result = await emitActionEvent(db, {
      ...baseInput,
      recipients: [
        {
          audience: "resident",
          email: "resident@example.com",
          rendered: { subject: "Approved", text: "Your application was approved." },
          draftForReview: true,
        },
      ],
    });
    expect(result.delivered).toBe(1);
    expect(queueActionEventDraftForReview).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(tables.action_event_deliveries[0]!.draft_for_review).toBe(true);
    expect(tables.action_event_deliveries[0]!.status).toBe("delivered");
  });

  it("a resident recipient WITHOUT draftForReview sends immediately as before (no behavior change)", async () => {
    const { db, tables } = fakeDb();
    const result = await emitActionEvent(db, {
      ...baseInput,
      recipients: [
        { audience: "resident", email: "resident@example.com", rendered: { subject: "Approved", text: "Your application was approved." } },
      ],
    });
    expect(result.delivered).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(queueActionEventDraftForReview).not.toHaveBeenCalled();
    expect(tables.action_event_deliveries[0]!.draft_for_review).toBe(false);
  });
});
