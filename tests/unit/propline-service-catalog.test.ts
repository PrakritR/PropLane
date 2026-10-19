// The PropLane line's catalog: only the live homes of PropLane-managed (is_service) workspaces, in per_workspace mode
// (a number the platform service owner holds) and for a stranger on the shared line. Everything else keeps its own homes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ publicListings: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: mocks.publicListings }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  getServicePublicListings,
  isPropLaneServiceLine,
  loadServiceWorkspaceIds,
  resetPlatformServiceOwnerCache,
  resetServiceCatalogCache,
} from "@/lib/service/service-catalog.server";
import { __resetLeasingCatalogCache, buildProspectLinksTool, getListingDetailsTool, listLiveListingsTool } from "@/lib/tools/domains/leasing-sms";

const SERVICE_OWNER = "f1aef049-0000-4000-8000-000000000001";
const OTHER_OWNER = "99999999-0000-4000-8000-000000000002";
const WS_SERVICE = "aaaaaaaa-0000-4000-8000-000000000001";
const LINE = "+12066781909";

type Tables = Record<string, Record<string, unknown>[] | { error: { code: string } }>;
function fakeDb(tables: Tables) {
  const from = (table: string) => {
    const source = tables[table];
    const rows = Array.isArray(source) ? source : [];
    const error = Array.isArray(source) ? null : source?.error ?? null;
    let filtered = rows;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, value: unknown) => { filtered = filtered.filter((r) => r[col] === value); return chain; },
      is: (col: string, value: unknown) => { filtered = filtered.filter((r) => (r[col] ?? null) === value); return chain; },
      limit: () => chain,
      maybeSingle: async () => ({ data: filtered[0] ?? null, error }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: error ? null : filtered, error }),
    };
    return chain;
  };
  return { from } as never;
}

const home = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: id, buildingName: id, address: `${id} St`, neighborhood: "University District", zip: "98105", managerUserId: SERVICE_OWNER,
  mapLat: 47.6674, mapLng: -122.3144, rentLabel: "$900 / mo",
  listingSubmission: { v: 1, rooms: [{ id: `${id}-r1`, name: "Room A", monthlyRent: 900 }] }, ...extra,
});

describe("PropLane line detection (per_workspace mode)", () => {
  beforeEach(() => { resetPlatformServiceOwnerCache(); resetServiceCatalogCache(); vi.clearAllMocks(); });

  const tables = (): Tables => ({
    platform_service_settings: [{ singleton: true, owner_user_id: SERVICE_OWNER }],
    manager_sms_numbers: [
      { id: "n1", manager_user_id: SERVICE_OWNER, phone_number: LINE, provision_state: "active", released_at: null },
      { id: "n2", manager_user_id: OTHER_OWNER, phone_number: "+12065550111", provision_state: "active", released_at: null },
    ],
  });

  it("is the line when the platform service owner holds the number", async () => {
    await expect(isPropLaneServiceLine(fakeDb(tables()), { ownerUserId: SERVICE_OWNER, workNumber: "(206) 678-1909" })).resolves.toBe(true);
  });

  it("is not the line for any other workspace's own number", async () => {
    await expect(isPropLaneServiceLine(fakeDb(tables()), { ownerUserId: OTHER_OWNER, workNumber: "+12065550111" })).resolves.toBe(false);
  });

  it("is not the line for a number the service owner does not hold, a released one, or the shared number", async () => {
    const db = fakeDb(tables());
    await expect(isPropLaneServiceLine(db, { ownerUserId: SERVICE_OWNER, workNumber: "+12065550999" })).resolves.toBe(false);
    await expect(isPropLaneServiceLine(db, { ownerUserId: SERVICE_OWNER, workNumber: LINE, sharedNumber: LINE })).resolves.toBe(false);
    const released = tables();
    (released.manager_sms_numbers as Record<string, unknown>[])[0].released_at = "2026-10-01T00:00:00Z";
    resetPlatformServiceOwnerCache();
    await expect(isPropLaneServiceLine(fakeDb(released), { ownerUserId: SERVICE_OWNER, workNumber: LINE })).resolves.toBe(false);
  });

  it("fails closed to the per-workspace behavior when the settings or numbers are unreadable", async () => {
    await expect(isPropLaneServiceLine(fakeDb({ platform_service_settings: { error: { code: "42P01" } } }), { ownerUserId: SERVICE_OWNER, workNumber: LINE })).resolves.toBe(false);
    resetPlatformServiceOwnerCache();
    await expect(isPropLaneServiceLine(fakeDb({ ...tables(), manager_sms_numbers: { error: { code: "500" } } }), { ownerUserId: SERVICE_OWNER, workNumber: LINE })).resolves.toBe(false);
  });
});

