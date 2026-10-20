import { describe, expect, it } from "vitest";
import { arrivalLabel, buildSmsDeepLink, extractPropertyLabelHint, listingTextUsBody, looksLikeProspectLeasingCta, shortStayDatesLabel } from "@/lib/claw-leasing-links";

describe("the listing page's Text us draft (captain, Oct 20)", () => {
  it("books in the captain's words", () => {
    expect(
      listingTextUsBody({ kind: "book", propertyLabel: "4709A 8th Ave", roomName: "Room 8", checkIn: "2026-10-20", checkOut: "2026-10-21", guests: 1, arrival: "13:00" }),
    ).toBe("Hi, I'd like to book 4709A 8th Ave · Room 8 · Oct 20–21 · 1 guest · arrive 1 pm");
  });

  it("asks to tour or apply on a monthly listing, with the move-in day", () => {
    expect(listingTextUsBody({ kind: "monthly", propertyLabel: "4534 Darrow Ct", roomName: "Room 2", moveIn: "2026-11-01" })).toBe(
      "Hi, I'd like to tour or apply for 4534 Darrow Ct · Room 2 · move-in Nov 1",
    );
  });

  it("spans months, counts guests and drops what was not picked", () => {
    expect(shortStayDatesLabel("2026-10-30", "2026-11-02")).toBe("Oct 30–Nov 2");
    expect(listingTextUsBody({ kind: "book", propertyLabel: "61 Willow Ct", checkIn: "2026-10-30", checkOut: "2026-11-02", guests: 2 })).toBe("Hi, I'd like to book 61 Willow Ct · Oct 30–Nov 2 · 2 guests");
    expect(listingTextUsBody({ kind: "monthly", propertyLabel: "61 Willow Ct" })).toBe("Hi, I'd like to tour or apply for 61 Willow Ct");
  });

  it("writes arrival times the way people say them", () => {
    expect(arrivalLabel("09:30")).toBe("9:30 am");
    expect(arrivalLabel("12:00")).toBe("12 pm");
    expect(arrivalLabel("00:00")).toBe("12 am");
  });

  it("is an sms: link to the listing's number, and the inbound side reads it as a leasing text for that home", () => {
    const href = buildSmsDeepLink({ intent: "book", toPhone: "+12066781909", propertyLabel: "4709A 8th Ave", roomName: "Room 8", stay: { checkIn: "2026-10-20", checkOut: "2026-10-21", guests: 1, arrival: "13:00" } });
    expect(href.startsWith("sms:+12066781909?&body=")).toBe(true);
    const body = decodeURIComponent(href.split("body=")[1]!);
    expect(body).toBe("Hi, I'd like to book 4709A 8th Ave · Room 8 · Oct 20–21 · 1 guest · arrive 1 pm");
    expect(looksLikeProspectLeasingCta(body)).toBe(true);
    expect(extractPropertyLabelHint(body)).toBe("4709A 8th Ave");
    const monthly = "Hi, I'd like to tour or apply for 4534 Darrow Ct · Room 2 · move-in Nov 1";
    expect(looksLikeProspectLeasingCta(monthly)).toBe(true);
    expect(extractPropertyLabelHint(monthly)).toBe("4534 Darrow Ct");
    expect(buildSmsDeepLink({ intent: "book", toPhone: null, propertyLabel: "4709A 8th Ave" })).toBe("#");
  });
});
