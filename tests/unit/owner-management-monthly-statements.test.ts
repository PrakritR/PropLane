import { describe, expect, it } from "vitest";
import { monthName, statementText } from "@/lib/owner-management/monthly-statements.server";

describe("the monthly owner text", () => {
  it("names the month and reads plainly with the figures from the ledger", () => {
    expect(monthName("2026-10")).toBe("October 2026");
    const t = statementText({ monthKey: "2026-10", workspaceName: "Seattle Homes", rentCents: 400_000, feeCents: -40_000, vendorCents: -24_000, netCents: 336_000, balanceCents: 336_000, link: "https://app.test/x" });
    expect(t).toBe("October 2026 statement, Seattle Homes: rent $4,000.00 PropLane -$400.00 repairs -$240.00 you net $3,360.00. Balance $3,360.00. https://app.test/x");
    expect(/^[\x20-\x7e]+$/.test(t)).toBe(true);
  });
  it("leaves out lines that are zero", () => {
    const t = statementText({ monthKey: "2026-12", workspaceName: "W", rentCents: 100_000, feeCents: 0, vendorCents: 0, netCents: 100_000, balanceCents: 100_000, link: "l" });
    expect(t).not.toContain("PropLane");
    expect(t).not.toContain("repairs");
  });
});
