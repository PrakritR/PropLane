import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetNearbyTransitCache, getNearbyTransit, parseOverpassTransit } from "@/lib/nearby-transit.server";

const origin = { lat: 37.78, lng: -122.42 };

describe("nearby transit parsing", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); __resetNearbyTransitCache(); });
  it("requires named valid stops and sorts and deduplicates by straight-line distance", () => {
    const result = parseOverpassTransit({ elements: [
      { lat: 37.79, lon: -122.42, tags: { name: "Mission Stop", highway: "bus_stop" } },
      { lat: 37.781, lon: -122.42, tags: { name: "Mission Stop", highway: "bus_stop" } },
      { lat: 37.782, lon: -122.42, tags: { highway: "bus_stop" } },
      { lat: 999, lon: -122.42, tags: { name: "Invalid", highway: "bus_stop" } },
    ] }, origin, "bus");
    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({ name: "Mission Stop", mode: "bus" });
    expect(result?.[0]?.distanceMiles).toBeLessThan(0.2);
  });

  it("classifies BART only from explicit network or operator and station evidence", () => {
    const result = parseOverpassTransit({ elements: [
      { lat: 37.781, lon: -122.42, tags: { name: "Civic Center", railway: "station", network: "BART" } },
      { lat: 37.782, lon: -122.42, tags: { name: "Bartley Street", railway: "station" } },
      { lat: 37.783, lon: -122.42, tags: { name: "Bus named BART", highway: "bus_stop", operator: "BART" } },
    ] }, origin, "bart");
    expect(result).toEqual([expect.objectContaining({ name: "Civic Center", mode: "bart" })]);
  });

  it("includes rail halts, tram stops, and platforms while excluding centers outside the radius", () => {
    const result = parseOverpassTransit({ elements: [
      { lat: 37.781, lon: -122.42, tags: { name: "Rail Halt", railway: "halt" } },
      { lat: 37.782, lon: -122.42, tags: { name: "Tram Stop", railway: "tram_stop" } },
      { lat: 37.783, lon: -122.42, tags: { name: "Subway Platform", public_transport: "platform", subway: "yes" } },
      { lat: 37.7835, lon: -122.42, tags: { name: "Train Station", public_transport: "station", train: "yes" } },
      { lat: 37.784, lon: -122.42, tags: { name: "Generic Bus Platform", public_transport: "platform" } },
      { center: { lat: 37.84, lon: -122.42 }, tags: { name: "Outside", railway: "station" } },
    ] }, origin, "public_transit");
    expect(result?.map((stop) => stop.name)).toEqual(["Rail Halt", "Tram Stop", "Subway Platform", "Train Station"]);
  });

  it("does not classify a generic platform as BART from network alone", () => {
    expect(parseOverpassTransit({ elements: [
      { lat: 37.781, lon: -122.42, tags: { name: "Bus Platform", public_transport: "platform", network: "BART" } },
    ] }, origin, "bart")).toEqual([]);
  });

  it("rejects malformed and provider-truncated responses", () => {
    expect(parseOverpassTransit({ remark: "runtime error", elements: [] }, origin, "public_transit")).toBeNull();
    expect(parseOverpassTransit("<html>error</html>", origin, "public_transit")).toBeNull();
  });

  it("uses validated stored coordinates without geocoding the address", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe("https://overpass-api.de/api/interpreter");
      expect(String(init?.body)).toContain("maxsize%3A33554432");
      return new Response(JSON.stringify({ elements: [] }), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await getNearbyTransit({ mapLat: 37.78, mapLng: -122.42, address: "ignored" }, "bus");
    expect(result).toMatchObject({
      verified: true,
      source: "OpenStreetMap",
      sourceUrl: "https://www.openstreetmap.org/copyright",
      distanceKind: "straight_line",
    });
    expect(Date.parse(result.fetchedAt)).not.toBeNaN();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not geocode an incomplete stored address or accept null coordinates", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(getNearbyTransit({ mapLat: null, mapLng: null, address: "123 Main St" }, "bus"))
      .resolves.toMatchObject({ verified: false, error: "location_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports missing deployed provider configuration as unavailable", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("NOMINATIM_PROVIDER_URL", "");
    vi.stubEnv("OVERPASS_PROVIDER_URL", "");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(getNearbyTransit({ address: "123 Main St", zip: "94102" }, "bus"))
      .resolves.toMatchObject({ verified: false, error: "provider_unavailable" });
    await expect(getNearbyTransit({ mapLat: 37.78, mapLng: -122.42 }, "bus"))
      .resolves.toMatchObject({ verified: false, error: "provider_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unsafe configured provider URL", async () => {
    vi.stubEnv("VERCEL", "1"); vi.stubEnv("OVERPASS_PROVIDER_URL", "http://localhost:8080/api");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(getNearbyTransit({ mapLat: 37.78, mapLng: -122.42 }, "bus"))
      .resolves.toMatchObject({ verified: false, error: "provider_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("coalesces concurrent identical lookups and caches the verified result", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ elements: [] }), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const source = { mapLat: 37.78, mapLng: -122.42 };
    const [first, second] = await Promise.all([getNearbyTransit(source, "public_transit"), getNearbyTransit(source, "public_transit")]);
    expect(first).toEqual(second);
    await getNearbyTransit(source, "public_transit");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces geocoding before the coordinate-key transit cache", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => String(input).includes("nominatim")
      ? new Response(JSON.stringify([{ lat: "37.78", lon: "-122.42" }]), { headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ elements: [] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const source = { address: "123 Main St", zip: "94102" };
    await Promise.all([getNearbyTransit(source, "bus"), getNearbyTransit(source, "bus")]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("nominatim"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("overpass"))).toHaveLength(1);
  });

  it.each([
    [429, "application/json", "{}"],
    [500, "application/json", "{}"],
    [200, "text/html", "<html>bad gateway</html>"],
  ])("fails closed for provider response %s", async (status, contentType, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status, headers: { "content-type": contentType } })));
    await expect(getNearbyTransit({ mapLat: 37.78, mapLng: -122.42 }, "bus"))
      .resolves.toMatchObject({ verified: false, error: "unverified_response" });
  });

  it("rejects a declared oversized provider body before parsing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ elements: [] }), {
      headers: { "content-type": "application/json", "content-length": "2097153" },
    })));
    await expect(getNearbyTransit({ mapLat: 37.78, mapLng: -122.42 }, "bus"))
      .resolves.toMatchObject({ verified: false, error: "unverified_response" });
  });
});
