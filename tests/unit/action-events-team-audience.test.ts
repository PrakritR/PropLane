import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const deliver = vi.fn(async () => ({ ok: true as const, recipientCount: 1, emailOutcomes: [], smsOutcomes: [] }));
vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalInboxMessage: (...args: unknown[]) => deliver(...(args as [])),
}));

// Automated notices go to each person's PropLane Assistant, never into the Team chat.
const notifyScoped = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({
  notifyPropertyScopedManagersFromAgent: (...args: unknown[]) => notifyScoped(...args),
}));
const postTeamThreadMessage = vi.fn(async () => ({ ok: true as const, posted: true }));
vi.mock("@/lib/team-comms.server", () => ({
  postTeamThreadMessage: (...args: unknown[]) => postTeamThreadMessage(...(args as [])),
}));

const queueActionEventDraftForReview = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/lib/action-event-draft-review.server", () => ({
  queueActionEventDraftForReview: (...args: unknown[]) => queueActionEventDraftForReview(...(args as [])),
}));

import { emitActionEvent, teammateNoticeText } from "@/lib/action-events.server";

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

describe("action-events: notices reach the team through each person's Assistant", () => {
  beforeEach(() => {
    notifyScoped.mockClear();
    notifyScoped.mockResolvedValue(undefined);
    postTeamThreadMessage.mockClear();
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
    payload: { propertyId: "house-1" },
    now: new Date("2026-09-16T20:00:00.000Z"),
  };

  it("a manager's own copy fans out to the owner AND the teammates with the house (module from the domain), with a teammate-voiced line, and posts nothing to the Team chat", async () => {
    const { db, tables } = fakeDb();
    const result = await emitActionEvent(db, {
      ...baseInput,
      recipients: [
        { audience: "manager", userId: "owner-1", rendered: { subject: "Approved", text: "You approved Alex's application." } },
      ],
    });
    expect(result.delivered).toBe(1);
    expect(notifyScoped).toHaveBeenCalledTimes(1);
    expect(notifyScoped.mock.calls[0]![1]).toMatchObject({
      ownerManagerUserId: "owner-1",
      propertyId: "house-1",
      module: "applications",
      subject: "Approved",
      text: "You approved Alex's application.",
      teammateText: "Owner approved Alex's application.",
      threadType: "action_event",
      idempotencyKey: "action-event:app-1:application_approved:approved:manager",
    });
    expect(postTeamThreadMessage).not.toHaveBeenCalled();
    expect(tables.action_event_deliveries[0]!.status).toBe("delivered");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("marks the delivery failed and retryable when the owner's notice fails", async () => {
    notifyScoped.mockRejectedValueOnce(new Error("Manager SMS was not accepted for delivery."));
    const { db, tables } = fakeDb();
    const result = await emitActionEvent(db, {
      ...baseInput,
      recipients: [{ audience: "manager", userId: "owner-1", rendered: { subject: "Approved", text: "You approved Alex's application." } }],
    });
    expect(result.failed).toBe(1);
    expect(tables.action_event_deliveries[0]!.status).toBe("failed");
    expect(tables.action_event_deliveries[0]!.next_attempt_at).toBeTruthy();
  });

  it("a team-only event (tour claimed) is the same fan-out, minus the person who acted, and still never a Team chat line", async () => {
    const { db, tables } = fakeDb();
    const result = await emitActionEvent(db, {
      ...baseInput,
      eventId: "tour-1:claimed",
      domain: "tour" as const,
      event: "claimed",
      category: "leases" as const,
      senderUserId: "host-1",
      recipients: [{ audience: "team", userId: "owner-1", rendered: { subject: "Tour claimed", text: "Host claimed the tour." } }],
    });
    expect(result.delivered).toBe(1);
    expect(notifyScoped.mock.calls[0]![1]).toMatchObject({
      ownerManagerUserId: "owner-1",
      propertyId: "house-1",
      module: "calendar",
      idempotencyKey: "action-event:tour-1:claimed:team",
      excludeUserIds: ["host-1"],
    });
    expect(postTeamThreadMessage).not.toHaveBeenCalled();
    expect(tables.action_event_deliveries[0]!.status).toBe("delivered");
  });

  it("a team copy for a person who also has a manager copy is the same notice twice: only one fan-out", async () => {
    const { db, tables } = fakeDb();
    const result = await emitActionEvent(db, {
      ...baseInput,
      recipients: [
        { audience: "manager", userId: "owner-1", rendered: { subject: "Approved", text: "You approved Alex's application." } },
        { audience: "team", userId: "owner-1", rendered: { subject: "Approved", text: "I approved Alex's application." } },
      ],
    });
    expect(result.delivered).toBe(1);
    expect(notifyScoped).toHaveBeenCalledTimes(1);
    expect(tables.action_event_deliveries).toHaveLength(1);
  });

  it("when a TEAMMATE acted, the owner gets the normal message and the other teammates hear it, never the actor", async () => {
    const { db } = fakeDb();
    await emitActionEvent(db, {
      ...baseInput,
      senderUserId: "mate-1",
      senderName: "Prakrit",
      recipients: [{ audience: "manager", userId: "owner-1", rendered: { subject: "Approved", text: "You approved Alex's application." } }],
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(notifyScoped).toHaveBeenCalledTimes(1);
    expect(notifyScoped.mock.calls[0]![1]).toMatchObject({
      ownerManagerUserId: "owner-1",
      text: "Prakrit approved Alex's application.",
      excludeUserIds: ["owner-1", "mate-1"],
    });
  });

  it("teammateNoticeText turns the owner's second person into the actor's name and nothing else", () => {
    expect(teammateNoticeText("You signed the lease. It is waiting on Jo.", "Ambika")).toBe("Ambika signed the lease. It is waiting on Jo.");
    expect(teammateNoticeText("Jo signed the lease. It is waiting on your countersignature.", "Ambika")).toBe(
      "Jo signed the lease. It is waiting on the countersignature.",
    );
    expect(teammateNoticeText("You approved it", undefined)).toBe("A teammate approved it");
    expect(teammateNoticeText("$1,000.00 was received.", "Ambika")).toBe("$1,000.00 was received.");
    expect(teammateNoticeText("Your payment arrived", "Ambika")).toBe("Your payment arrived");
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
