import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
const google = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  connection: vi.fn(),
}));
vi.mock("@/lib/google-calendar/api.server", () => ({
  createGoogleCalendarEvent: google.create,
  updateGoogleCalendarEvent: google.update,
  deleteGoogleCalendarEvent: google.remove,
}));
vi.mock("@/lib/google-calendar/settings", () => ({ loadGoogleCalendarConnection: google.connection }));

import { persistPlannedEventGoogleCalendarId, syncPlannedTourToGoogleCalendar } from "@/lib/google-calendar/sync.server";

const EVENT = {
  id: "planned-tour-1",
  kind: "tour",
  title: "Tour · Jordan Lee",
  start: "2099-09-10T17:00:00.000Z",
  end: "2099-09-10T17:30:00.000Z",
  canceledAt: undefined,
  attendeePhone: "+12065550123",
};

describe("Google Calendar id persistence boundary", () => {
  beforeEach(() => {
    rpc.mockReset();
    google.create.mockReset();
    google.update.mockReset();
    google.remove.mockReset();
    google.connection.mockReset().mockResolvedValue({ connected: true, syncEnabled: true });
  });

  it("sends only identity, expected bounds, and the Google id to the lifecycle-safe RPC", async () => {
    rpc.mockResolvedValue({ data: { ok: true }, error: null });
    const db = { rpc };

    await expect(persistPlannedEventGoogleCalendarId(db as never, EVENT.id, "google-1", EVENT)).resolves.toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("persist_confirmed_tour_google_calendar_id", {
      p_planned_event_id: EVENT.id,
      p_google_calendar_event_id: "google-1",
      p_expected_start: EVENT.start,
      p_expected_end: EVENT.end,
    });
  });

  it.each([
    [{ ok: false, reason: "cancelled" }, { ok: false, reason: "cancelled" }],
    [{ ok: false, reason: "changed" }, { ok: false, reason: "changed" }],
    [{ ok: false, reason: "missing" }, { ok: false, reason: "missing" }],
  ])("propagates a lifecycle race without falling back to a whole-event patch", async (payload, expected) => {
    rpc.mockResolvedValue({ data: payload, error: null });
    await expect(persistPlannedEventGoogleCalendarId({ rpc } as never, EVENT.id, "google-1", EVENT)).resolves.toEqual(expected);
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("fails closed when the expected event bounds are absent", async () => {
    await expect(persistPlannedEventGoogleCalendarId({ rpc } as never, EVENT.id, "google-1", undefined)).resolves.toEqual({ ok: false, reason: "missing" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("records a durable cleanup obligation when cancellation wins after remote insert", async () => {
    google.create.mockResolvedValue("google-cancel-1");
    google.remove.mockRejectedValue(new Error("Google delete transient failure"));
    rpc.mockImplementation(async (name: string) => {
      if (name === "begin_prospect_tour_google_calendar_create") return { data: { allowed: true, generation: "00000000-0000-4000-8000-000000000001" }, error: null };
      if (name === "persist_confirmed_tour_google_calendar_id") return { data: { ok: false, reason: "cancelled" }, error: null };
      if (name === "settle_prospect_tour_google_calendar_create") return { data: { ok: true, state: "reconciled" }, error: null };
      if (name === "enqueue_prospect_tour_google_calendar_cleanup") return { data: null, error: null };
      return { data: null, error: null };
    });
    const updates: Record<string, unknown>[] = [];
    const db = {
      rpc,
      from: vi.fn((table: string) => {
        const query: Record<string, unknown> = {};
        const self = () => query;
        query.update = (values: Record<string, unknown>) => { updates.push({ table, ...values }); return query; };
        query.eq = self;
        query.in = self;
        query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve);
        return query;
      }),
    };

    await expect(syncPlannedTourToGoogleCalendar(db as never, "manager-jain", {
      plannedEventId: "planned-cancel-1",
      title: "Tour",
      start: EVENT.start,
      end: EVENT.end,
    })).rejects.toThrow("Google delete transient failure");

    expect(google.create).toHaveBeenCalledOnce();
    expect(google.remove).toHaveBeenCalledWith(db, "manager-jain", "google-cancel-1");
    expect(rpc).toHaveBeenCalledWith("enqueue_prospect_tour_google_calendar_cleanup", {
      p_manager_user_id: "manager-jain",
      p_planned_event_id: "planned-cancel-1",
      p_google_calendar_event_id: "google-cancel-1",
    });
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "prospect_tour_google_calendar_cleanup", status: "pending", last_error: "Google delete transient failure" }),
    ]));
  });

  it("records a create intent before Google insert and settles it only after lifecycle-safe persistence", async () => {
    google.create.mockResolvedValue("google-created-1");
    rpc.mockImplementation(async (name: string) => {
      if (name === "begin_prospect_tour_google_calendar_create") return { data: { allowed: true, generation: "00000000-0000-4000-8000-000000000002" }, error: null };
      if (name === "persist_confirmed_tour_google_calendar_id") return { data: { ok: true }, error: null };
      if (name === "settle_prospect_tour_google_calendar_create") return { data: { ok: true, state: "settled" }, error: null };
      return { data: null, error: null };
    });

    await expect(syncPlannedTourToGoogleCalendar({ rpc } as never, "manager-jain", {
      plannedEventId: EVENT.id,
      title: EVENT.title,
      start: EVENT.start,
      end: EVENT.end,
    })).resolves.toBe("google-created-1");

    const calls = rpc.mock.calls.map(([name]) => name);
    expect(calls.indexOf("begin_prospect_tour_google_calendar_create")).toBeLessThan(calls.indexOf("persist_confirmed_tour_google_calendar_id"));
    expect(calls.indexOf("persist_confirmed_tour_google_calendar_id")).toBeLessThan(calls.indexOf("settle_prospect_tour_google_calendar_create"));
    expect(google.create).toHaveBeenCalledOnce();
  });

  it("does not issue Google create when the durable intent says an earlier generation is still in flight", async () => {
    rpc.mockResolvedValue({ data: { allowed: false, reason: "in_flight" }, error: null });

    await expect(syncPlannedTourToGoogleCalendar({ rpc } as never, "manager-jain", {
      plannedEventId: EVENT.id,
      title: EVENT.title,
      start: EVENT.start,
      end: EVENT.end,
    })).resolves.toBeNull();

    expect(rpc).toHaveBeenCalledWith("begin_prospect_tour_google_calendar_create", expect.objectContaining({
      p_planned_event_id: EVENT.id,
      p_expected_start: EVENT.start,
      p_expected_end: EVENT.end,
    }));
    expect(google.create).not.toHaveBeenCalled();
  });
});
