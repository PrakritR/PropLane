import { describe, expect, it } from "vitest";
import {
  AMBIKA_SEATTLE_BOOKINGS,
  AMBIKA_SEATTLE_DECIDE,
  AMBIKA_SEATTLE_PROPERTY_IDS,
  AMBIKA_SEATTLE_RESIDENTS,
  LOCKED_LIVE_LISTING_IDS,
  ambikaSeattlePropertyId,
  bookingGetsOnboard,
  isLockedLiveListingId,
  occupancyPlaceholderEmail,
  residentEmailFor,
  roomIdForNumber,
} from "@/lib/ambika-seattle-occupancy";
import { paidLeaseHistoryMonths } from "@/lib/import-paid-lease-history";
import {
  IMPORTED_AIRBNB_REASON,
  importedAirbnbStayEntries,
  isImportedAirbnbBlock,
  roomBlockEntries,
} from "@/lib/channel-calendar/property-bookings";
import {
  buildResidentWelcomeSmsBody,
  isPlaceholderResidentEmail,
} from "@/lib/resident-welcome.server";

describe("Ambika Seattle occupancy roster (PLAN-0918-1909)", () => {
  it("uses Ambika copy listing ids and refuses the locked seeds", () => {
    for (const house of ["5257", "5259", "4709A"] as const) {
      expect(isLockedLiveListingId(ambikaSeattlePropertyId(house))).toBe(false);
    }
    for (const id of LOCKED_LIVE_LISTING_IDS) {
      expect(isLockedLiveListingId(id)).toBe(true);
      expect(Object.values(AMBIKA_SEATTLE_PROPERTY_IDS)).not.toContain(id);
    }
  });

  it("does not carry listing advertised rent fields", () => {
    const blob = JSON.stringify({
      residents: AMBIKA_SEATTLE_RESIDENTS,
      bookings: AMBIKA_SEATTLE_BOOKINGS,
    });
    expect(blob).not.toMatch(/listingSubmission/);
    expect(blob).not.toMatch(/advertisedRent/);
    expect(blob).not.toMatch(/monthlyRentListing/);
  });

  it("files Daniel on 5259 Room 2 and Baljinnyam on Room 6", () => {
    expect(AMBIKA_SEATTLE_DECIDE.danielRoom).toBe("5259-room-2");
    expect(AMBIKA_SEATTLE_DECIDE.room6).toBe("baljinnyam");
    expect(AMBIKA_SEATTLE_RESIDENTS.find((r) => r.key === "daniel-5259-r2")?.roomNumber).toBe(2);
    expect(AMBIKA_SEATTLE_RESIDENTS.find((r) => r.key === "baljinnyam-5259-r6")?.roomNumber).toBe(6);
    expect(AMBIKA_SEATTLE_RESIDENTS.find((r) => r.key === "dagvadorj-5259-r8")?.roomNumber).toBe(8);
  });

  it("uses Vivek $1,000 and files Prakrit as a resident without charges", () => {
    const vivek = AMBIKA_SEATTLE_RESIDENTS.find((r) => r.key === "vivek-5259-r4");
    const prakrit = AMBIKA_SEATTLE_RESIDENTS.find((r) => r.key === "prakrit-5257-r9");
    expect(vivek?.rentCents).toBe(100_000);
    expect(vivek?.pdfFileName).toBeUndefined();
    expect(AMBIKA_SEATTLE_RESIDENTS.find((r) => r.key === "grace-4709a-r1")?.pdfFileName).toBe(
      "Lease Agreement Room1.pdf",
    );
    expect(prakrit?.onboard).toBe(true);
    expect(prakrit?.skipCharges).toBe(true);
    expect(prakrit?.rentCents).toBeUndefined();
  });

  it("keeps Vinod and Airbnb names off Current / onboard", () => {
    expect(AMBIKA_SEATTLE_RESIDENTS.some((r) => /vinod/i.test(r.name) && !/akshaya/i.test(r.name))).toBe(false);
    expect(AMBIKA_SEATTLE_RESIDENTS.some((r) => r.name === "Andrew")).toBe(false);
    const vinod = AMBIKA_SEATTLE_BOOKINGS.find((b) => b.key === "vinod-4709a-r5");
    const andrew = AMBIKA_SEATTLE_BOOKINGS.find((b) => b.key === "andrew-4709a-r2");
    expect(vinod?.reason).toBe("Booking");
    expect(andrew?.reason).toBe("Airbnb");
    expect(bookingGetsOnboard(vinod!)).toBe(false);
    expect(bookingGetsOnboard(andrew!)).toBe(false);
  });

  it("does not invent Gmail — placeholders stay on import.proplane.local", () => {
    const heesu = AMBIKA_SEATTLE_RESIDENTS.find((r) => r.key === "heesu-5257-r1")!;
    const grace = AMBIKA_SEATTLE_RESIDENTS.find((r) => r.key === "grace-4709a-r1")!;
    expect(heesu.email).toBeUndefined();
    expect(grace.email).toBeUndefined();
    expect(residentEmailFor(heesu)).toBe(occupancyPlaceholderEmail("Heesu", 1, "5257"));
    expect(residentEmailFor(heesu)).toMatch(/@import\.proplane\.local$/);
    expect(residentEmailFor(heesu)).not.toMatch(/gmail\.com/);
    expect(JSON.stringify(AMBIKA_SEATTLE_RESIDENTS)).not.toMatch(/unkown-email/);
  });

  it("resolves Room N labels the same way the occupancy importer does", () => {
    const rooms = [
      { id: "r1", name: "Room 1" },
      { id: "r2", name: "Room 2" },
    ];
    expect(roomIdForNumber(rooms, 2)).toBe("r2");
    expect(roomIdForNumber(rooms, 9)).toBeNull();
  });
});

