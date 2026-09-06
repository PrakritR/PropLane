import { describe, expect, it } from "vitest";
import { formatPacificDate, pacificCalendarDateYmd, safeFormatDateTime } from "@/lib/pacific-time";

describe("pacific-time", () => {
  it("formats dates in Pacific time", () => {
    const formatted = formatPacificDate("2026-06-15", { month: "short", day: "numeric", year: "numeric" });
    expect(formatted).toContain("2026");
  });

  it("returns fallback for invalid datetime", () => {
    expect(safeFormatDateTime("not-a-date", "N/A")).toBe("N/A");
  });

  it("stamps today's Pacific calendar date", () => {
    expect(pacificCalendarDateYmd(Date.parse("2026-09-05T23:30:00-04:00"))).toBe("2026-09-05");
    expect(pacificCalendarDateYmd(Date.parse("2026-09-06T00:30:00-04:00"))).toBe("2026-09-05");
  });
});
