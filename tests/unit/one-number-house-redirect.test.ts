// Someone on the PropLane line asks about a home that belongs to a workspace PropLane does not manage (a self-serve home), by street,
// house name or listing title. Its manager's PAID work number (managerPersonalNumberEntitlement) is named in one line and nothing else
// about the home is said; with no paid number the reply names nothing at all. A PropLane-managed home, no match and a failed read
// leave the existing flow untouched.
import { describe, expect, it, vi } from "vitest";
import type { MockProperty } from "@/data/types";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: vi.fn(async () => []) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

import { homeLabelWithCity, matchListingByAddress, matchListingsNamedIn, parseStreetLine, textNamesListingByName } from "@/lib/one-number/house-redirect";
import { buildPaidHomeReply, NO_PAID_NUMBER_HOME_REPLY, resolveHouseRedirect } from "@/lib/one-number/house-redirect.server";

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

describe("name and title matching", () => {
  const elm = home("elm", "12 Elm St, Louisville, KY 40202", { title: "Elm Street House", buildingName: "Elm Street House", neighborhood: "Highlands" });
  const hill = home("hill", "300 Pine Rd, Seattle, WA 98101", { title: "Capitol Hill", buildingName: "Capitol Hill", neighborhood: "Capitol Hill" });

  it("needs the whole name, in order, two words or more", () => {
    expect(textNamesListingByName("is the Elm Street House still open?", elm)).toBe(true);
    expect(textNamesListingByName("anything on elm street?", elm)).toBe(false);
    expect(textNamesListingByName("house street elm", elm)).toBe(false);
  });

  it("a title that is only the listing's neighborhood never names one home", () => {
    expect(textNamesListingByName("anything in capitol hill?", hill)).toBe(false);
  });

  it("matches by street or by name, and says several when two homes are named", () => {
    expect(matchListingsNamedIn("12 Elm St?", [elm, hill])).toEqual({ kind: "one", listing: elm });
    expect(matchListingsNamedIn("Elm Street House", [elm, hill])).toEqual({ kind: "one", listing: elm });
    expect(matchListingsNamedIn("nothing here", [elm, hill])).toEqual({ kind: "none" });
    const twin = home("twin", "12 Elm Ave, Tacoma, WA 98402", { title: "Another", buildingName: "Another" });
    expect(matchListingsNamedIn("12 Elm", [elm, twin]).kind).toBe("several");
  });

  it("labels a home with its street and city only", () => {
    expect(homeLabelWithCity(elm)).toBe("12 Elm St, Louisville");
    expect(homeLabelWithCity({ address: "12 Elm St" })).toBe("12 Elm St");
    expect(homeLabelWithCity({ address: "12 Elm St, Apt 3, Louisville, KY" })).toBe("12 Elm St");
    expect(homeLabelWithCity({ address: "12 Elm St, KY 40202" })).toBe("12 Elm St");
  });
});

describe("the PropLane-line redirect", () => {
  it("a self-serve home whose manager pays for a number: 'For <street>, text <number>.' and nothing else", async () => {
    const reply = await resolveHouseRedirect(DB, "Hi, is 1234 Maple St available?", { ...base, paidNumberOf: async () => "+12065550111" });
    expect(reply).toBe("For 1234 Maple St, Seattle, text (206) 555-0111.");
    expect(reply).not.toMatch(/98105|WA|code|unit|rent\/listings|PropLane/i);
  });

  it("the Kentucky example", async () => {
    const elm = home("elm", "12 Elm St, Louisville, KY 40202", { managerUserId: "mgr-elm" });
    const reply = await resolveHouseRedirect(DB, "12 Elm St?", { ...base, allListings: async () => [BROOKLYN, elm], paidNumberOf: async () => "+15025550142" });
    expect(reply).toBe("For 12 Elm St, Louisville, text (502) 555-0142.");
  });

  it("matches by house name and by listing title too", async () => {
    const named = home("named", "9 Birch Ln, Seattle, WA 98103", { title: "Birch Lane Cottage", buildingName: "Birch Cottage" });
    const deps = { ...base, allListings: async () => [BROOKLYN, named], paidNumberOf: async () => "+12065550111" };
    expect(await resolveHouseRedirect(DB, "tell me about the Birch Lane Cottage", deps)).toBe("For 9 Birch Ln, Seattle, text (206) 555-0111.");
    expect(await resolveHouseRedirect(DB, "is birch cottage open", deps)).toBe("For 9 Birch Ln, Seattle, text (206) 555-0111.");
  });

  it("no paid number: nothing about the home is disclosed (no street, no link, no name)", async () => {
    for (const text of ["1234 Maple St?", "is the Maple House still open"]) {
      const maple = home("maple", "1234 Maple St, Seattle, WA 98105", { title: "Maple House", buildingName: "Maple House" });
      const reply = await resolveHouseRedirect(DB, text, { ...base, allListings: async () => [BROOKLYN, maple], paidNumberOf: async () => null });
      expect(reply).toBe("I can only help with homes PropLane manages. Looking for a place in Seattle? Tell me your area, budget and move-in date.");
      expect(reply).toBe(NO_PAID_NUMBER_HOME_REPLY);
      expect(reply).not.toMatch(/maple|1234|98105|https?:|rent\/listings|PropLane also manages/i);
    }
  });

  it("a number that cannot be read is no number", async () => {
    const reply = await resolveHouseRedirect(DB, "1234 Maple St?", {
      ...base,
      paidNumberOf: async () => {
        throw new Error("entitlement unreadable");
      },
    });
    expect(reply).toBe(NO_PAID_NUMBER_HOME_REPLY);
  });

  it("two self-serve homes named at once: nothing is named", async () => {
    const twin = home("maple2", "1234 Maple Ave, Tacoma, WA");
    const paid = vi.fn(async () => "+12065550111");
    const reply = await resolveHouseRedirect(DB, "1234 Maple", { ...base, allListings: async () => [MAPLE, twin], paidNumberOf: paid });
    expect(reply).toBe(NO_PAID_NUMBER_HOME_REPLY);
    expect(paid).not.toHaveBeenCalled();
  });

  it("leaves a PropLane-managed home to the existing flow", async () => {
    const paidNumberOf = vi.fn(async () => "+12065550111");
    expect(await resolveHouseRedirect(DB, "Is 5259 Brooklyn Ave available?", { ...base, paidNumberOf })).toBeNull();
    expect(paidNumberOf).not.toHaveBeenCalled();
  });

  it("returns null for no home named, an unknown address, and a failed read", async () => {
    expect(await resolveHouseRedirect(DB, "hello there", base)).toBeNull();
    expect(await resolveHouseRedirect(DB, "", base)).toBeNull();
    expect(await resolveHouseRedirect(DB, "9999 Nowhere Rd", { ...base, paidNumberOf: async () => "+12065550111" })).toBeNull();
    const failing = async () => {
      throw new Error("boom");
    };
    expect(await resolveHouseRedirect(DB, "1234 Maple St", { ...base, allListings: failing })).toBeNull();
  });

  it("builds the paid-number reply as GSM-7", () => {
    const reply = buildPaidHomeReply({ listing: MAPLE, number: "+12065550111" });
    expect(reply).toMatch(/^[\x20-\x7E]+$/);
    expect(reply.length).toBeLessThanOrEqual(160);
  });
});
