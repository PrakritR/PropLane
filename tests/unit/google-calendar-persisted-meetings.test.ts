import { describe, expect, it } from "vitest";

import { loadPersistedGoogleMeetings } from "@/lib/google-calendar/persisted-meetings.server";

/** A fake `portal_schedule_records` table scoped exactly like the real query: select → eq → eq. */
function fakeDb(rows: Array<Record<string, unknown>>) {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col1: string, _val1: string) => ({
          eq: async (_col2: string, _val2: string) => ({ data: rows, error: null }),
        }),
      }),
    }),
  } as never;
}

describe("loadPersistedGoogleMeetings", () => {
  it("maps a persisted row into the same shape a live GoogleCalendarApiEvent has", async () => {
    const db = fakeDb([
      {
        row_data: {
          googleEventId: "g-1",
          summary: "Dentist",
          start: "2030-01-07T17:00:00.000Z",
          end: "2030-01-07T18:00:00.000Z",
          transparency: "opaque",
          declinedBySelf: false,
          allDay: false,
          eventType: null,
        },
        starts_at: "2030-01-07T17:00:00.000Z",
        ends_at: "2030-01-07T18:00:00.000Z",
      },
    ]);

    const events = await loadPersistedGoogleMeetings(
      db,
      "mgr-1",
      "2030-01-07T00:00:00.000Z",
      "2030-01-08T00:00:00.000Z",
    );

    expect(events).toEqual([
      {
        id: "g-1",
        summary: "Dentist",
        description: undefined,
        start: "2030-01-07T17:00:00.000Z",
        end: "2030-01-07T18:00:00.000Z",
        transparency: "opaque",
        declinedBySelf: false,
        allDay: false,
        eventType: undefined,
      },
    ]);
  });

  it("drops rows outside the requested window", async () => {
    const db = fakeDb([
      {
        row_data: { googleEventId: "g-out", start: "2030-01-01T10:00:00.000Z", end: "2030-01-01T11:00:00.000Z" },
        starts_at: "2030-01-01T10:00:00.000Z",
        ends_at: "2030-01-01T11:00:00.000Z",
      },
      {
        row_data: { googleEventId: "g-in", start: "2030-01-07T10:00:00.000Z", end: "2030-01-07T11:00:00.000Z" },
        starts_at: "2030-01-07T10:00:00.000Z",
        ends_at: "2030-01-07T11:00:00.000Z",
      },
    ]);

    const events = await loadPersistedGoogleMeetings(
      db,
      "mgr-1",
      "2030-01-07T00:00:00.000Z",
      "2030-01-08T00:00:00.000Z",
    );

    expect(events.map((e) => e.id)).toEqual(["g-in"]);
  });

  it("skips rows missing an id, start, or end rather than throwing", async () => {
    const db = fakeDb([
      { row_data: { summary: "No id" }, starts_at: null, ends_at: null },
      { row_data: { googleEventId: "g-2" }, starts_at: null, ends_at: null },
    ]);
    const events = await loadPersistedGoogleMeetings(
      db,
      "mgr-1",
      "2030-01-07T00:00:00.000Z",
      "2030-01-08T00:00:00.000Z",
    );
    expect(events).toEqual([]);
  });

  it("fails soft (empty list) rather than throwing on a query error", async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: async () => ({ data: null, error: { message: "boom" } }),
          }),
        }),
      }),
    } as never;
    await expect(
      loadPersistedGoogleMeetings(db, "mgr-1", "2030-01-07T00:00:00.000Z", "2030-01-08T00:00:00.000Z"),
    ).resolves.toEqual([]);
  });

  it("returns empty for a blank manager id without querying", async () => {
    const events = await loadPersistedGoogleMeetings(
      {} as never,
      "  ",
      "2030-01-07T00:00:00.000Z",
      "2030-01-08T00:00:00.000Z",
    );
    expect(events).toEqual([]);
  });
});
