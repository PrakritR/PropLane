import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/public-listings.server", () => ({
  getPublicListings: vi.fn(),
}));

import { getPublicListings } from "@/lib/public-listings.server";
import { LEASING_SMS_AGENT_SYSTEM_PROMPT } from "@/lib/agent/system-prompts";
import { leasingSmsAgentRegistry, LEASING_SMS_INLINE_WRITE_TOOLS } from "@/lib/tools";
import type { AgentContext } from "@/lib/tools/context";
import {
  __resetLeasingCatalogCache,
  buildProspectLinksTool,
  getListingDetailsTool,
  getSiteLinksTool,
  LEASING_ESCALATE_TOOL_NAME,
  listLiveListingsTool,
  listingSummaryMatches,
  proplaneSiteLinks,
  summarizeListingRecord,
  type RawPropertyRecord,
} from "@/lib/tools/domains/leasing-sms";

const PROD_ORIGIN = "https://prop-lane.space";

/** Minimal chainable Supabase mock: owned queries resolve to the given result. */
function makeDb(result: { many?: unknown; single?: unknown }) {
  const many = result.many ?? { data: [], error: null };
  const single = result.single ?? { data: null, error: null };
  const q: Record<string, unknown> = {};
  const ret = () => q;
  for (const m of ["select", "eq", "in", "order", "limit", "gte", "not", "maybeSingle"]) {
    q[m] = m === "maybeSingle" ? () => Promise.resolve(single) : ret;
  }
  q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(many).then(res, rej);
  return { from: () => q } as unknown as AgentContext["db"];
}

function ctxFor(opts: {
  crossCatalog: boolean;
  owned?: { many?: unknown; single?: unknown };
  landlordId?: string;
  prospectPhone?: string;
}): AgentContext {
  return {
    landlordId: opts.landlordId ?? "primary-manager",
    userId: opts.landlordId ?? "primary-manager",
    email: "",
    roles: ["leasing_sms_agent"],
    isAdmin: false,
    db: makeDb(opts.owned ?? {}),
    leasingScope: {
      sessionId: "sess-1",
      prospectPhoneE164: opts.prospectPhone ?? "+12065551234",
      workNumber: "+12053690702",
      crossCatalog: opts.crossCatalog,
    },
  } as AgentContext;
}

/** A public-catalog listing (as getPublicListings would return it). */
function catalogListing(over: Record<string, unknown> = {}) {
  return {
    id: "mgr-seed-4709a-8th-ave-ne",
    title: "4709A 8th Ave NE",
    buildingName: "4709A 8th Ave NE",
    address: "4709A 8th Ave NE, Seattle, WA",
    neighborhood: "University District",
    rentLabel: "$1,200/mo",
    available: "Now",
    beds: 4,
    baths: 2,
    managerUserId: "owner-ogambik",
    ...over,
  };
}

beforeEach(() => {
  __resetLeasingCatalogCache();
  (getPublicListings as unknown as ReturnType<typeof vi.fn>).mockReset();
  process.env.PROPLANE_SMS_LINK_ORIGIN = PROD_ORIGIN;
  process.env.CLAW_MESSENGER_LINK_ORIGIN = PROD_ORIGIN;
});

describe("leasing SMS agent registry", () => {
  it("exposes listing, site-link, and escalate tools", () => {
    expect([...leasingSmsAgentRegistry.keys()].sort()).toEqual(
      [
        "build_prospect_links",
        "escalate_to_manager",
        "get_listing_details",
        "get_site_links",
        "list_live_listings",
        "list_open_tour_slots",
        "request_tour",
      ].sort(),
    );
  });

  /**
   * A texting prospect is anonymous, so there is no `user_id` for a pending
   * action to be claimed on: a confirmation card here is not merely absent, it
   * is impossible. Every write on this surface therefore has to be one that
   * only NOTIFIES the manager — an escalation, or a tour REQUEST the manager
   * still confirms. Nothing that books, charges, sends on the manager's behalf,
   * or reads personal data may join them.
   */
  it("allows only request-shaped writes, and allow-lists exactly those", () => {
    const writes = [...leasingSmsAgentRegistry.values()].filter((t) => t.kind === "write");
    expect(writes.map((t) => t.name).sort()).toEqual([LEASING_ESCALATE_TOOL_NAME, "request_tour"].sort());
    // Every write in the registry is inline allow-listed, and nothing else is:
    // a write that is neither would be invisible AND unconfirmable.
    expect([...LEASING_SMS_INLINE_WRITE_TOOLS].sort()).toEqual(writes.map((t) => t.name).sort());
  });
});

describe("leasing SMS system prompt", () => {
  it("requires tool-grounded facts, SMS style, and untrusted-input posture", () => {
    expect(LEASING_SMS_AGENT_SYSTEM_PROMPT).toMatch(/ONLY from tool results/i);
    expect(LEASING_SMS_AGENT_SYSTEM_PROMPT).toMatch(/SMS-short/i);
    expect(LEASING_SMS_AGENT_SYSTEM_PROMPT).toMatch(/untrusted input/i);
  });

  it("teaches cross-catalog lookup and per-message property re-resolution", () => {
    expect(LEASING_SMS_AGENT_SYSTEM_PROMPT).toMatch(/ANY live PropLane listing/i);
    expect(LEASING_SMS_AGENT_SYSTEM_PROMPT).toMatch(/re-resolve/i);
    expect(LEASING_SMS_AGENT_SYSTEM_PROMPT).toMatch(/discussed earlier/i);
  });

  it("carries product knowledge and never says Axis", () => {
    expect(LEASING_SMS_AGENT_SYSTEM_PROMPT).toMatch(/get_site_links/);
    expect(LEASING_SMS_AGENT_SYSTEM_PROMPT).not.toMatch(/\bAxis\b/);
  });
});

