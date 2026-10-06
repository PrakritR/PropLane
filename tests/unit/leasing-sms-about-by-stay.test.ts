/**
 * `get_listing_details` carries ONE "About this home" for the prospect's stay. A short-term override never
 * rides alongside the shared text unlabelled, or the model has two conflicting descriptions of one home.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const occupancy = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: vi.fn() }));
vi.mock("@/lib/public-room-occupancy.server", () => ({ loadPublicRoomOccupancy: occupancy.load }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));

import { getPublicListings } from "@/lib/public-listings.server";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import type { AgentContext } from "@/lib/tools/context";
import {
  __resetLeasingCatalogCache,
  __resetSmsOccupancyCache,
  getListingDetailsTool,
} from "@/lib/tools/domains/leasing-sms";

const PROPERTY_ID = "about-house";
const SHARED = "Quiet craftsman two blocks from the light rail.";
const SHORT = "Fully furnished nightly stay with linens and a 3pm check-in.";

function context(): AgentContext {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order", "limit"]) query[method] = () => query;
  query.maybeSingle = async () => ({ data: null, error: null });
  return {
    landlordId: "manager-1",
    userId: "manager-1",
    email: "",
    roles: ["leasing_sms_agent"],
    isAdmin: false,
    db: { from: () => query } as AgentContext["db"],
    leasingScope: {
      sessionId: "session-1",
      prospectPhoneE164: "+12065550123",
      workNumber: "+12065550124",
      crossCatalog: true,
    },
  } as AgentContext;
}

function listing(over: Record<string, unknown>) {
  return {
    id: PROPERTY_ID,
    status: "live",
    title: "About House",
    address: "1 About Way",
    managerUserId: "manager-1",
    listingSubmission: { ...createDefaultListingSubmission(), ...over },
  };
}

async function about(stay?: "long_term" | "short_term") {
  const details = await getListingDetailsTool.handler(context(), { propertyId: PROPERTY_ID, ...(stay ? { stay } : {}) });
  return {
    marketingNotes: details.listing?.marketingNotes ?? null,
    assistantAbout: (details.listing?.assistantInfo as Record<string, string> | null)?.about ?? null,
  };
}

describe("get_listing_details About this home, by stay", () => {
  beforeEach(() => {
    __resetLeasingCatalogCache();
    __resetSmsOccupancyCache();
    vi.mocked(getPublicListings).mockReset();
    occupancy.load.mockReset();
    occupancy.load.mockResolvedValue([]);
    vi.mocked(getPublicListings).mockResolvedValue([
      listing({ marketingNotes: SHARED, aiCommunicationInfoShortTerm: { about: SHORT } }),
    ]);
  });

  it("a short-term prospect gets the short-term text only - never the long-term one too", async () => {
    const { marketingNotes, assistantAbout } = await about("short_term");
    expect(marketingNotes).toBe(SHORT);
    expect(marketingNotes).not.toContain(SHARED);
    expect(assistantAbout).toBeNull();
  });

  it("a long-term prospect gets the shared text only", async () => {
    const { marketingNotes, assistantAbout } = await about("long_term");
    expect(marketingNotes).toBe(SHARED);
    expect(assistantAbout).toBeNull();
  });

  it("an unknown stay gets both, each labelled, and still only one About", async () => {
    const { marketingNotes, assistantAbout } = await about();
    expect(marketingNotes).toContain(`Shared: ${SHARED}`);
    expect(marketingNotes).toContain(`Short term: ${SHORT}`);
    expect(assistantAbout).toBeNull();
  });

  it("with no short-term version the About text is the shared one for every stay", async () => {
    vi.mocked(getPublicListings).mockResolvedValue([listing({ marketingNotes: SHARED })]);
    expect((await about("short_term")).marketingNotes).toBe(SHARED);
    expect((await about("long_term")).marketingNotes).toBe(SHARED);
    expect((await about()).marketingNotes).toBe(SHARED);
  });
});
