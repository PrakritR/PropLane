import { describe, expect, it } from "vitest";
import {
  RESIDENT_STAY_FILTER_DEFAULT,
  hasPhoneOnRecord,
  hasRealEmail,
  isShortStay,
  matchesContactFilter,
  matchesStayFilter,
  phoneRequestMessage,
} from "@/lib/resident-list-filters";

describe("isShortStay: who is a guest, not a long-term resident", () => {
  it("a booking residency, a non-standard rental type, an iCal source or a channel stay is a short stay", () => {
    expect(isShortStay({ bookingResidency: true })).toBe(true);
    expect(isShortStay({ application: { rentalType: "short_term" } })).toBe(true);
    expect(isShortStay({ application: { rentalType: "airbnb" } })).toBe(true);
    expect(isShortStay({ icalConnectionId: "conn-1" })).toBe(true);
    expect(isShortStay({ icalSourceUid: "HMX4K2" })).toBe(true);
    expect(isShortStay({ channelStay: { sourceLabel: "Airbnb" } })).toBe(true);
  });

  it("a standard application, or one with no rental type at all, is long-term", () => {
    expect(isShortStay({ application: { rentalType: "standard" } })).toBe(false);
    expect(isShortStay({ application: {} })).toBe(false);
    expect(isShortStay({ application: null })).toBe(false);
    expect(isShortStay({ bookingResidency: false, icalConnectionId: "", icalSourceUid: null })).toBe(false);
    expect(isShortStay({})).toBe(false);
    expect(isShortStay(null)).toBe(false);
  });
});

describe("Residents Stay filter: Current counts long-term people by default", () => {
  // 12 residents, 16 guests, like the Nov 9 review (Dashboard 23 / 28 rooms).
  const residents = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, isShortStay: false, phoneOnRecord: i < 3 }));
  const guests = Array.from({ length: 16 }, (_, i) => ({ id: `g${i}`, isShortStay: true, phoneOnRecord: false }));
  const all = [...residents, ...guests];
  const count = (filter: Parameters<typeof matchesStayFilter>[1]) => all.filter((r) => matchesStayFilter(r.isShortStay, filter)).length;

  it("defaults to Long-term", () => {
    expect(RESIDENT_STAY_FILTER_DEFAULT).toBe("long_term");
    expect(count(RESIDENT_STAY_FILTER_DEFAULT)).toBe(12);
  });

  it("Short stays lists the guests, All lists everyone", () => {
    expect(count("short")).toBe(16);
    expect(count("all")).toBe(28);
  });

  it("Missing phone narrows to people with no phone on record", () => {
    const longTerm = all.filter((r) => matchesStayFilter(r.isShortStay, "long_term"));
    expect(longTerm.filter((r) => matchesContactFilter(r.phoneOnRecord, "missing_phone"))).toHaveLength(9);
    expect(longTerm.filter((r) => matchesContactFilter(r.phoneOnRecord, "all"))).toHaveLength(12);
  });
});

describe("contact facts", () => {
  it("a phone is on record only with real digits", () => {
    expect(hasPhoneOnRecord("(510) 309-8345")).toBe(true);
    expect(hasPhoneOnRecord("", undefined, null)).toBe(false);
    expect(hasPhoneOnRecord("n/a", "—")).toBe(false);
    expect(hasPhoneOnRecord(undefined, "510-309-8345")).toBe(true);
  });

  it("an import placeholder or empty email is not a real mailbox", () => {
    expect(hasRealEmail("kchan440@gmail.com")).toBe(true);
    expect(hasRealEmail("prakrit-5257-room9@import.proplane.local")).toBe(false);
    expect(hasRealEmail("")).toBe(false);
    expect(hasRealEmail(null)).toBe(false);
  });

  it("the ask-for-phone message links the profile and asks for a real email when it is a placeholder", () => {
    const url = "https://proplane.ai/resident/profile?tab=profile";
    const real = phoneRequestMessage({ name: "Baljinnyam D.", hasRealEmail: true, profileUrl: url });
    expect(real).toContain("Hi Baljinnyam");
    expect(real).toContain(url);
    expect(real).not.toMatch(/real email/);
    expect(phoneRequestMessage({ name: "Prakrit", hasRealEmail: false, profileUrl: url })).toMatch(/real email/);
  });
});
