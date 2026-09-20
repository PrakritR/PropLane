import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";
import type { MockProperty } from "@/data/types";

let FEED_ROW: { manager_user_id: string; enabled: boolean } | null;
let PROPERTY_RECORDS: { id: string; property_data: unknown }[];
let PUBLIC_LISTINGS: MockProperty[];

vi.mock("@/lib/public-listings.server", () => ({
  getPublicListings: vi.fn(async () => PUBLIC_LISTINGS),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from(table: string) {
      if (table === "manager_syndication_feeds") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: FEED_ROW, error: null }),
        };
      }
      if (table === "manager_property_records") {
        const builder: Record<string, unknown> = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: PROPERTY_RECORDS, error: null }).then(resolve),
        };
        return builder;
      }
      throw new Error(`Unexpected table in test: ${table}`);
    },
  }),
}));

import { GET } from "@/app/api/feeds/zillow/[feedKey]/route";

function listing(overrides: Partial<MockProperty> = {}): MockProperty {
  return {
    id: "prop-1",
    title: "Ballard House",
    tagline: "",
    address: "123 Main St",
    zip: "98107",
    neighborhood: "Ballard",
    beds: 3,
    baths: 2,
    rentLabel: "$2,200/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Ballard House",
    unitLabel: "",
    managerUserId: "mgr-1",
    listingSubmission: {
      v: 1,
      buildingName: "Ballard House",
      address: "123 Main St",
      zip: "98107",
      listingPlaceCategoryId: "entire_home",
      houseOverview: "Lovely",
      housePhotoDataUrls: ["https://cdn.proplane.test/p.jpg"],
      entireHomeMonthlyRent: 2200,
      rooms: [],
    },
    ...overrides,
  } as unknown as MockProperty;
}

function propertyRecord(id: string, opts: { managerUserId: string; enabled: boolean }): { id: string; property_data: unknown } {
  return {
    id,
    property_data: {
      listingSubmission: { syndication: { zillow: { enabled: opts.enabled } } },
    },
  };
}

async function getFeed(feedKey: string) {
  return GET(jsonRequest(`http://localhost/api/feeds/zillow/${feedKey}`), {
    params: Promise.resolve({ feedKey }),
  });
}

describe("GET /api/feeds/zillow/[feedKey]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FEED_ROW = null;
    PROPERTY_RECORDS = [];
    PUBLIC_LISTINGS = [];
  });

  it("404s for an unknown feed key", async () => {
    FEED_ROW = null;
    const res = await getFeed("does-not-exist");
    expect(res.status).toBe(404);
  });

  it("404s for a disabled feed", async () => {
    FEED_ROW = { manager_user_id: "mgr-1", enabled: false };
    const res = await getFeed("some-key");
    expect(res.status).toBe(404);
  });

  it("serves XML with the right content type for a known, enabled feed", async () => {
    FEED_ROW = { manager_user_id: "mgr-1", enabled: true };
    PROPERTY_RECORDS = [propertyRecord("prop-1", { managerUserId: "mgr-1", enabled: true })];
    PUBLIC_LISTINGS = [listing()];
    const res = await getFeed("some-key");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("<hotPadsItems");
    expect(body).toContain('id="prop-1"');
  });

  it("includes only THIS manager's opted-in, published listings — not another manager's or an opted-out one", async () => {
    FEED_ROW = { manager_user_id: "mgr-1", enabled: true };
    PROPERTY_RECORDS = [
      propertyRecord("prop-1", { managerUserId: "mgr-1", enabled: true }),
      propertyRecord("prop-2", { managerUserId: "mgr-1", enabled: false }), // opted out
    ];
    PUBLIC_LISTINGS = [
      listing({ id: "prop-1", managerUserId: "mgr-1" }),
      listing({ id: "prop-2", managerUserId: "mgr-1", title: "Opted-out House" }),
      listing({ id: "prop-3", managerUserId: "mgr-other", title: "Another manager's house" }), // wrong manager
    ];
    const res = await getFeed("some-key");
    const body = await res.text();
    expect(body).toContain('id="prop-1"');
    expect(body).not.toContain('id="prop-2"');
    expect(body).not.toContain('id="prop-3"');
    expect(body).not.toContain("Another manager's house");
  });
});
