/**
 * A listing site is a record page: /portal/promotion/listing-sites/<channelId>[/<tab>]
 * (studio plan listing-site-record-1009). Every site's page must resolve to a real route, a bad id must
 * 404, and the path must never collide with a promotion asset id.
 */
import { describe, expect, it, vi } from "vitest";

import { routeResolves } from "../helpers/route-resolves";
import { LISTING_CHANNEL_DEFS } from "@/lib/listing-channels/registry";
import {
  LISTING_SITE_TABS,
  listingSiteDetailHref,
  listingSitesListHref,
  parseListingSiteTab,
} from "@/lib/portal-detail-routes";
import { makePromotionAssetId } from "@/lib/promotion-assets";
import { ALL_RECORD_KINDS, recordSections } from "@/lib/portals/record-sections";

class RedirectError extends Error {
  constructor(public readonly to: string) {
    super(`NEXT_REDIRECT ${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectError(to);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/server-profile", () => ({ getServerSessionProfile: async () => ({ user: null, profile: null }) }));
vi.mock("@/lib/portals/pro-nav", () => ({ getProPortalRenderContext: async () => ({}) }));

const ListingSitePage = (await import("@/app/portal/promotion/listing-sites/[[...tab]]/page")).default;

async function outcome(tab: string[] | undefined): Promise<string> {
  try {
    await ListingSitePage({ params: Promise.resolve({ tab }) });
  } catch (e) {
    if (e instanceof RedirectError) return `redirect:${e.to}`;
    if (e instanceof Error && e.message === "NEXT_NOT_FOUND") return "notFound";
    throw e;
  }
  return "rendered";
}

describe("listing site record routes", () => {
  it.each(LISTING_CHANNEL_DEFS.map((d) => d.id))("%s: every tab's href resolves under src/app", (id) => {
    for (const tab of LISTING_SITE_TABS) {
      const href = listingSiteDetailHref("/portal", id, tab);
      expect(href).toBe(`/portal/promotion/listing-sites/${id}/${tab}`);
      expect(routeResolves(href), href).toBe(true);
    }
  });

  it("the bare listing-sites path and the list href resolve too", () => {
    expect(routeResolves("/portal/promotion/listing-sites")).toBe(true);
    expect(routeResolves("/portal/promotion")).toBe(true);
    expect(listingSitesListHref("/portal")).toBe("/portal/promotion?kind=sites");
  });

  it("the record rail's own hrefs are the same builder", () => {
    const sections = recordSections("manager", "listingSite", { basePath: "/portal" });
    const hrefs = sections.groups.flatMap((g) => g.items.map((i) => i.href("craigslist")));
    expect(hrefs).toEqual(LISTING_SITE_TABS.map((t) => `/portal/promotion/listing-sites/craigslist/${t}`));
  });

  it("is registered as a manager record kind with Overview · Listings · Post · Leads and nothing else", () => {
    expect(ALL_RECORD_KINDS).toContainEqual({ role: "manager", kind: "listingSite" });
    const ids = recordSections("manager", "listingSite").groups.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toEqual(["overview", "listings", "post", "leads"]);
  });

  it("header icons are only ones the page wires (no Coming soon placeholders)", () => {
    for (const section of ["overview", "listings", "post", "leads"]) {
      const ids = recordSections("manager", "listingSite", {}, section).headerActions.map((a) => a.id);
      for (const id of ids) expect(["open-site", "copy", "download"]).toContain(id);
    }
    expect(recordSections("manager", "listingSite", {}, "post").headerActions[0]?.id).toBe("copy");
  });

  it("a promotion asset id is never the reserved listing-sites segment", () => {
    expect(makePromotionAssetId("row_1", "flyer", "e1").startsWith("listing-sites")).toBe(false);
    expect(makePromotionAssetId("listing-sites", "text", "e1")).toContain("::");
  });

  it("parses only the four tabs", () => {
    for (const tab of LISTING_SITE_TABS) expect(parseListingSiteTab(tab)).toBe(tab);
    expect(parseListingSiteTab("bogus")).toBeNull();
    expect(parseListingSiteTab("")).toBeNull();
  });

  it("the bare path goes to Promotion › Listing sites", async () => {
    expect(await outcome(undefined)).toBe("redirect:/portal/promotion?kind=sites");
  });

  it("an unknown site, a bad tab or an extra segment 404", async () => {
    expect(await outcome(["not-a-site"])).toBe("notFound");
    expect(await outcome(["not-a-site", "overview"])).toBe("notFound");
    expect(await outcome(["craigslist", "bogus"])).toBe("notFound");
    expect(await outcome(["craigslist", "overview", "extra"])).toBe("notFound");
  });

  it("a site with no tab lands on Overview; a partner-only site has no Post tab", async () => {
    expect(await outcome(["craigslist"])).toBe("redirect:/portal/promotion/listing-sites/craigslist/overview");
    expect(await outcome(["apartment_list", "post"])).toBe("redirect:/portal/promotion/listing-sites/apartment_list/overview");
  });
});
