/**
 * An Assistant notice names a house by its display name, never by its stored id, and one event gives one notice.
 * The guard: no notice body may contain a `mgr-…` property id in its prose.
 */
import { describe, expect, it } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { renderBookingsTodayMessage, loadBookingsTodayByManager } from "@/lib/reminders/subjects/bookings-today.server";
import { bookingReminderHeadline } from "@/lib/reminders/subjects/bookings.server";
import { renderReminder } from "@/lib/reminders/render";
import { buildTeamNoticeLine } from "@/lib/team-notice-line";
import { findRawPropertyIds, hasRawPropertyId, noticePlaceName, scrubRawPropertyIds, NOTICE_UNKNOWN_HOUSE } from "@/lib/notice-place-label";
import { propertyDisplayNameFromData, withHouseDisplayNames } from "@/lib/notice-place-label.server";
import { reminderNoticeIdempotencyKey } from "@/lib/reminders/notice-idempotency";

const MGR_ID_IN_PROSE = /(?<![A-Za-z0-9%_/-])mgr-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/i;
const ID_A = "mgr-listing-1x3tiu0489ha";
const ID_B = "mgr-5259-brooklyn-ave-copy-9-rooms-7mdlyj0h2vfg";

describe("raw property id detection", () => {
  it("finds ids in prose, ignores ids inside links and ordinary words", () => {
    expect(findRawPropertyIds(`Check-in · Krishnanand · ${ID_A}`)).toEqual([ID_A]);
    expect(hasRawPropertyId(`Open booking: https://proplane.ai/portal/bookings/airbnb%3A${ID_B}%3Aroom-1/overview`)).toBe(false);
    expect(hasRawPropertyId("4709a 8th Ave · Room 7")).toBe(false);
    expect(hasRawPropertyId("a manager-owned house")).toBe(false);
  });
  it("noticePlaceName never returns an id", () => {
    expect(noticePlaceName(ID_A, "5257 Brooklyn Ave")).toBe("5257 Brooklyn Ave");
    expect(noticePlaceName(ID_A, null, "")).toBe(NOTICE_UNKNOWN_HOUSE);
    expect(noticePlaceName(undefined)).toBe(NOTICE_UNKNOWN_HOUSE);
  });
  it("scrubRawPropertyIds swaps the id for the name and leaves links whole", () => {
    const url = `https://proplane.ai/portal/bookings/airbnb%3A${ID_B}%3Aroom-1/overview`;
    const out = scrubRawPropertyIds(`Check-in · Kumaran · ${ID_B}\n${url}`, new Map([[ID_B, "4709a 8th Ave"]]));
    expect(out).toContain("Check-in · Kumaran · 4709a 8th Ave");
    expect(out).toContain(url);
    expect(scrubRawPropertyIds(`at ${ID_A}`, new Map())).toBe(`at ${NOTICE_UNKNOWN_HOUSE}`);
  });
});

describe("notice builders never print a property id", () => {
  it("the 'Today at your houses' digest", () => {
    const body = renderBookingsTodayMessage({
      checkIns: 2,
      checkOuts: 1,
      items: [
        { kind: "check-in", guestName: "Krishnanand", propertyLabel: ID_A },
        { kind: "check-in", guestName: "Kumaran Chanthrakumar", propertyLabel: ID_B },
        { kind: "check-out", guestName: "Aarav", propertyLabel: "5257 Brooklyn Ave" },
      ],
    });
    expect(body).not.toMatch(MGR_ID_IN_PROSE);
    expect(body).toContain("Check-in · Krishnanand · your house");
    expect(body).toContain("Check-out · Aarav · 5257 Brooklyn Ave");
  });

  it("the digest reads the house name off the property record when a stay carries only its id", async () => {
    const db = createMemoryDb({
      manager_property_records: [
        { id: ID_A, property_data: { buildingName: "5257 Brooklyn Ave", title: "5257 Brooklyn Ave · 9 rooms" } },
      ],
      portal_schedule_records: [
        {
          id: "blk1", manager_user_id: "m1", property_id: ID_A, record_type: "room_date_block",
          row_data: { checkIn: "2026-11-12", checkOut: "2026-11-14", residentName: "Krishnanand", roomId: "room-1" },
        },
      ],
    });
    const byManager = await loadBookingsTodayByManager(db as never, "2026-11-12");
    const message = renderBookingsTodayMessage(byManager.get("m1")!);
    expect(message).toContain("Check-in · Krishnanand · 5257 Brooklyn Ave");
    expect(message).not.toMatch(MGR_ID_IN_PROSE);
  });

  it("the check-in / check-out reminder headline and a lease follow-up", () => {
    const place = { property: noticePlaceName(ID_B), room: undefined };
    const headline = bookingReminderHeadline("check_in", { guestName: "Kumaran", checkInKey: "2026-11-12", checkOutKey: "2026-11-14" }, place);
    expect(headline).not.toMatch(MGR_ID_IN_PROSE);
    const lease = renderReminder({
      kind: "lease_manager",
      leadMinutes: -1440,
      recipientRole: "manager",
      payload: { propertyLabel: noticePlaceName(ID_A), counterpartyName: "Kumaran Chanthrakumar", url: "https://proplane.ai/portal/leases" },
    });
    expect(`${lease.subject}\n${lease.body}`).not.toMatch(MGR_ID_IN_PROSE);
  });

  it("the Team chat line", () => {
    expect(buildTeamNoticeLine({ domain: "channel_booking", event: "created", subject: "Krishnanand", place: `${ID_A} · Room 3` })).not.toMatch(MGR_ID_IN_PROSE);
  });
});

