/**
 * "Today at your houses" counts one line per guest per ROOM. Booking.com and Agoda privacy-strip every reservation to
 * the same stand-in ("CLOSED - Not available" -> "Booking.com guest"), so two arrivals in two rooms of one house on one
 * day used to share a dedupe key and the digest counted one check-in. Shaped on 4709A 8th Ave on Nov 27 2026: Booking.com
 * check-ins in Room 4 (last night Nov 28) and Room 7 (last night Nov 29).
 */
import { describe, expect, it } from "vitest";

import { createMemoryDb } from "./support/memory-supabase";
import { bookingsTodayDedupeKey, loadBookingsTodayByManager } from "@/lib/reminders/subjects/bookings-today.server";

const HOUSE = "mgr-house-4709a";
const connection = (id: string, roomId: string, label: string, start: string, end: string) => ({
  id,
  manager_user_id: "m1",
  property_id: HOUSE,
  room_id: roomId,
  label,
  provider: "booking_com",
  imported_ranges: [{ id: `${id}-uid@booking.com`, sourceUid: `${id}-uid@booking.com`, summary: "CLOSED - Not available", start, end }],
});

describe("bookings today digest: one line per room", () => {
  it("two privacy-stripped Booking.com arrivals in two rooms of one house are two check-ins", async () => {
    const db = createMemoryDb({
      manager_property_records: [{ id: HOUSE, property_data: { buildingName: "4709a 8th Ave" } }],
      external_calendar_connections: [
        connection("c-r4", "room-4", "Room 4", "2026-11-27", "2026-11-28"),
        connection("c-r7", "room-7", "Room 7", "2026-11-27", "2026-11-29"),
      ],
    });
    const summary = (await loadBookingsTodayByManager(db as never, "2026-11-27")).get("m1");
    expect(summary?.checkIns).toBe(2);
    expect(summary?.items.filter((item) => item.kind === "check-in")).toHaveLength(2);
  });

  it("a one-night stay (stored start == last night) checks out the next day", async () => {
    const db = createMemoryDb({
      manager_property_records: [{ id: HOUSE, property_data: { buildingName: "4709a 8th Ave" } }],
      external_calendar_connections: [connection("c-r4", "room-4", "Room 4", "2026-12-07", "2026-12-07")],
    });
    expect((await loadBookingsTodayByManager(db as never, "2026-12-07")).get("m1")?.checkIns).toBe(1);
    expect((await loadBookingsTodayByManager(db as never, "2026-12-08")).get("m1")?.checkOuts).toBe(1);
  });

  it("a real guest name still dedupes across sources and rooms of one house", () => {
    const a = bookingsTodayDedupeKey({ propertyId: HOUSE, propertyLabel: "x", roomId: "room-4", guestName: "Priya Nair" }, "check-in");
    const b = bookingsTodayDedupeKey({ propertyId: HOUSE, propertyLabel: "x", roomId: undefined, guestName: "Priya Nair" }, "check-in");
    expect(a).toBe(b);
    const r4 = bookingsTodayDedupeKey({ propertyId: HOUSE, propertyLabel: "x", roomId: "room-4", guestName: "Booking.com guest" }, "check-in");
    const r7 = bookingsTodayDedupeKey({ propertyId: HOUSE, propertyLabel: "x", roomId: "room-7", guestName: "Booking.com guest" }, "check-in");
    expect(r4).not.toBe(r7);
  });
});
