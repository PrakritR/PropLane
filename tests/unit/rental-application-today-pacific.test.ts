import { describe, expect, it } from "vitest";
import { todayISO } from "@/lib/rental-application/state";

describe("rental application todayISO", () => {
  it("is the Pacific calendar day, not the UTC one", () => {
    // 6:30pm PDT on Oct 15 is already Oct 16 in UTC.
    const eveningPacific = Date.parse("2026-10-16T01:30:00Z");
    expect(new Date(eveningPacific).toISOString().slice(0, 10)).toBe("2026-10-16");
    expect(todayISO(eveningPacific)).toBe("2026-10-15");
  });

  it("matches UTC once the Pacific day has caught up", () => {
    expect(todayISO(Date.parse("2026-10-16T19:00:00Z"))).toBe("2026-10-16");
  });

  it("handles the standard-time offset in winter", () => {
    expect(todayISO(Date.parse("2026-12-01T07:30:00Z"))).toBe("2026-11-30");
  });
});
