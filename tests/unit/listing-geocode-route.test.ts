/**
 * `GET /api/listing-geocode` is the map's second chance at a pin when the page shipped before the server
 * lookup landed. It takes a property ID and NOTHING else: the address it geocodes comes from the stored
 * listing, so the 30-day cache behind it is keyed on the catalog's own addresses rather than on anything a
 * caller can invent. It answers only for the homes the public catalog shows - the same publication and
 * test-workspace gates the single-listing public route applies to this table - so a draft, archived or
 * sandbox home's coordinates never leave the server.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const geocode = vi.hoisted(() => vi.fn());
vi.mock("@/lib/listing-geocode.server", () => ({ geocodeListingAddress: geocode }));
const rateLimit = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/lib/rate-limit", () => ({ rateLimit, clientIpFrom: () => "203.0.113.9" }));
const testWorkspaceScope = vi.hoisted(() => vi.fn());
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveTestWorkspaceRequestScope: testWorkspaceScope }));

type Row = { status: string; property_data: Record<string, unknown> | null; test_workspace_id: string | null };
let rows: Row[];
let readError: { message: string } | null;
/** Every filter the route put on the property read, so the test can assert what it narrowed by. */
let filters: Array<[string, unknown]>;

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return chain;
        },
        is: (column: string, value: unknown) => {
          filters.push([column, value]);
          return chain;
        },
        maybeSingle: async () => {
          if (readError) return { data: null, error: readError };
          const wantsTest = filters.find(([column]) => column === "test_workspace_id")?.[1] ?? null;
          const hit = rows.find((row) => (row.test_workspace_id ?? null) === wantsTest) ?? null;
          return { data: hit, error: null };
        },
      };
      return chain;
    },
  }),
}));

const { GET } = await import("@/app/api/listing-geocode/route");

const PROPERTY = "a0000000-0000-4000-8000-00000000000a";
const SANDBOX_WORKSPACE = "b0000000-0000-4000-8000-00000000000b";
const listing = () => ({ id: PROPERTY, address: "4709A 8th Ave", zip: "98105", state: "WA", listingSubmission: { v: 1, city: "Seattle" } });
const get = (query: string) => GET(jsonRequest(`http://localhost/api/listing-geocode${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  rateLimit.mockResolvedValue({ ok: true });
  testWorkspaceScope.mockResolvedValue({ kind: "none" });
  readError = null;
  filters = [];
  rows = [{ status: "live", property_data: listing(), test_workspace_id: null }];
  geocode.mockResolvedValue({ lat: 47.6641, lng: -122.3185 });
});

describe("GET /api/listing-geocode", () => {
  it("geocodes the STORED address of a published listing and ignores anything the caller typed", async () => {
    const res = await get(`?propertyId=${PROPERTY}&address=1%20Evergreen%20Terrace&zip=98109&city=Springfield`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lat: 47.6641, lng: -122.3185 });
    expect(geocode).toHaveBeenCalledWith({ address: "4709A 8th Ave", zip: "98105", city: "Seattle", state: "WA" });
    expect(res.headers.get("cache-control")).toContain("s-maxage=86400");
    // Narrowed to the one listing, outside every test workspace.
    expect(filters).toEqual([["id", PROPERTY], ["test_workspace_id", null]]);
  });

  it("is 404 for a home the public catalog would not show: draft, archived, or no row at all", async () => {
    for (const status of ["draft", "archived", "paused"]) {
      filters = [];
      rows = [{ status, property_data: listing(), test_workspace_id: null }];
      expect((await get(`?propertyId=${PROPERTY}`)).status).toBe(404);
    }
    filters = [];
    rows = [];
    expect((await get(`?propertyId=${PROPERTY}`)).status).toBe(404);
    // A live row whose stored blob is missing is not a listing either.
    filters = [];
    rows = [{ status: "live", property_data: null, test_workspace_id: null }];
    expect((await get(`?propertyId=${PROPERTY}`)).status).toBe(404);
    expect(geocode).not.toHaveBeenCalled();
  });

  it("keeps a sandbox listing inside its own test workspace, and answers nothing to a denied scope", async () => {
    rows = [{ status: "live", property_data: listing(), test_workspace_id: SANDBOX_WORKSPACE }];
    // A plain public request only ever sees rows outside every test workspace.
    expect((await get(`?propertyId=${PROPERTY}`)).status).toBe(404);
    expect(geocode).not.toHaveBeenCalled();

    filters = [];
    testWorkspaceScope.mockResolvedValue({ kind: "active", workspaceId: SANDBOX_WORKSPACE });
    expect((await get(`?propertyId=${PROPERTY}`)).status).toBe(200);
    expect(filters).toEqual([["id", PROPERTY], ["test_workspace_id", SANDBOX_WORKSPACE]]);

    testWorkspaceScope.mockResolvedValue({ kind: "denied" });
    expect((await get(`?propertyId=${PROPERTY}`)).status).toBe(404);
  });

  it("refuses anything that is not a listing id, and never reaches the geocoder", async () => {
    for (const query of ["", "?propertyId=", "?propertyId=not-an-id", "?zip=98105&address=4709A%208th%20Ave"]) {
      expect((await get(query)).status).toBe(400);
    }
    expect(geocode).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("is 404 for an address that cannot be placed", async () => {
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
