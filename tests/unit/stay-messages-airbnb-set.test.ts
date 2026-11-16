/**
 * The Airbnb-style scheduled set for a stay or a lease: what goes out, when, and what each message may carry.
 * Check-in (room, room code, front door, Wi-Fi, house guide) at 10:00 local the day before, check-out at 09:00 on the day.
 */
import { describe, expect, it } from "vitest";
import { normalizeHouseInfo } from "@/lib/house-info";
import { buildStayFacts } from "@/lib/stay-messages/facts";
import { checkInDueAt, checkOutDueAt } from "@/lib/stay-messages/schedule";
import { buildStayMessage, DEFAULT_STAY_MESSAGE_SETTINGS } from "@/lib/stay-messages/templates";
import type { StayCandidate, StayProperty } from "@/lib/stay-messages/types";

const property: StayProperty = {
  propertyId: "p1",
  label: "5259 Brooklyn Ave NE",
  addressLine: "5259 Brooklyn Ave NE, Seattle, 98105",
  timeZone: "America/Los_Angeles",
  houseInfo: normalizeHouseInfo({
    access: { doorCode: "1357", gateCode: "075" },
    wifi: { network: "Brooklyn5259", password: "wifipass" },
    rules: { bathroom: "Use the bathroom on your own floor.", quietFrom: "22:00", quietTo: "07:00" },
    trash: { binLocation: "Bins are on the side of the house." },
    checkout: { trash: "Take the trash to the curb." },
    internal: { lockboxCode: "9911" },
  }),
  rooms: [
    { id: "room-3", label: "Room 3", doorCode: "3333" },
    { id: "room-4", label: "Room 4", doorCode: "4444" },
  ],
};

const stay: StayCandidate = {
  stayKey: "block:b1",
  stayKind: "block",
  workspaceId: "ws-1",
  ownerUserId: "owner-1",
  propertyId: "p1",
  roomId: "room-4",
  source: "direct",
  status: "confirmed",
  guestName: "Jordan Lee",
  guestEmail: "j@example.com",
  guestPhone: "+12065550142",
  guestUserId: "guest-1",
  checkIn: "2026-11-20",
  checkOut: "2026-11-23",
  checkInTime: "15:00",
  checkOutTime: "11:00",
  createdAt: "2026-11-01T00:00:00Z",
  leaseSigned: true,
};

const now = new Date("2026-11-19T18:05:00Z");
const settings = DEFAULT_STAY_MESSAGE_SETTINGS;

describe("scheduled message set", () => {
  it("is due at 10:00 local the day before check-in and 09:00 local on check-out day", () => {
    expect(checkInDueAt("2026-11-20")?.toISOString()).toBe("2026-11-19T18:00:00.000Z");
    expect(checkOutDueAt("2026-11-23")?.toISOString()).toBe("2026-11-23T17:00:00.000Z");
  });

  it("check-in carries the room, the room code, the front door code, the Wi-Fi and the house guide", () => {
    const facts = buildStayFacts({ kind: "check_in", candidate: stay, property, settings, now });
    const built = buildStayMessage({ template: settings.templates.checkIn, facts });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    for (const needle of ["Room 4", "4444", "1357", "Brooklyn5259", "wifipass", "Bins are on the side of the house."]) {
      expect(built.body).toContain(needle);
    }
    // Never another room's code, never the staff-only Internal section.
    expect(built.body).not.toContain("3333");
    expect(built.body).not.toContain("9911");
  });

  it("holds the check-in (no body at all) when the guest's room has no code, never falling back", () => {
    const noCode = { ...property, rooms: [{ id: "room-4", label: "Room 4", doorCode: "" }] };
    const facts = buildStayFacts({ kind: "check_in", candidate: stay, property: noCode, settings, now });
    expect(buildStayMessage({ template: settings.templates.checkIn, facts })).toEqual({ ok: false, reason: "room_code_missing" });
  });

  it("check-out carries the checkout time and steps and no door codes", () => {
    const facts = buildStayFacts({ kind: "check_out", candidate: stay, property, settings, now });
    const built = buildStayMessage({ template: settings.templates.checkOut, facts });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body).toMatch(/11:00 am/i);
    expect(built.body).toContain("Take the trash to the curb.");
    for (const code of ["4444", "1357", "075", "wifipass"]) expect(built.body).not.toContain(code);
  });
});
