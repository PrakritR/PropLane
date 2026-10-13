import { describe, expect, it } from "vitest";
import { bookingRecordPathFromNotice } from "@/lib/booking-notice-link";

describe("bookingRecordPathFromNotice", () => {
  it("finds the booking record page in a notice", () => {
    const body = "New Airbnb booking · 4709A 8th Ave · Room 9 · Oct 13 – Oct 16 (3 nights) · HMHW5SHXRB\n\nhttps://proplane.ai/portal/bookings/airbnb%3Ap1%3Ar9%3A2026-10-13%3A2026-10-15%3AReserved/overview";
    expect(bookingRecordPathFromNotice(body)).toBe("/portal/bookings/airbnb%3Ap1%3Ar9%3A2026-10-13%3A2026-10-15%3AReserved/overview");
  });
  it("ignores bucket pages and unrelated text", () => {
    expect(bookingRecordPathFromNotice("See https://proplane.ai/portal/bookings/calendar")).toBeNull();
    expect(bookingRecordPathFromNotice("See /portal/bookings/upcoming/x")).toBeNull();
    expect(bookingRecordPathFromNotice("hello")).toBeNull();
    expect(bookingRecordPathFromNotice(null)).toBeNull();
  });
});