describe("paid lease history", () => {
  it("marks months through today paid and later months pending at sheet rent + utilities", () => {
    const months = paidLeaseHistoryMonths({
      start: "2026-09-01",
      end: "2027-08-31",
      throughDate: "2026-09-18",
      rentCents: 85_000,
      utilitiesCents: 15_000,
    });
    expect(months[0]).toMatchObject({ yearMonth: "2026-09", status: "paid", amountCents: 100_000 });
    expect(months.find((m) => m.yearMonth === "2026-10")).toMatchObject({ status: "pending", amountCents: 100_000 });
    expect(months.at(-1)?.yearMonth).toBe("2027-08");
    expect(months.every((m) => m.amountCents === 100_000)).toBe(true);
  });

  it("skips charges when rent is missing", () => {
    expect(paidLeaseHistoryMonths({ start: "2026-09-01", throughDate: "2026-09-18", rentCents: 0 })).toEqual([]);
  });

  it("includes the start month even when the lease began mid-month", () => {
    const months = paidLeaseHistoryMonths({
      start: "2026-08-21",
      end: "2026-10-31",
      throughDate: "2026-09-18",
      rentCents: 110_000,
    });
    expect(months.map((m) => `${m.yearMonth}:${m.status}`)).toEqual([
      "2026-08:paid",
      "2026-09:paid",
      "2026-10:pending",
    ]);
  });
});

describe("imported Airbnb bookings", () => {
  const labels = {
    propertyLabelForId: () => "5257 Brooklyn",
    roomLabelForId: () => "Room 5",
  };

  it("draws Airbnb calendar stays as source airbnb, not a resident hold", () => {
    const blocks = [
      {
        id: "b1",
        propertyId: AMBIKA_SEATTLE_PROPERTY_IDS["5257"],
        roomId: "r5",
        checkIn: "2026-09-15",
        checkOut: "2026-09-19",
        reason: IMPORTED_AIRBNB_REASON,
        residentName: "Selina",
        createdAt: "2026-09-18T00:00:00Z",
      },
    ];
    const [entry] = importedAirbnbStayEntries(blocks, labels);
    expect(entry?.source).toBe("airbnb");
    expect(entry?.summary).toBe("Selina");
    expect(entry?.start).toBe("2026-09-15");
    expect(entry?.end).toBe("2026-09-18");
    expect(isImportedAirbnbBlock(blocks[0]!)).toBe(true);
  });

  it("keeps Airbnb blocks out of the grey block hatch", () => {
    const blocks = [
      {
        id: "b1",
        propertyId: "p",
        roomId: "r",
        checkIn: "2026-09-14",
        checkOut: "2026-09-16",
        reason: "Airbnb",
        residentName: "Andrew",
        createdAt: "",
      },
    ];
    expect(roomBlockEntries(blocks.filter((b) => !isImportedAirbnbBlock(b)), labels)).toEqual([]);
  });
});

describe("setup-account SMS when there is no real email", () => {
  it("treats import.proplane.local as a placeholder inbox", () => {
    expect(isPlaceholderResidentEmail("occupancy.heesu.r1.5257@import.proplane.local")).toBe(true);
    expect(isPlaceholderResidentEmail("akshaya.vk25@gmail.com")).toBe(false);
    expect(isPlaceholderResidentEmail("unkown-email(input)@gmail.com")).toBe(true);
  });

  it("names portal pay and includes the setup link", () => {
    const body = buildResidentWelcomeSmsBody({
      residentName: "Heesu",
      axisId: "PROPLANE-HEESU",
      senderName: "Ambika",
      setupUrl: "https://prop-lane.space/auth/create-account?axis=PROPLANE-HEESU",
    });
    expect(body).toMatch(/Pay rent and manage your home online/);
    expect(body).toMatch(/Set up your account: https:\/\/prop-lane\.space/);
    expect(body).not.toMatch(/gmail\.com/);
  });
});
