import { describe, expect, it } from "vitest";
import {
  buildWorkspaceBrowsePath,
  listingBrowseShortToken,
  resolveBrowseTokensToPropertyIds,
} from "@/lib/workspace-browse-links";

describe("workspace browse links", () => {
  it("builds /rent/w slug with short l tokens", () => {
    const path = buildWorkspaceBrowsePath("Seattle Homes", ["prop_alder", "mgr-seed-maple"]);
    expect(path).toMatch(/^\/rent\/w\/seattle-homes\?l=/);
    expect(path).toContain("alder");
    expect(path).toContain("maple");
  });

  it("resolves short tokens to authorized ids", () => {
    const authorized = ["mgr-seed-alder-ave", "mgr-seed-maple-st"];
    expect(resolveBrowseTokensToPropertyIds(["alder", "maple"], authorized)).toEqual(authorized);
    expect(listingBrowseShortToken("prop_alder")).toBe("alder");
  });
});
