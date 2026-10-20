import { describe, expect, it } from "vitest";
import { feeFactLabel, feeModalLine, feeOutcomeToast, groupServiceByCity, serviceRowFacts, type ServiceRow } from "@/components/portal/admin-service-panel";
import { serviceWorkspaceFinancesHref } from "@/lib/service/service-links";

const row = (over: Partial<ServiceRow>): ServiceRow => ({
  id: "1",
  name: "WS",
  city: null,
  ownerOfRecord: null,
  isDefault: false,
  houseCount: 0,
  workNumber: null,
  workNumberSource: null,
  teamCount: 1,
  viewerRole: "admin",
  canManage: true,
  ...over,
});

describe("Service list sections", () => {
  it("groups per city with Seattle first, the rest alphabetical, no city last", () => {
    const groups = groupServiceByCity([
      row({ id: "a", city: "Portland" }),
      row({ id: "b", city: null }),
      row({ id: "c", city: "seattle" }),
      row({ id: "d", city: "Austin" }),
      row({ id: "e", city: "Seattle " }),
    ]);
    expect(groups.map((g) => [g.city, g.rows.map((r) => r.id)])).toEqual([
      ["seattle", ["c", "e"]],
      ["Austin", ["d"]],
      ["Portland", ["a"]],
      [null, ["b"]],
    ]);
  });

  it("row facts: houses, the number it texts from, team, the management fee", () => {
    expect(serviceRowFacts(row({ houseCount: 2, workNumber: "+12065550100", teamCount: 3, feePercent: 10 })).map((f) => (typeof f === "string" ? f : f.label))).toEqual([
      "2 houses",
      "+12065550100",
      "3 on team",
      "10% fee",
    ]);
    expect(serviceRowFacts(row({ viewerRole: null })).map((f) => (typeof f === "string" ? f : f.label))).toContain("Not on team");
    expect(serviceRowFacts(row({})).map((f) => (typeof f === "string" ? f : f.label))).toContain("No fee yet");
  });

  // A rate change never takes effect mid-month, so the row says what is in force AND what takes over, with the day.
  it("a scheduled rate change is named on the row with the day it starts", () => {
    expect(feeFactLabel({ feePercent: 10, scheduledFeePercent: 15, scheduledFeeFrom: "2026-11-01" })).toBe("10% fee · 15% from Nov 1");
    expect(feeFactLabel({ feePercent: 10, scheduledFeePercent: null, scheduledFeeFrom: null })).toBe("10% fee");
  });

  // Review fix, Oct 20: the modal said "Takes effect <1st>" even when the typed rate was the one already in force,
  // where nothing takes effect and a pending change is cancelled instead.
  it("the fee modal line names the real outcome, and says nothing when there is none", () => {
    const live = { feePercent: 10, scheduledFeePercent: null };
    expect(feeModalLine(live, "15", "2026-11-01")).toBe("Takes effect November 1");
    expect(feeModalLine(live, "10", "2026-11-01")).toBeNull();
    expect(feeModalLine({ feePercent: 10, scheduledFeePercent: 15 }, "10", "2026-11-01")).toBe("Cancels the scheduled change");
    expect(feeModalLine(live, "", "2026-11-01")).toBeNull();
    expect(feeModalLine(live, "31", "2026-11-01")).toBeNull();
    expect(feeModalLine({ feePercent: null, scheduledFeePercent: null }, "10", "2026-11-01")).toBe("Takes effect November 1");
  });

  it("the toast says which of the three things happened", () => {
    expect(feeOutcomeToast({ scheduled: { effectiveFrom: "2026-11-01" } }, false)).toBe("Management fee scheduled for November 1.");
    expect(feeOutcomeToast({ scheduled: null }, true)).toBe("Scheduled change cancelled.");
    expect(feeOutcomeToast({ scheduled: null }, false)).toBe("Management fee unchanged.");
  });

  it("leaves the Finances link slot empty until W17 fills it", () => {
    expect(serviceWorkspaceFinancesHref("x")).toBeNull();
  });
});
