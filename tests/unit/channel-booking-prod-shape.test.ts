import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";

const emitActionEvent = vi.fn<(db: unknown, input: unknown) => Promise<unknown>>(async () => ({ eventId: "e" }));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: (db: unknown, input: unknown) => emitActionEvent(db, input) }));
vi.mock("@/lib/analytics/posthog", () => ({ track: () => undefined }));
vi.mock("@/lib/channel-calendar/airbnb-residents.server", () => ({ upsertAirbnbResidentsFromImportedRanges: async () => undefined }));
vi.mock("@/lib/channel-calendar/stay-tombstones.server", () => ({ loadChannelStayTombstoneKeys: async () => new Set<string>() }));

import { syncChannelCalendarConnection } from "@/lib/channel-calendar/sync.server";

function airbnbFeed(): string {
  const reserved = (uid: string, start: string, end: string, code: string) =>
    `BEGIN:VEVENT\nUID:${uid}@airbnb.com\nDTSTART;VALUE=DATE:${start}\nDTEND;VALUE=DATE:${end}\nSUMMARY:Reserved\nDESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/${code}\\nPhone Number (Last 4 Digits): 4411\nEND:VEVENT`;
  const block = (uid: string, start: string, end: string) =>
    `BEGIN:VEVENT\nUID:${uid}@airbnb.com\nDTSTART;VALUE=DATE:${start}\nDTEND;VALUE=DATE:${end}\nSUMMARY:Airbnb (Not available)\nEND:VEVENT`;
  return `BEGIN:VCALENDAR\nVERSION:2.0\n${[
    reserved("old1", "20261101", "20261104", "HMOLDOLD11"),
    reserved("new1", "20261013", "20261016", "HMHW5SHXRB"),
    block("blk1", "20261020", "20261025"),
  ].join("\n")}\nEND:VCALENDAR`;
}

function syncDb(connection: Record<string, unknown>) {
  const stored = { ...connection };
  const from = (table: string) => {
    let patch: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      update: (value: Record<string, unknown>) => { patch = value; if (table === "external_calendar_connections") Object.assign(stored, value); return chain; },
      maybeSingle: async () => table === "external_calendar_connections"
        ? { data: stored, error: null }
        : table === "profiles"
          ? { data: { email: "m@example.com", full_name: "Mgr" }, error: null }
          : { data: { manager_user_id: "m1", property_data: { id: "p1", title: "4709A 8th Ave", buildingName: "4709A 8th Ave", listingSubmission: { rooms: [{ id: "r9", name: "Room 9", manualUnavailableRanges: [] }] } }, row_data: {} }, error: null },
      single: async () => ({ data: stored, error: null }),
      then: (resolve: (value: unknown) => void) => resolve({ error: null, data: patch }),
    };
    return chain;
  };
  return { db: { from } as unknown as SupabaseClient, stored };
}

const prior = [
  { id: "old1@airbnb.com", sourceUid: "old1@airbnb.com", summary: "Reserved", start: "2026-11-01", end: "2026-11-03", reservationCode: "HMOLDOLD11" },
  { id: "blk1@airbnb.com", sourceUid: "blk1@airbnb.com", summary: "Airbnb (Not available)", start: "2026-10-20", end: "2026-10-24", hostBlock: true },
];
const connection = {
  id: "c9", manager_user_id: "m1", property_id: "p1", room_id: "r9", provider: "airbnb", label: null,
  import_url: "https://www.airbnb.com/calendar/ical/123.ics?s=abc", export_token: "tok", last_error: null,
};

describe("prod-shaped Airbnb sync", () => {
  beforeEach(() => {
    emitActionEvent.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T04:00:00Z"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(airbnbFeed(), { status: 200, headers: { "content-type": "text/calendar" } })));
  });

  it("emits exactly one created event for the new reservation, none for host blocks or known stays", async () => {
    const { db } = syncDb({ ...connection, last_synced_at: "2026-10-13T03:45:00Z", imported_ranges: prior });
    await syncChannelCalendarConnection(db, "c9");
    expect(emitActionEvent).toHaveBeenCalledTimes(1);
    const input = emitActionEvent.mock.calls[0]![1] as { event: string; payload: { start: string }; recipients: Array<{ rendered: { text: string } }> };
    expect(input.event).toBe("channel_booking_created");
    expect(input.payload.start).toBe("2026-10-13");
    const text = input.recipients[0]!.rendered.text;
    expect(text).toContain("New Airbnb booking · 4709A 8th Ave · Room 9 · Oct 13 – Oct 16 (3 nights) · HMHW5SHXRB");
    expect(text).toContain("/portal/bookings/airbnb%3Ap1%3Ar9%3A2026-10-13%3A2026-10-15%3AReserved/overview");
  });

  it("stays silent for the baseline sync", async () => {
    const { db } = syncDb({ ...connection, last_synced_at: null, imported_ranges: [] });
    await syncChannelCalendarConnection(db, "c9");
    expect(emitActionEvent).not.toHaveBeenCalled();
  });

  it("warns instead of swallowing a rejected alert", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    emitActionEvent.mockRejectedValueOnce(new Error("violates check constraint action_events_domain_check"));
    const { db } = syncDb({ ...connection, last_synced_at: "2026-10-13T03:45:00Z", imported_ranges: prior });
    await expect(syncChannelCalendarConnection(db, "c9")).resolves.toMatchObject({ id: "c9" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("booking alert failed"), expect.objectContaining({ connectionId: "c9" }));
    warn.mockRestore();
  });
});

describe("action_events domain check", () => {
  it("the latest migration allows every ActionEventDomain the code emits", () => {
    const src = readFileSync("src/lib/action-events.server.ts", "utf8");
    const block = /export type ActionEventDomain =([\s\S]*?);/.exec(src)![1]!;
    const domains = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    const files = readdirSync("supabase/migrations").filter((f) => readFileSync(`supabase/migrations/${f}`, "utf8").includes("action_events_domain_check")).sort();
    const latest = readFileSync(`supabase/migrations/${files[files.length - 1]}`, "utf8");
    for (const domain of domains) expect(latest, domain).toContain(`'${domain}'`);
  });
});
