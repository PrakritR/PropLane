import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const deliver = vi.fn(async () => ({ ok: true as const, recipientCount: 1, emailOutcomes: [], smsOutcomes: [] }));
vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalInboxMessage: (...args: unknown[]) => deliver(...(args as [])),
}));

// The owner gets their Assistant notice; the team gets ONE PropLane line.
const notifyScoped = vi.fn(async (..._args: unknown[]) => undefined);
const postTeamNoticeLineForEvent = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({
  notifyPropertyScopedManagersFromAgent: (...args: unknown[]) => notifyScoped(...args),
  postTeamNoticeLineForEvent: (...args: unknown[]) => postTeamNoticeLineForEvent(...args),
}));
const postTeamThreadMessage = vi.fn(async () => ({ ok: true as const, posted: true }));
vi.mock("@/lib/team-comms.server", () => ({
  postTeamThreadMessage: (...args: unknown[]) => postTeamThreadMessage(...(args as [])),
}));

const queueActionEventDraftForReview = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/lib/action-event-draft-review.server", () => ({
  queueActionEventDraftForReview: (...args: unknown[]) => queueActionEventDraftForReview(...(args as [])),
}));

import { emitActionEvent, teamChatSkipsRoutineEvent } from "@/lib/action-events.server";

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


describe("Team chat skips routine booking events", () => {
  beforeEach(() => {
    notifyScoped.mockClear();
    postTeamNoticeLineForEvent.mockClear();
    postTeamThreadMessage.mockClear();
  });

  const input = (event: string, domain = "channel_booking") => ({
    eventId: `b-1:${event}`,
    domain: domain as "channel_booking",
    event,
    managerUserId: "owner-1",
    entityId: "b-1",
    category: "tours" as const,
    senderUserId: "owner-1",
    senderEmail: "owner@example.com",
    senderName: "Owner",
    payload: { propertyId: "house-1", guestLabel: "Alex Kim", propertyLabel: "Maple" },
    now: new Date("2026-09-16T20:00:00.000Z"),
  });
  const owner = [{ audience: "manager" as const, userId: "owner-1", rendered: { subject: "Booking", text: "You have a booking." } }];
  const mate = [{ audience: "manager" as const, userId: "mate-1", rendered: { subject: "Booking", text: "Owner has a booking." } }];

  it.each(["booking_created", "booking_cancelled", "channel_booking_created", "channel_booking_cancelled"])(
    "%s: owner Assistant notice stays, no Team line (not derived either)",
    async (event) => {
      expect(teamChatSkipsRoutineEvent("channel_booking", event)).toBe(true);
      const { db } = fakeDb();
      await emitActionEvent(db, { ...input(event), recipients: owner });
      expect(notifyScoped).toHaveBeenCalledTimes(1);
      const call = notifyScoped.mock.calls[0]![1] as Record<string, unknown>;
      expect(call).toMatchObject({ idempotencyKey: `action-event:b-1:${event}:manager`, subject: "Booking" });
      expect(call.teamNotice).toBeUndefined();
      expect(call.noTeamNotice).toBe(true);

      await emitActionEvent(db, { ...input(`${event}-mate`), event, recipients: mate });
      expect(postTeamNoticeLineForEvent.mock.calls.every((c) => (c[1] as { teamNotice: unknown }).teamNotice === null)).toBe(true);
    },
  );

  it.each(["channel_booking_clash", "channel_sync_failed"])("%s still posts a Team line", async (event) => {
    expect(teamChatSkipsRoutineEvent("channel_booking", event)).toBe(false);
    const { db } = fakeDb();
    await emitActionEvent(db, { ...input(event), recipients: owner });
    const call = notifyScoped.mock.calls[0]![1] as { teamNotice?: { messageId: string }; noTeamNotice?: boolean };
    expect(call.teamNotice?.messageId).toBe(`action-event:b-1:${event}:team`);
    expect(call.noTeamNotice).toBeUndefined();
  });

  it("a non-booking domain is unchanged", async () => {
    const { db } = fakeDb();
    await emitActionEvent(db, { ...input("work_order_created", "work_order"), recipients: owner });
    const call = notifyScoped.mock.calls[0]![1] as { teamNotice?: { messageId: string } };
    expect(call.teamNotice?.messageId).toBe("action-event:b-1:work_order_created:team");
    expect(teamChatSkipsRoutineEvent("work_order", "booking_created")).toBe(false);
  });
});
