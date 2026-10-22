/**
 * `GET /api/listing-geocode` is the map's second chance at a pin when the page shipped before the server
 * lookup landed. It takes a property ID and NOTHING else: the address it geocodes comes from the stored
 * listing, so the 30-day cache behind it is keyed on the catalog's own addresses rather than on anything a
 * caller can invent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const geocode = vi.hoisted(() => vi.fn());
vi.mock("@/lib/listing-geocode.server", () => ({ geocodeListingAddress: geocode }));
const rateLimit = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/lib/rate-limit", () => ({ rateLimit, clientIpFrom: () => "203.0.113.9" }));

let stored: Record<string, unknown> | null;
let readError: { message: string } | null;
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: stored ? { property_data: stored } : null, error: readError }),
        }),
      }),
    }),
  }),
}));

const { GET } = await import("@/app/api/listing-geocode/route");

const PROPERTY = "a0000000-0000-4000-8000-00000000000a";
const get = (query: string) => GET(jsonRequest(`http://localhost/api/listing-geocode${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  rateLimit.mockResolvedValue({ ok: true });
  readError = null;
  stored = { id: PROPERTY, address: "4709A 8th Ave", zip: "98105", state: "WA", listingSubmission: { v: 1, city: "Seattle" } };
  geocode.mockResolvedValue({ lat: 47.6641, lng: -122.3185 });
});

describe("GET /api/listing-geocode", () => {
  it("geocodes the STORED address and ignores anything the caller typed", async () => {
    const res = await get(`?propertyId=${PROPERTY}&address=1%20Evergreen%20Terrace&zip=98109&city=Springfield`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lat: 47.6641, lng: -122.3185 });
    expect(geocode).toHaveBeenCalledWith({ address: "4709A 8th Ave", zip: "98105", city: "Seattle", state: "WA" });
    expect(res.headers.get("cache-control")).toContain("s-maxage=86400");
  });

  it("refuses anything that is not a listing id, and never reaches the geocoder", async () => {
    for (const query of ["", "?propertyId=", "?propertyId=not-an-id", "?zip=98105&address=4709A%208th%20Ave"]) {
      expect((await get(query)).status).toBe(400);
    }
    expect(geocode).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("is 404 for an id that names no listing, and for an address that cannot be placed", async () => {
    stored = null;
    expect((await get(`?propertyId=${PROPERTY}`)).status).toBe(404);
    expect(geocode).not.toHaveBeenCalled();

    stored = { id: PROPERTY, address: "4709A 8th Ave", zip: "98105" };
    geocode.mockResolvedValue(null);
    expect((await get(`?propertyId=${PROPERTY}`)).status).toBe(404);
  });

  it("rate-limits per caller, and answers 502 rather than leaking a read or lookup failure", async () => {
    rateLimit.mockResolvedValue({ ok: false });
    expect((await get(`?propertyId=${PROPERTY}`)).status).toBe(429);
    expect(geocode).not.toHaveBeenCalled();

    rateLimit.mockResolvedValue({ ok: true });
    readError = { message: "relation does not exist" };
    expect((await get(`?propertyId=${PROPERTY}`)).status).toBe(502);

    readError = null;
    geocode.mockRejectedValue(new Error("Nominatim 503"));
    const res = await get(`?propertyId=${PROPERTY}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Geocoding failed." });
  });
});
