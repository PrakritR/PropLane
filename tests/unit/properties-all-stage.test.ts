/**
 * "Like Zillow all houses are there. When I need to list I just click."
 *
 * Properties used to open on the Listed tab, so a home the manager had taken off
 * the market was on a different screen from the one they were letting — not "there"
 * at all. All is the default stage now, the route layer accepts it, and the nav
 * lands on it. The narrower tabs remain as filters.
 */
import { describe, expect, it } from "vitest";
import { MANAGER_STAGES, managerStageFromParam } from "@/components/portal/pro-house-properties-panel";
import { PROPERTY_STAGES, parsePropertyStage, propertyListHref } from "@/lib/portal-detail-routes";
import { MANAGER_PORTAL_SMOKE_PATHS } from "@/lib/portals/pro";

describe("every home on one list", () => {
  it("All is the first stage and covers listed, unlisted and drafts", () => {
    const all = MANAGER_STAGES[0];
    expect(all.key).toBe("all");
    expect([...all.buckets].sort()).toEqual([2, 3, 5]);
  });

  it("an unknown or missing stage lands on All, not Listed", () => {
    expect(managerStageFromParam(null)).toBe("all");
    expect(managerStageFromParam("nonsense")).toBe("all");
    expect(parsePropertyStage(undefined)).toBe("all");
    expect(parsePropertyStage("nonsense")).toBe("all");
  });

  it("the route layer knows the stage — otherwise it would redirect it away", () => {
    expect(PROPERTY_STAGES).toContain("all");
    expect(propertyListHref("/portal", "all")).toBe("/portal/properties/all");
  });

  it("the Properties smoke path opens All", () => {
    const item = MANAGER_PORTAL_SMOKE_PATHS.find((entry) => entry.label === "Properties");
    expect(item?.path).toBe("/portal/properties/all");
  });

  it("keeps the narrower stages as filters", () => {
    expect(MANAGER_STAGES.map((s) => s.key)).toEqual(["all", "listed", "unlisted", "drafts"]);
  });
});
