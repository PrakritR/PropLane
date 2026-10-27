import { describe, expect, it } from "vitest";

import {
  ARRIVAL_GUIDE_MAX_SEGMENTS,
  ARRIVAL_GUIDE_SMS_MAX_CHARS,
  buildArrivalGuideSmsText,
  buildArrivalGuideText,
  buildCheckoutReminderText,
} from "@/lib/bookings/arrival-guide";
import { normalizeHouseInfo } from "@/lib/house-info";
import { smsSegmentCount } from "@/lib/one-number/segments";

const STAY = {
  checkIn: "2026-10-16",
  checkInTime: "15:00",
  staysUrl: "https://prop-lane.space/resident/applications/approved",
  guestName: "Alex Guest",
  propertyLabel: "5259 Brooklyn",
};

const FULL_HOUSE = normalizeHouseInfo({
  access: {
    doorCode: "001000",
    gateCode: "#4821",
    keyPickup: "Lockbox left of the door",
    parking: "Street parking, no permit needed",
    notes: "Side gate sticks - lift and push.",
  },
  wifi: { network: "Brooklyn5259", password: "pa55-word" },
  rules: {
    quietFrom: "22:00",
    quietTo: "07:00",
    smoking: "No smoking, vaping or cannabis anywhere",
    guests: "Ask the manager first",
    pets: "No pets",
  },
});

describe("buildArrivalGuideText", () => {
  it("opens with the check-in time and date and carries the entry, Wi-Fi, parking, rules and the Stays link", () => {
    const text = buildArrivalGuideText(FULL_HOUSE, STAY);
    expect(text).toContain("Check-in is at 3:00 pm on Oct 16.");
    expect(text).toContain("Door code: 001000");
    expect(text).toContain("Gate or building code: #4821");
    expect(text).toContain("Key pickup: Lockbox left of the door");
    expect(text).toContain("Wi-Fi: Brooklyn5259, password pa55-word");
    expect(text).toContain("Parking: Street parking, no permit needed");
    expect(text).toContain("House rules: Quiet hours 10:00 pm to 7:00 am");
    expect(text).toContain("Your stay: https://prop-lane.space/resident/applications/approved");
    expect(smsSegmentCount(text)).toBeLessThanOrEqual(ARRIVAL_GUIDE_MAX_SEGMENTS);
  });

  it("uses the paid early check-in time it is handed", () => {
    expect(buildArrivalGuideText(FULL_HOUSE, { ...STAY, checkInTime: "12:00" })).toContain("Check-in is at 12:00 pm on Oct 16.");
  });

  it("leaves out what the house never said and invents nothing", () => {
    const text = buildArrivalGuideText(normalizeHouseInfo({ access: { doorCode: "7788" } }), STAY);
    expect(text).toContain("Door code: 7788");
    expect(text).not.toMatch(/Wi-Fi|Parking|House rules|Gate|Key pickup|Access notes/);
    const bare = buildArrivalGuideText(normalizeHouseInfo(null), { checkIn: "2026-10-16", checkInTime: "15:00" });
    expect(bare).toBe("Here is your arrival guide.\nCheck-in is at 3:00 pm on Oct 16.");
  });

  it("drops optional sections first when the house has more than four text segments of facts, never the code or the time", () => {
    const long = "Wash dishes right after you cook and keep every shared surface clear of belongings at all times. ".repeat(8);
    const house = normalizeHouseInfo({
      ...FULL_HOUSE,
      access: { ...FULL_HOUSE.access, notes: long },
      rules: { ...FULL_HOUSE.rules, kitchen: long, bathroom: long, commonAreas: long, other: long },
    });
    const text = buildArrivalGuideText(house, STAY);
    expect(smsSegmentCount(text)).toBeLessThanOrEqual(ARRIVAL_GUIDE_MAX_SEGMENTS);
    expect(text).toContain("Check-in is at 3:00 pm on Oct 16.");
    expect(text).toContain("Door code: 001000");
    expect(text).toContain("Your stay: https://prop-lane.space/resident/applications/approved");
    expect(text).not.toContain(long.trim());
  });

  it("keeps the code and the time even when the essentials alone exceed the budget", () => {
    const house = normalizeHouseInfo({ access: { doorCode: "001000", keyPickup: "x".repeat(700) } });
    const text = buildArrivalGuideText(house, STAY);
    expect(text).toContain("Door code: 001000");
    expect(text).toContain("Check-in is at 3:00 pm on Oct 16.");
  });

  it("keeps a Wi-Fi password verbatim but writes descriptive text as plain GSM-7 characters", () => {
    const house = normalizeHouseInfo({ wifi: { network: "Café", password: "pässwörd✓" }, access: { parking: "Street — no “permit”" } });
    const text = buildArrivalGuideText(house, STAY);
    expect(text).toContain("pässwörd✓");
    expect(text).toContain('Parking: Street - no "permit"');
  });
});

describe("buildArrivalGuideSmsText", () => {
  it("is the time, the entry codes and the link within one short text", () => {
    const text = buildArrivalGuideSmsText(FULL_HOUSE, STAY);
    expect(text).toBe(
      [
        "Check-in is at 3:00 pm on Oct 16.",
        "Door code: 001000",
        "Gate or building code: #4821",
        "Key pickup: Lockbox left of the door",
        "Your stay: https://prop-lane.space/resident/applications/approved",
      ].join("\n"),
    );
    expect(text.length).toBeLessThanOrEqual(ARRIVAL_GUIDE_SMS_MAX_CHARS);
  });

  it("drops the link before the code when it does not fit", () => {
    const text = buildArrivalGuideSmsText(normalizeHouseInfo({ access: { doorCode: "001000", keyPickup: "k".repeat(290) } }), STAY);
    expect(text).toContain("Door code: 001000");
    expect(text).toContain("Check-in is at 3:00 pm on Oct 16.");
  });
});

describe("buildCheckoutReminderText", () => {
  it("names the checkout time today, the paid late time when bought", () => {
    expect(buildCheckoutReminderText({ checkOutTime: "11:00", staysUrl: "https://prop-lane.space/resident/applications/approved", guestName: "Alex Guest", propertyLabel: "5259 Brooklyn" })).toBe(
      "Hi Alex,\nCheckout is at 11:00 am today at 5259 Brooklyn.\nYour stay: https://prop-lane.space/resident/applications/approved",
    );
    expect(buildCheckoutReminderText({ checkOutTime: "14:00" })).toBe("Checkout is at 2:00 pm today.");
  });
});
