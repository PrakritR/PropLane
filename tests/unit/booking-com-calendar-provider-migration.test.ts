import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve("supabase/migrations/20260919010000_booking_com_calendar_provider.sql"),
  "utf8",
);

describe("booking.com calendar provider migration", () => {
  it("widens the provider check to Airbnb and Booking.com without dropping the table", () => {
    expect(sql).toContain("drop constraint if exists external_calendar_connections_provider_check");
    expect(sql).toContain("check (provider in ('airbnb', 'booking_com'))");
    expect(sql).not.toMatch(/drop table/i);
  });
});
