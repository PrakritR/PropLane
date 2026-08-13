import { describe, expect, it } from "vitest";
import { listingGeocodeQuery, parseGeocodeResult, parseNominatimAddressSuggestion } from "@/lib/geocode-address";

describe("listingGeocodeQuery", () => {
  it("joins street, city, state, zip, and USA for US zips", () => {
    expect(
      listingGeocodeQuery({
        address: "41932 Paseo Padre Pkwy",
        zip: "94538",
        neighborhood: "Fremont",
        city: "Fremont",
        state: "CA",
        unitLabel: "",
      }),
    ).toBe("41932 Paseo Padre Pkwy, Fremont, CA, 94538, USA");
  });

  it("omits the unit — it adds no geographic precision and hurts the match", () => {
    expect(
      listingGeocodeQuery({
        address: "4709B 8th Ave NE",
        zip: "98105",
        neighborhood: "University District",
        city: "Seattle",
        state: "WA",
        unitLabel: "Room 2",
      }),
    ).toBe("4709B 8th Ave NE, Seattle, WA, 98105, USA");
  });

  it("strips a unit already embedded in the street line", () => {
    expect(
      listingGeocodeQuery({
        address: "3655 Birchwood Ter APT 211",
        zip: "94536",
        neighborhood: "",
        unitLabel: "APT 211",
      }),
    ).toBe("3655 Birchwood Ter, 94536, USA");
  });

  it("returns empty when no address parts", () => {
    expect(listingGeocodeQuery({ address: "", zip: "", neighborhood: "", unitLabel: "" })).toBe("");
  });
});

describe("parseGeocodeResult", () => {
  it("parses valid lat/lng", () => {
    expect(parseGeocodeResult({ lat: 37.5485, lng: -121.9886 })).toEqual({
      lat: 37.5485,
      lng: -121.9886,
    });
  });

  it("rejects invalid coordinates", () => {
    expect(parseGeocodeResult({ lat: "bad", lng: 0 })).toBeNull();
    expect(parseGeocodeResult({ lat: 91, lng: 0 })).toBeNull();
  });
});

describe("parseNominatimAddressSuggestion", () => {
  it("maps street, zip, city, state, and neighborhood from address details", () => {
    expect(
      parseNominatimAddressSuggestion({
        place_id: 1,
        display_name: "5515 22nd Ave NW, Ballard, Seattle, WA 98107, USA",
        lat: "47.6689",
        lon: "-122.3845",
        address: {
          house_number: "5515",
          road: "22nd Avenue Northwest",
          neighbourhood: "Ballard",
          city: "Seattle",
          state: "Washington",
          "ISO3166-2-lvl4": "US-WA",
          postcode: "98107",
        },
      }),
    ).toMatchObject({
      address: "5515 22nd Avenue Northwest",
      zip: "98107",
      neighborhood: "Ballard",
      city: "Seattle",
      state: "WA",
      lat: 47.6689,
      lng: -122.3845,
    });
  });
});
