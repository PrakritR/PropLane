import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RESIDENT_DETAIL_TABS,
  residentDetailTabsForStage,
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

  it("puts tours on a prospect's tab strip and takes it off a tenant's", () => {
    // Tours used to be unconditional here. It is now a stage decision: a
    // potential resident is the person who tours, and a tenant is past it.
    // Asserted through the shared table rather than by grepping the component,
    // so a refactor of the component cannot fail this while the rule holds.
    expect(residentDetailTabsForStage("potential")).toContain("tours");
    expect(residentDetailTabsForStage("current")).not.toContain("tours");
    expect(residentDetailTabsForStage("past")).not.toContain("tours");

    // Whichever stage shows it, the panel must still be handed the manager's
    // portfolio property ids — without them a resident's tours do not load.
    const src = readFileSync(
      `${process.cwd()}/src/components/portal/pro-residents.tsx`,
      "utf8",
    );
    expect(src).toContain("propertyIds={managerPortfolioPropertyIds}");
    // The bucket strip moved into the tours panel this file hands off to, so read
    // it where it now lives — asserting on this file would pass again only if the
    // panel were inlined back, which is not what the guarantee is about.
    expect(src).toContain("<ManagerResidentToursPanel");
    expect(
      readFileSync(
        `${process.cwd()}/src/components/portal/pro-resident-tours-panel.tsx`,
        "utf8",
      ),
    ).toContain("RESIDENT_DETAIL_TOUR_BUCKET_TABS");
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
