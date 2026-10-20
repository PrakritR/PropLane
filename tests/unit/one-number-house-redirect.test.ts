// A stranger on the PropLane line asks about one street address that is a live public listing of a workspace PropLane does not
// manage: the line names that workspace's own number (dedicated), or its public page (no own number). A PropLane-managed home,
// no match and a failed read leave the existing flow untouched.
import { describe, expect, it, vi } from "vitest";
import type { MockProperty } from "@/data/types";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: vi.fn(async () => []) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

import { matchListingByAddress, parseStreetLine } from "@/lib/one-number/house-redirect";
import { buildHouseRedirectReply, resolveHouseRedirect } from "@/lib/one-number/house-redirect.server";

const home = (id: string, address: string, extra: Partial<MockProperty> = {}) =>
  ({ id, address, managerUserId: `mgr-${id}`, workspaceId: `ws-${id}`, ...extra }) as unknown as MockProperty;

const MAPLE = home("maple", "1234 Maple St, Seattle, WA 98105");
const BROOKLYN = home("brooklyn", "5259 Brooklyn Ave NE, Seattle, WA 98105", { workspaceId: "ws-service" });
const OAK = home("oak", "77 Oakwood Dr, Seattle, WA 98115");
const DB = {} as never;
const base = {
  serviceListings: async () => [BROOKLYN],
  serviceWorkspaceIds: async () => ["ws-service"],
  allListings: async () => [BROOKLYN, MAPLE, OAK],
  origin: () => "https://proplane.ai",
};

describe("address matching", () => {
  it("reads the street line only", () => {
    expect(parseStreetLine("1234 Maple St, Seattle, WA 98105")).toEqual({ number: "1234", names: ["maple"] });
    expect(parseStreetLine("Maple St")).toBeNull();
  });

  it("matches the exact address and a fuzzy one on number plus street name", () => {
    expect(matchListingByAddress("Is 1234 Maple St still available?", [MAPLE, OAK])).toBe(MAPLE);
    expect(matchListingByAddress("tell me about 1234 maple", [MAPLE, OAK])).toBe(MAPLE);
    expect(matchListingByAddress("what about 77 Oakwod drive", [MAPLE, OAK])).toBe(OAK);
  });

  it("needs both the number and the street name", () => {
    expect(matchListingByAddress("anything on Maple St?", [MAPLE])).toBeNull();
    expect(matchListingByAddress("I need 1234 dollars a month", [MAPLE])).toBeNull();
    expect(matchListingByAddress("5 bedrooms near Maple", [MAPLE])).toBeNull();
  });

  it("never guesses between two homes", () => {
    const twin = home("maple2", "1234 Maple Ave, Tacoma, WA");
    expect(matchListingByAddress("1234 Maple", [MAPLE, twin])).toBeNull();
  });
});

describe("the PropLane-line redirect", () => {
  it("sends a dedicated workspace's home to its own number, with the general label only", async () => {
    const reply = await resolveHouseRedirect(DB, "Hi, is 1234 Maple St available?", { ...base, ownNumberOf: async () => "+12065550111" });
    expect(reply).toBe("1234 Maple St texts from (206) 555-0111. Please text that number.");
    expect(reply).not.toMatch(/Seattle|98105|code|unit/i);
  });

  it("gives the public link and the managed-homes offer when the workspace has no number of its own", async () => {
    const reply = await resolveHouseRedirect(DB, "1234 Maple St?", { ...base, ownNumberOf: async () => null });
    expect(reply).toContain("https://proplane.ai/rent/listings/maple");
    expect(reply).toContain("PropLane also manages homes");
  });

  it("leaves a PropLane-managed home to the existing flow", async () => {
    const ownNumberOf = vi.fn(async () => "+12065550111");
    expect(await resolveHouseRedirect(DB, "Is 5259 Brooklyn Ave available?", { ...base, ownNumberOf })).toBeNull();
    expect(ownNumberOf).not.toHaveBeenCalled();
  });

  it("returns null for no address, an unknown address, and a failed read", async () => {
    expect(await resolveHouseRedirect(DB, "hello there", base)).toBeNull();
    expect(await resolveHouseRedirect(DB, "9999 Nowhere Rd", { ...base, ownNumberOf: async () => "+12065550111" })).toBeNull();
    const failing = async () => {
      throw new Error("boom");
    };
    expect(await resolveHouseRedirect(DB, "1234 Maple St", { ...base, allListings: failing })).toBeNull();
  });

  it("builds the no-number reply as GSM-7", () => {
    expect(buildHouseRedirectReply({ listing: MAPLE, ownNumber: null, origin: "https://x.test/" })).toContain("https://x.test/rent/listings/maple");
  });
});