describe("the delivery safety net", () => {
  it("withHouseDisplayNames replaces any id a builder left in copy, with the listing's own name", async () => {
    const db = createMemoryDb({
      manager_property_records: [{ id: ID_B, property_data: { buildingName: "4709a 8th Ave", title: "4709a 8th Ave · 10 rooms" } }],
    });
    const out = await withHouseDisplayNames(db as never, `Check-in · Kumaran Chanthrakumar · ${ID_B}\nOpen booking: https://proplane.ai/portal/bookings/airbnb%3A${ID_B}%3Aroom-1/overview`);
    expect(out.split("\n")[0]).toBe("Check-in · Kumaran Chanthrakumar · 4709a 8th Ave");
    expect(out).toContain(`%3A${ID_B}%3A`);
  });
  it("a property with no readable name reads 'your house', never the id", async () => {
    const db = createMemoryDb({ manager_property_records: [] });
    expect(await withHouseDisplayNames(db as never, `at ${ID_A}`)).toBe(`at ${NOTICE_UNKNOWN_HOUSE}`);
  });
  it("the display name is the building name, then title, then address", () => {
    expect(propertyDisplayNameFromData({ buildingName: "B", title: "T", address: "A" })).toBe("B");
    expect(propertyDisplayNameFromData({ title: "T" })).toBe("T");
    expect(propertyDisplayNameFromData({ address: "5 Main St" })).toBe("5 Main St");
    expect(propertyDisplayNameFromData({ buildingName: ID_A })).toBe(NOTICE_UNKNOWN_HOUSE);
  });
});

describe("one event, one notice", () => {
  const base = { kind: "lease_manager", subjectId: "lease-1", leadMinutes: -1440 };
  it("a lease follow-up queued from two anchors shares one key per person", () => {
    expect(reminderNoticeIdempotencyKey({ id: "row-a", ...base }, "owner-1")).toBe(reminderNoticeIdempotencyKey({ id: "row-b", ...base }, "owner-1"));
  });
  it("different follow-up lead times, people or leases are different notices", () => {
    const k = reminderNoticeIdempotencyKey({ id: "r", ...base }, "owner-1");
    expect(reminderNoticeIdempotencyKey({ id: "r", ...base, leadMinutes: -4320 }, "owner-1")).not.toBe(k);
    expect(reminderNoticeIdempotencyKey({ id: "r", ...base }, "owner-2")).not.toBe(k);
    expect(reminderNoticeIdempotencyKey({ id: "r", ...base, subjectId: "lease-2" }, "owner-1")).not.toBe(k);
  });
  it("every other reminder keeps its own row id", () => {
    expect(reminderNoticeIdempotencyKey({ id: "row-a", kind: "tour", subjectId: "t1", leadMinutes: 1440 }, "owner-1")).toBe("row-a");
    expect(reminderNoticeIdempotencyKey({ id: "row-a", kind: "lease_manager", subjectId: "l1", leadMinutes: 1440 }, "owner-1")).toBe("row-a");
  });
});
