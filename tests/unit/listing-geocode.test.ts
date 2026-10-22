/** ZIP-verified structured geocoding for the public listing map pin. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/nominatim.server", () => ({
  throttleNominatim: async () => undefined,
  nominatimUserAgent: () => "test-agent",
}));

import {
  clearListingGeocodeCache,
  geocodeListingAddress,
  geocodeListingAddressWithin,
} from "@/lib/listing-geocode.server";

type Row = { lat: string; lon: string; address?: { postcode?: string } };
const fetchMock = vi.fn();

function reply(rows: Row[]) {
  return { ok: true, status: 200, json: async () => rows } as unknown as Response;
}
function calls() {
  return fetchMock.mock.calls.map(([url]) => new URL(String(url)).searchParams);
}

const LISTING = { address: "4709A 8th Ave", zip: "98105", city: "Seattle", state: "WA" };
const WESTLAKE: Row = { lat: "47.62", lon: "-122.34", address: { postcode: "98109" } };
const EXACT: Row = { lat: "47.6641", lon: "-122.3185", address: { postcode: "98105" } };
const CENTROID: Row = { lat: "47.66", lon: "-122.30", address: { postcode: "98105" } };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  clearListingGeocodeCache();
});
afterEach(() => vi.unstubAllGlobals());

describe("geocodeListingAddress", () => {
  it("rejects a postcode mismatch, retries without the letter suffix, then accepts the matching hit", async () => {
    fetchMock.mockResolvedValueOnce(reply([WESTLAKE])).mockResolvedValueOnce(reply([EXACT]));
    await expect(geocodeListingAddress(LISTING)).resolves.toEqual({ lat: 47.6641, lng: -122.3185 });
    const [first, second] = calls();
    expect(first!.get("street")).toBe("4709A 8th Ave");
    expect(first!.get("city")).toBe("Seattle");
    expect(first!.get("state")).toBe("WA");
    expect(first!.get("postalcode")).toBe("98105");
    expect(first!.get("countrycodes")).toBe("us");
    expect(first!.get("addressdetails")).toBe("1");
    expect(second!.get("street")).toBe("4709 8th Ave");
  });

  it("falls back to the ZIP centroid, never a city centre, when no street hit is in the ZIP", async () => {
    fetchMock
      .mockResolvedValueOnce(reply([WESTLAKE]))
      .mockResolvedValueOnce(reply([WESTLAKE]))
      .mockResolvedValueOnce(reply([CENTROID]));
    await expect(geocodeListingAddress(LISTING)).resolves.toEqual({ lat: 47.66, lng: -122.3 });
    const last = calls()[2]!;
    expect(last.get("postalcode")).toBe("98105");
    expect(last.get("street")).toBeNull();
    expect(last.get("city")).toBeNull();
  });

  it("does not retry a suffix-less number", async () => {
    fetchMock.mockResolvedValueOnce(reply([])).mockResolvedValueOnce(reply([CENTROID]));
    await geocodeListingAddress({ ...LISTING, address: "5259 Brooklyn Ave NE" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls()[1]!.get("street")).toBeNull();
  });

  it("returns null without any request when the listing has no ZIP", async () => {
    await expect(geocodeListingAddress({ ...LISTING, zip: "" })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves the second call from the cache", async () => {
    fetchMock.mockResolvedValueOnce(reply([EXACT]));
    const a = await geocodeListingAddress({ ...LISTING, address: "4709 8th Ave" });
    const b = await geocodeListingAddress({ ...LISTING, address: "4709 8th ave" });
    expect(b).toEqual(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a failure out of the 30-day cache but remembers the miss, so the same address is not re-asked", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 } as unknown as Response);
    await expect(geocodeListingAddress(LISTING)).rejects.toThrow();
    // The remembered miss answers null without another request (a page reloading in a loop cannot hammer
    // Nominatim), and it is a MISS, not a cached success: nothing wrong is ever drawn as a pin.
    fetchMock.mockReset();
    await expect(geocodeListingAddress(LISTING)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // "Nothing found" is remembered the same way.
    clearListingGeocodeCache();
    fetchMock.mockResolvedValue(reply([]));
    await expect(geocodeListingAddress(LISTING)).resolves.toBeNull();
    const asked = fetchMock.mock.calls.length;
    await expect(geocodeListingAddress(LISTING)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(asked);
    // Once forgotten, the address is looked up again.
    clearListingGeocodeCache();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(reply([EXACT]));
    await expect(geocodeListingAddress(LISTING)).resolves.toEqual({ lat: 47.6641, lng: -122.3185 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("geocodeListingAddressWithin", () => {
  it("returns null on failure and on timeout instead of throwing or blocking", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"));
    await expect(geocodeListingAddressWithin(LISTING, 50)).resolves.toBeNull();
    clearListingGeocodeCache();
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    await expect(geocodeListingAddressWithin(LISTING, 20)).resolves.toBeNull();
  });
});
