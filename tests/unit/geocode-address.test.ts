import { describe, expect, it } from "vitest";
import {
  listingGeocodeQuery,
  parseGeocodeResult,
  parseNominatimAddressSuggestion,
  rankNominatimAddressSuggestions,
  shapeNominatimSuggestQuery,
} from "@/lib/geocode-address";

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

describe("shapeNominatimSuggestQuery", () => {
  it("does not rewrite a street into Seattle, WA", () => {
    expect(shapeNominatimSuggestQuery("123 Main St")).toBe("123 Main St");
    expect(shapeNominatimSuggestQuery("41932 Paseo Padre")).toBe("41932 Paseo Padre");
    expect(shapeNominatimSuggestQuery("  5257 Brooklyn   Ave NE ")).toBe("5257 Brooklyn Ave NE");
  });
});

describe("rankNominatimAddressSuggestions", () => {
  const fifteenthAveNw = {
    place_id: 1,
    display_name: "15th Avenue Northwest, Ballard, Seattle, WA 98107, USA",
    lat: "47.6689",
    lon: "-122.3845",
    address: {
      road: "15th Avenue Northwest",
      neighbourhood: "Ballard",
      city: "Seattle",
      state: "Washington",
      "ISO3166-2-lvl4": "US-WA",
      postcode: "98107",
    },
  };
  const mainStreet = {
    place_id: 2,
    display_name: "123 Main Street, Seattle, WA 98104, USA",
    lat: "47.601",
    lon: "-122.334",
    address: {
      house_number: "123",
      road: "Main Street",
      city: "Seattle",
      state: "Washington",
      "ISO3166-2-lvl4": "US-WA",
      postcode: "98104",
    },
  };
  const seattleCity = {
    place_id: 3,
    display_name: "Seattle, King County, Washington, United States",
    class: "place",
    type: "city",
    address: {
      city: "Seattle",
      county: "King County",
      state: "Washington",
      "ISO3166-2-lvl4": "US-WA",
    },
  };
  const paseoPadre = {
    place_id: 4,
    display_name: "41932 Paseo Padre Parkway, Fremont, CA 94538, USA",
    lat: "37.5485",
    lon: "-121.9886",
    address: {
      house_number: "41932",
      road: "Paseo Padre Parkway",
      city: "Fremont",
      state: "California",
      "ISO3166-2-lvl4": "US-CA",
      postcode: "94538",
    },
  };
  const brooklyn = {
    place_id: 5,
    display_name: "5257 Brooklyn Avenue Northeast, Seattle, WA 98105, USA",
    lat: "47.667",
    lon: "-122.314",
    address: {
      house_number: "5257",
      road: "Brooklyn Avenue Northeast",
      city: "Seattle",
      state: "Washington",
      "ISO3166-2-lvl4": "US-WA",
      postcode: "98105",
    },
  };

  it("ranks 123 Main over a Seattle side street and drops the unmatched road", () => {
    const ranked = rankNominatimAddressSuggestions("123 Main St", [fifteenthAveNw, mainStreet]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.address).toMatch(/123 Main/i);
  });

  it("drops a city-only hit when the query has digits", () => {
    expect(rankNominatimAddressSuggestions("123 Main St", [seattleCity])).toEqual([]);
  });

  it("keeps a Fremont Paseo Padre row without a Seattle rewrite", () => {
    expect(shapeNominatimSuggestQuery("41932 Paseo Padre")).not.toMatch(/Seattle/i);
    const ranked = rankNominatimAddressSuggestions("41932 Paseo Padre", [paseoPadre, fifteenthAveNw]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.city).toBe("Fremont");
    expect(ranked[0]?.address).toMatch(/Paseo Padre/i);
  });

  it("still keeps 5257 Brooklyn as the Seattle house", () => {
    const ranked = rankNominatimAddressSuggestions("5257 Brooklyn", [brooklyn, fifteenthAveNw]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.address).toMatch(/5257 Brooklyn/i);
    expect(ranked[0]?.city).toBe("Seattle");
  });
});
