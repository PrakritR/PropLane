// The leasing SMS agent is told which home a locked phone is talking about: derived from the session row on the server (never
// the text), re-checked against the routed manager, moved by a switch, carried in the agent context and used by the listing tool.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LEAD_CONSTRAINTS, leadFakeDb, type LeadFakeDb } from "../helpers/lead-fake-db";

const mocks = vi.hoisted(() => ({ publicListings: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: mocks.publicListings }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

import { loadLockedHomeContext, lockedHomePromptNote } from "@/lib/one-number/locked-home-context.server";
import { saveSharedLineRoute } from "@/lib/one-number/session.server";
import { buildLeasingSmsAgentContext } from "@/lib/tools/context";
import { __resetLeasingCatalogCache, listLiveListingsTool } from "@/lib/tools/domains/leasing-sms";
import { resetServiceCatalogCache } from "@/lib/service/service-catalog.server";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PHONE = "+12065550177";
const KEY = "2065550177";

function seed(): LeadFakeDb {
  return leadFakeDb(
    {
      portal_workspaces: [
        { id: WS_A, name: "A", owner_user_id: OWNER_A, is_default: true, is_service: false },
        { id: WS_B, name: "B", owner_user_id: OWNER_B, is_default: true, is_service: false },
      ],
      manager_property_records: [
        { id: "prop-a", workspace_id: WS_A, manager_user_id: OWNER_A, status: "live", property_data: { address: "5020 Roosevelt Way NE, Seattle, WA" } },
        { id: "prop-b", workspace_id: WS_B, manager_user_id: OWNER_B, status: "live", property_data: { address: "4709A 8th Ave NE, Seattle, WA" } },
        { id: "prop-draft", workspace_id: WS_A, manager_user_id: OWNER_A, status: "draft", property_data: { address: "9 Draft St" } },
      ],
    },
    { constraints: LEAD_CONSTRAINTS },
  );
}

describe("the locked home, as the leasing agent sees it", () => {
  it("reads the lock from the session row, for the manager the text was routed to", async () => {
    const f = seed();
    expect(await loadLockedHomeContext(f.db, { prospectPhone: PHONE, landlordId: OWNER_A, workspaceId: WS_A })).toBeNull();
    await saveSharedLineRoute(f.db, KEY, { workspaceId: WS_A, role: "prospect", lockedPropertyId: "prop-a" });
    expect(await loadLockedHomeContext(f.db, { prospectPhone: PHONE, landlordId: OWNER_A, workspaceId: WS_A })).toEqual({ propertyId: "prop-a", label: "5020 Roosevelt Way NE" });
  });

  it("a switch updates it: the next turn carries the new home, for the new manager", async () => {
    const f = seed();
    await saveSharedLineRoute(f.db, KEY, { workspaceId: WS_A, role: "prospect", lockedPropertyId: "prop-a" });
    await saveSharedLineRoute(f.db, KEY, { workspaceId: WS_B, role: "prospect", lockedPropertyId: "prop-b" });
    expect(await loadLockedHomeContext(f.db, { prospectPhone: PHONE, landlordId: OWNER_B, workspaceId: WS_B })).toEqual({ propertyId: "prop-b", label: "4709A 8th Ave NE" });
    // The old manager's agent is told nothing about a home that is no longer the lock.
    expect(await loadLockedHomeContext(f.db, { prospectPhone: PHONE, landlordId: OWNER_A, workspaceId: WS_A })).toBeNull();
  });

  it("a lock that points at another manager's workspace, a draft home or nothing reads as no lock", async () => {
    const f = seed();
    await saveSharedLineRoute(f.db, KEY, { workspaceId: WS_A, role: "prospect", lockedPropertyId: "prop-b" });
    expect(await loadLockedHomeContext(f.db, { prospectPhone: PHONE, landlordId: OWNER_A, workspaceId: WS_A })).toBeNull();
    await saveSharedLineRoute(f.db, KEY, { workspaceId: WS_A, role: "prospect", lockedPropertyId: "prop-draft" });
    expect(await loadLockedHomeContext(f.db, { prospectPhone: PHONE, landlordId: OWNER_A, workspaceId: WS_A })).toBeNull();
    await saveSharedLineRoute(f.db, KEY, { workspaceId: WS_A, role: "prospect", lockedPropertyId: "prop-a" });
    expect(await loadLockedHomeContext(f.db, { prospectPhone: PHONE, landlordId: OWNER_A, workspaceId: WS_B })).toBeNull();
    expect(await loadLockedHomeContext(f.db, { prospectPhone: "not a phone", landlordId: OWNER_A })).toBeNull();
  });

  it("is carried in the agent context and named in the system prompt", () => {
    const lockedHome = { propertyId: "prop-a", label: "5020 Roosevelt Way NE" };
    const ctx = buildLeasingSmsAgentContext({} as never, { landlordId: OWNER_A, scope: { sessionId: "s1", prospectPhoneE164: PHONE, workNumber: null, channel: "sms", lockedHome } });
    expect(ctx.leasingScope?.lockedHome).toEqual(lockedHome);
    const note = lockedHomePromptNote(lockedHome);
    expect(note).toContain("5020 Roosevelt Way NE");
    expect(note).toContain("prop-a");
    expect(note).toMatch(/is parking included/);
  });
});

describe("list_live_listings prefers the locked home", () => {
  const listing = (id: string, extra: Record<string, unknown> = {}) => ({
    id, title: id, buildingName: id, address: `${id} St`, neighborhood: "University District", zip: "98105", managerUserId: OWNER_A, workspaceId: WS_A,
    rentLabel: "$900 / mo", listingSubmission: { v: 1, rooms: [{ id: `${id}-r1`, name: "Room A", monthlyRent: 900 }] }, ...extra,
  });
  beforeEach(() => {
    __resetLeasingCatalogCache(); resetServiceCatalogCache(); vi.clearAllMocks();
    mocks.publicListings.mockResolvedValue([listing("alpha"), listing("bravo"), listing("charlie")]);
  });
  const ctx = (lockedHome?: { propertyId: string; label: string }) => {
    const db = { from: () => { const q: Record<string, unknown> = { select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q, is: () => q, maybeSingle: async () => ({ data: null, error: null }), then: (r: (v: unknown) => unknown) => r({ data: [], error: null }) }; return q; } };
    return { landlordId: OWNER_A, db, leasingScope: { crossCatalog: true, prospectPhoneE164: PHONE, channel: "sms", workNumber: null, sessionId: "s", ...(lockedHome ? { lockedHome } : {}) } } as never;
  };

  it("puts the locked home first on a plain browse and says which it is", async () => {
    const plain = await listLiveListingsTool.handler(ctx(), {}) as { listings: { propertyId: string }[] };
    const locked = await listLiveListingsTool.handler(ctx({ propertyId: "charlie", label: "charlie St" }), {}) as { listings: { propertyId: string }[]; lockedPropertyId?: string };
    expect(plain.listings[0]!.propertyId).not.toBe("charlie");
    expect(locked.listings[0]!.propertyId).toBe("charlie");
    expect(locked.lockedPropertyId).toBe("charlie");
    expect(locked.listings).toHaveLength(plain.listings.length);
  });

  it("a different lock moves the preference with it", async () => {
    const result = await listLiveListingsTool.handler(ctx({ propertyId: "bravo", label: "bravo St" }), {}) as { listings: { propertyId: string }[] };
    expect(result.listings[0]!.propertyId).toBe("bravo");
  });
});