describe("service catalog read", () => {
  beforeEach(() => { resetServiceCatalogCache(); vi.clearAllMocks(); });

  it("reads only the workspaces flagged is_service and hands exactly those ids to the public catalog", async () => {
    mocks.publicListings.mockResolvedValue([]);
    const db = fakeDb({ portal_workspaces: [{ id: WS_SERVICE, is_service: true }, { id: "bbbb", is_service: false }] });
    await expect(loadServiceWorkspaceIds(db)).resolves.toEqual([WS_SERVICE]);
    await getServicePublicListings(db);
    expect(mocks.publicListings).toHaveBeenCalledWith({ workspaceIds: [WS_SERVICE] });
  });

  it("throws on a failed read instead of widening to the whole catalog", async () => {
    const db = fakeDb({ portal_workspaces: { error: { code: "500" } } });
    await expect(getServicePublicListings(db)).rejects.toThrow(/unreadable/);
    expect(mocks.publicListings).not.toHaveBeenCalled();
  });
});

describe("leasing tools on the PropLane line", () => {
  beforeEach(() => {
    __resetLeasingCatalogCache(); resetServiceCatalogCache(); vi.clearAllMocks();
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(fakeDb({ portal_workspaces: [{ id: WS_SERVICE, is_service: true }] }));
  });

  const serviceCtx = (extra: Record<string, unknown> = {}) => {
    const none = { select: () => none, eq: () => none, in: () => none, order: () => none, limit: () => none, maybeSingle: async () => ({ data: null, error: null }), then: (r: (v: unknown) => unknown) => r({ data: [], error: null }) };
    return { landlordId: SERVICE_OWNER, db: { from: (table: string) => (table === "portal_workspaces" ? fakeDbFrom(table) : none) }, leasingScope: { serviceCatalog: true, prospectPhoneE164: "+12065550142", channel: "sms", ...extra } } as never;
  };
  const fakeDbFrom = (table: string) => (fakeDb({ portal_workspaces: [{ id: WS_SERVICE, is_service: true }] }) as unknown as { from: (t: string) => unknown }).from(table);

  it("lists only service homes, nearest the campus first, each with its own link and distance", async () => {
    mocks.publicListings.mockResolvedValue([
      home("far-ballard", { neighborhood: "Ballard", zip: "98107", mapLat: 47.668, mapLng: -122.384 }),
      home("brooklyn", { mapLat: 47.6674, mapLng: -122.3144 }),
      home("eighth", { mapLat: 47.6625, mapLng: -122.3226 }),
    ]);
    const result = await listLiveListingsTool.handler(serviceCtx(), { area: "show houses near University of Washington campus" }) as {
      listings: { propertyId: string; listingUrl: string; areaMatch: { distanceMiles: number; near: boolean } }[]; area: { resolved: boolean; nearCount: number }; browseUrl: string;
    };
    expect(mocks.publicListings).toHaveBeenCalledWith({ workspaceIds: [WS_SERVICE] });
    expect(result.listings.map((l) => l.propertyId)).toEqual(["brooklyn", "eighth"]);
    expect(result.listings.every((l) => l.areaMatch.near && l.areaMatch.distanceMiles > 0 && l.listingUrl.endsWith(`/rent/listings/${l.propertyId}`))).toBe(true);
    expect(result.area).toMatchObject({ resolved: true, nearCount: 2 });
    expect(result.browseUrl).toMatch(/\/rent\/browse$/);
  });

  it("says no home is in the area and returns the closest, flagged, when none is near", async () => {
    mocks.publicListings.mockResolvedValue([home("brooklyn")]);
    const result = await listLiveListingsTool.handler(serviceCtx(), { area: "West Seattle" }) as { listings: { areaMatch: { near: boolean } }[]; area: { nearCount: number; note: string } };
    expect(result.area.nearCount).toBe(0);
    expect(result.area.note).toMatch(/closest/);
    expect(result.listings[0].areaMatch.near).toBe(false);
  });

  it("treats a query that is only a place as an area, and an unknown area as unresolved", async () => {
    mocks.publicListings.mockResolvedValue([home("brooklyn")]);
    const byQuery = await listLiveListingsTool.handler(serviceCtx(), { query: "near UW campus" }) as { count: number; area: { resolved: boolean } };
    expect(byQuery.count).toBe(1);
    expect(byQuery.area.resolved).toBe(true);
    const unknown = await listLiveListingsTool.handler(serviceCtx(), { area: "Tacoma" }) as { count: number; area: { resolved: boolean } };
    expect(unknown.area.resolved).toBe(false);
    expect(unknown.count).toBe(1);
  });

  it("never resolves a home outside the service catalog, even by its id", async () => {
    mocks.publicListings.mockResolvedValue([home("brooklyn")]);
    await expect(getListingDetailsTool.handler(serviceCtx(), { propertyId: "not-a-service-home" })).resolves.toEqual({ found: false });
    await expect(buildProspectLinksTool.handler(serviceCtx(), { propertyId: "not-a-service-home" })).resolves.toEqual({ ok: false, error: "listing_not_found" });
  });

  it("fails closed when the service catalog cannot be read: the tool errors, no other workspace answers", async () => {
    const ctx = { landlordId: SERVICE_OWNER, db: { from: () => fakeDbFrom("portal_workspaces") }, leasingScope: { serviceCatalog: true } } as never;
    mocks.publicListings.mockRejectedValue(new Error("db down"));
    await expect(listLiveListingsTool.handler(ctx, {})).rejects.toThrow();
  });
});
