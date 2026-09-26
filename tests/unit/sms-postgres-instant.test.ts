import { describe, expect, it } from "vitest";
import { postgresInstantMicros, samePostgresInstant } from "@/lib/sms/postgres-instant.mjs";

describe("PostgreSQL microsecond instants", () => {
  it("preserves the exact microsecond through timezone and fraction representations", () => {
    expect(samePostgresInstant("2026-09-25T12:00:00.123456Z", "2026-09-25 08:00:00.123456-04:00")).toBe(true);
    expect(samePostgresInstant("2026-09-25T12:00:00.123456Z", "2026-09-25T12:00:00.123457Z")).toBe(false);
    expect(samePostgresInstant("2026-09-25T12:00:00.1Z", "2026-09-25T12:00:00.100000+00:00")).toBe(true);
  });
  it("refuses malformed types, dates, zones and unsupported precision", () => {
    for (const value of [null, 0, new Date(), "2026-02-30T12:00:00Z", "2026-09-25T12:00:00", "2026-09-25T12:00:00+16:00", "2026-09-25T12:00:00.1234567Z"]) {
      expect(postgresInstantMicros(value)).toBeNull();
      expect(samePostgresInstant(value, value)).toBe(false);
    }
  });
});
