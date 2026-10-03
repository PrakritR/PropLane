import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve("supabase/migrations/20261003200000_channel_calendar_vrbo.sql"), "utf8");

describe("Vrbo calendar provider migration", () => {
  it("widens the provider check to Airbnb, Booking.com and Vrbo, idempotently, without touching rows", () => {
    expect(sql).toContain("drop constraint if exists external_calendar_connections_provider_check");
    expect(sql).toContain("check (provider in ('airbnb', 'booking_com', 'vrbo'))");
    expect(sql).not.toMatch(/drop table|delete from|update public/i);
  });
});
