import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RESIDENT_DETAIL_TABS,
} from "@/lib/portal-detail-routes";
import {
  RESIDENT_DETAIL_APPLICATION_BUCKET_TABS,
  RESIDENT_DETAIL_LEASE_PIPELINE_TABS,
  RESIDENT_DETAIL_TOUR_BUCKET_TABS,
} from "@/lib/resident-detail-subsection-tabs";

describe("resident detail tab chrome", () => {
  it("lists tours first in the canonical resident detail tab order", () => {
    expect(RESIDENT_DETAIL_TABS[0]).toBe("tours");
  });

  it("application subsection pills match the Applications hub buckets", () => {
    expect(RESIDENT_DETAIL_APPLICATION_BUCKET_TABS.map((tab) => tab.id)).toEqual([
      "pending",
      "approved",
      "rejected",
    ]);
  });

  it("lease subsection pills match the Leases hub pipeline stages", () => {
    expect(RESIDENT_DETAIL_LEASE_PIPELINE_TABS.map((tab) => tab.label)).toEqual([
      "Manager review",
      "Resident signature",
      "Manager signature",
      "Signed",
    ]);
  });

  it("tours subsection pills match the portfolio Tours hub buckets", () => {
    expect(RESIDENT_DETAIL_TOUR_BUCKET_TABS.map((tab) => tab.id)).toEqual([
      "pending",
      "upcoming",
      "past",
    ]);
  });

  it("manager resident detail always includes tours in the tab strip", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/portal/pro-residents.tsx`,
      "utf8",
    );
    expect(src).toContain('const tabs: ResidentDetailTabId[] = ["tours"]');
    expect(src).not.toContain("showResidentTours");
    expect(src).toContain("propertyIds={managerPortfolioPropertyIds}");
    expect(src).toContain("RESIDENT_DETAIL_TOUR_BUCKET_TABS");
  });

  it("shared subsection chrome uses equal-width destination nav", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/portal/resident-detail-subsection-chrome.tsx`,
      "utf8",
    );
    expect(src).toContain('itemLayout="equal"');
    expect(src).toContain("ResidentDetailCommandToolbar");
  });
});
