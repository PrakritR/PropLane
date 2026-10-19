import { describe, expect, it } from "vitest";
import { compareAreaMatches, distanceMiles, matchHomeToPlace, resolveSeattlePlace } from "@/lib/places/seattle-places";

describe("Seattle place resolver", () => {
  it.each([
    ["near University of Washington campus", "uw-campus"],
    ["show houses that are near university of washington campus", "uw-campus"],
    ["UW", "uw-campus"],
    ["anything by the UW?", "uw-campus"],
    ["UDistrict  near campus", "uw-campus"],
    ["U District", "u-district"],
    ["u-district please", "u-district"],
    ["universitydistrict", "u-district"],
    ["Capitol Hill", "capitol-hill"],
    ["cap hill under 1200", "capitol-hill"],
    ["near downtown", "downtown"],
    ["somewhere in Ballard", "ballard"],
    ["u district station", "u-district-station"],
  ])("%s resolves to %s", (text, id) => {
    expect(resolveSeattlePlace(text)?.id).toBe(id);
  });

  it("resolves a zip code to its centroid", () => {
    const place = resolveSeattlePlace("anything in 98105?");
    expect(place).toMatchObject({ id: "zip-98105", kind: "zip" });
    expect(Number.isFinite(place!.lat)).toBe(true);
  });

  it("does not resolve a word inside another word, or an unknown place", () => {
    expect(resolveSeattlePlace("bruwer")).toBeNull();
    expect(resolveSeattlePlace("District")).toBeNull();
    expect(resolveSeattlePlace("")).toBeNull();
    expect(resolveSeattlePlace("something in Tacoma")).toBeNull();
  });

  it("measures the production U District homes as near the campus, and a Ballard home as far", () => {
    const campus = resolveSeattlePlace("University of Washington campus")!;
    const brooklyn = matchHomeToPlace({ lat: 47.6674, lng: -122.3144, neighborhood: "University District", zip: "98105" }, campus)!;
    const eighth = matchHomeToPlace({ lat: 47.6625, lng: -122.3226, neighborhood: "University District", zip: "98105" }, campus)!;
    const ballard = matchHomeToPlace({ lat: 47.668, lng: -122.384, neighborhood: "Ballard", zip: "98107" }, campus)!;
    expect(brooklyn).toMatchObject({ how: "distance", near: true });
    expect(eighth).toMatchObject({ how: "distance", near: true });
    expect(brooklyn.distanceMiles).toBeLessThan(1.3);
    expect(ballard.near).toBe(false);
    expect(compareAreaMatches(brooklyn, ballard)).toBeLessThan(0);
  });

  it("falls back to neighborhood, then zip, when a home has no coordinates", () => {
    const place = resolveSeattlePlace("U District")!;
    expect(matchHomeToPlace({ neighborhood: "University District" }, place)).toMatchObject({ how: "neighborhood", near: true });
    expect(matchHomeToPlace({ zip: "98105" }, place)).toMatchObject({ how: "zip", near: true });
    expect(matchHomeToPlace({ neighborhood: "Ballard" }, place)).toBeNull();
    expect(matchHomeToPlace({}, place)).toBeNull();
  });

  it("computes haversine miles", () => {
    expect(distanceMiles({ lat: 47.6062, lng: -122.3321 }, { lat: 47.6062, lng: -122.3321 })).toBe(0);
    expect(distanceMiles({ lat: 47.6062, lng: -122.3321 }, { lat: 47.6553, lng: -122.3035 })).toBeGreaterThan(3);
  });
});

describe("a home that names another known neighborhood", () => {
  it("is not matched by a zip the two neighborhoods share", () => {
    const uDistrict = resolveSeattlePlace("U District")!;
    expect(matchHomeToPlace({ neighborhood: "Laurelhurst", zip: "98105" }, uDistrict)).toBeNull();
    expect(matchHomeToPlace({ neighborhood: "Seattle", zip: "98105" }, uDistrict)).toMatchObject({ how: "zip", near: true });
    expect(matchHomeToPlace({ neighborhood: "Laurelhurst", zip: "98105" }, resolveSeattlePlace("98105")!)).toMatchObject({ how: "zip" });
  });
});