describe("pure listing helpers", () => {
  const rec: RawPropertyRecord = {
    id: "p1",
    status: "live",
    property_data: { buildingName: "Ballard Commons", address: "100 NW 1st", neighborhood: "Ballard" },
    row_data: null,
  };

  it("summarizes a record's public fields", () => {
    const s = summarizeListingRecord(rec);
    expect(s.propertyId).toBe("p1");
    expect(s.title).toBe("Ballard Commons");
    expect(s.neighborhood).toBe("Ballard");
  });

  it("matches on title / address / neighborhood needles", () => {
    const s = summarizeListingRecord(rec);
    expect(listingSummaryMatches(s, "ballard")).toBe(true);
    expect(listingSummaryMatches(s, "1st")).toBe(true);
    expect(listingSummaryMatches(s, "")).toBe(true);
    expect(listingSummaryMatches(s, "fremont")).toBe(false);
  });
});

describe("proplaneSiteLinks", () => {
  it("builds production-origin links, never localhost", () => {
    const links = proplaneSiteLinks(PROD_ORIGIN);
    expect(links.browseHomes).toBe(`${PROD_ORIGIN}/rent`);
    expect(links.startApplication).toBe(`${PROD_ORIGIN}/rent/apply`);
    expect(links.pricing).toBe(`${PROD_ORIGIN}/pricing`);
    for (const url of Object.values(links)) {
      expect(url).not.toMatch(/localhost|127\.0\.0\.1/);
    }
  });
});

describe("cross-catalog listing resolution (shared PropLane line)", () => {
  it("finds a listing owned by a DIFFERENT manager via the public catalog", async () => {
    (getPublicListings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([catalogListing()]);
    // ctx.landlordId is the primary manager (does NOT own mgr-seed-4709a); owned lookup returns null.
    const ctx = ctxFor({ crossCatalog: true });

    const details = await getListingDetailsTool.handler(ctx, {
      propertyId: "mgr-seed-4709a-8th-ave-ne",
    });
    expect(details.found).toBe(true);
    expect(details.listing?.propertyId).toBe("mgr-seed-4709a-8th-ave-ne");
    expect(details.listing?.title).toBe("4709A 8th Ave NE");
  });

  it("list_live_listings spans the whole catalog and filters by query", async () => {
    (getPublicListings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      catalogListing(),
      catalogListing({ id: "mgr-te-demo-ballard", title: "Ballard Commons", buildingName: "Ballard Commons", address: "1 Ballard Ave", managerUserId: "owner-te" }),
    ]);
    const ctx = ctxFor({ crossCatalog: true });
    const res = await listLiveListingsTool.handler(ctx, { query: "8th Ave" });
    expect(res.count).toBe(1);
    expect(res.listings[0]?.propertyId).toBe("mgr-seed-4709a-8th-ave-ne");
  });

  it("build_prospect_links mints production apply URL prefilled with the prospect phone", async () => {
    (getPublicListings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([catalogListing()]);
    const ctx = ctxFor({ crossCatalog: true, prospectPhone: "+12065559999" });
    const links = await buildProspectLinksTool.handler(ctx, {
      propertyId: "mgr-seed-4709a-8th-ave-ne",
    });
    expect(links.ok).toBe(true);
    expect(links.applyUrl).toContain(PROD_ORIGIN);
    expect(links.applyUrl).toContain("propertyId=mgr-seed-4709a-8th-ave-ne");
    expect(links.applyUrl).toContain("phone=%2B12065559999");
    expect(links.applyUrl).not.toMatch(/localhost/);
    expect(links.listingUrl).toBe(`${PROD_ORIGIN}/rent/listings/mgr-seed-4709a-8th-ave-ne`);
  });
});

describe("per-manager line stays scoped (no cross-catalog leakage)", () => {
  it("does NOT resolve another manager's listing when crossCatalog is false", async () => {
    (getPublicListings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([catalogListing()]);
    const ctx = ctxFor({ crossCatalog: false });
    const details = await getListingDetailsTool.handler(ctx, {
      propertyId: "mgr-seed-4709a-8th-ave-ne",
    });
    expect(details.found).toBe(false);
    // The public catalog must not even be consulted on a scoped line.
    expect(getPublicListings).not.toHaveBeenCalled();
  });

  it("list_live_listings uses only the manager's own rows when scoped", async () => {
    const ownedRow = {
      id: "portal-demo-prop-live",
      status: "live",
      property_data: { buildingName: "My House", address: "5 Own St" },
      row_data: null,
    };
    const ctx = ctxFor({ crossCatalog: false, owned: { many: { data: [ownedRow], error: null } } });
    const res = await listLiveListingsTool.handler(ctx, {});
    expect(res.count).toBe(1);
    expect(res.listings[0]?.propertyId).toBe("portal-demo-prop-live");
    expect(getPublicListings).not.toHaveBeenCalled();
  });
});

describe("get_site_links tool", () => {
  it("returns production-origin canonical links", async () => {
    const res = await getSiteLinksTool.handler(ctxFor({ crossCatalog: true }), {});
    expect(res.links.browseHomes).toBe(`${PROD_ORIGIN}/rent`);
    expect(res.links.startApplication).toBe(`${PROD_ORIGIN}/rent/apply`);
    expect(res.links.origin).toBe(PROD_ORIGIN);
  });
});
