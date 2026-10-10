/**
 * A teammate with Calendar but no Residents access sees who is where and when (name, dates,
 * status label), never the resident's email or the application / lease ids. Bookings still draws
 * those residents from the snapshot and de-duplicates them against the slower reads by where/when.
 */
import { describe, expect, it } from "vitest";
import {
  mergeResidentEntries,
  occupancyStayResident,
  occupancyStayResidentWithoutIdentifiers,
  residentEntriesFromStays,
} from "@/lib/occupancy/snapshot";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

const entry: PropertyBookingEntry = {
  source: "hold",
  propertyId: "house-1",
  propertyLabel: "House",
  roomId: "r1",
  roomLabel: "Room 1",
  summary: "Ada Lovelace",
  start: "2026-10-05",
  end: "2026-11-05",
  applicationId: "PROPLANE-APP1",
  leaseId: "lease-1",
  residentName: "Ada Lovelace",
  residentEmail: "ada@example.com",
  statusLabel: "Approved",
} as PropertyBookingEntry;

describe("occupancyStayResidentWithoutIdentifiers", () => {
  it("drops email and record ids, keeps name, status label and source", () => {
    const stripped = occupancyStayResidentWithoutIdentifiers(occupancyStayResident(entry));
    expect(stripped).toEqual({ source: "hold", residentName: "Ada Lovelace", statusLabel: "Approved" });
    expect(JSON.stringify(stripped)).not.toContain("ada@example.com");
    expect(occupancyStayResidentWithoutIdentifiers(undefined)).toBeUndefined();
  });

  it("Bookings still builds a resident row from the stripped stay, without ids", () => {
    const stay = {
      propertyId: "house-1",
      roomId: "r1",
      roomLabel: "Room 1",
      start: entry.start,
      end: entry.end,
      name: "Ada Lovelace",
      resident: occupancyStayResidentWithoutIdentifiers(occupancyStayResident(entry)),
    };
    const rows = residentEntriesFromStays([stay], () => "House");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "hold", residentName: "Ada Lovelace", statusLabel: "Approved" });
    expect(rows[0]!.applicationId).toBeUndefined();
    expect(rows[0]!.residentEmail).toBeUndefined();
  });

  it("an id-less snapshot stay and the same stay from the applications read merge into one row", () => {
    const keyless = residentEntriesFromStays(
      [{ propertyId: "house-1", roomId: "r1", roomLabel: "Room 1", start: entry.start, end: entry.end, name: "Ada Lovelace", resident: { source: "hold", residentName: "Ada Lovelace" } }],
      () => "House",
    );
    const merged = mergeResidentEntries(keyless, [entry]);
    expect(merged).toHaveLength(1);
  });
});
