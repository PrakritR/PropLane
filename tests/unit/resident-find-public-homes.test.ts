import { describe, expect, it, vi } from "vitest";

const listHandler = vi.fn();
vi.mock("@/lib/tools/domains/leasing-sms", async (orig) => {
  const actual = await orig<typeof import("@/lib/tools/domains/leasing-sms")>();
  return {
    ...actual,
    publicOrigin: () => "https://proplane.ai",
    listLiveListingsTool: { ...actual.listLiveListingsTool, handler: (...args: unknown[]) => listHandler(...args) },
  };
});

import { buildManagerApplyUrl, buildManagerTourUrl } from "@/lib/manager-property-links";
import { CHECKED_AVAILABILITY_HOME_LIMIT } from "@/lib/tools/domains/leasing-sms";
import { findHomesOnPropLaneTool, publicCatalogContext } from "@/lib/tools/domains/resident/public-homes";
import { buildResidentRegistry } from "@/lib/tools/resident-index";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import { routeResolves } from "../helpers/route-resolves";

function residentCtx(over: Partial<ResidentAgentContext> = {}): ResidentAgentContext {
  return {
    userId: "res-1",
    email: "quinn@test.proplane.local",
    db: {} as never,
    managerIds: [],
    phase: "application",
    channel: "portal",
    ...over,
  } as unknown as ResidentAgentContext;
}

describe("find_homes_on_proplane", () => {
  it("is on the portal assistant, including before a lease, and never on resident SMS or email", () => {
    expect(buildResidentRegistry(residentCtx()).get("find_homes_on_proplane")).toBeTruthy();
    expect(buildResidentRegistry(residentCtx({ phase: "active" } as never)).get("find_homes_on_proplane")).toBeTruthy();
    expect(buildResidentRegistry(residentCtx({ channel: "sms" })).get("find_homes_on_proplane")).toBeFalsy();
    expect(buildResidentRegistry(residentCtx({ channel: "email" })).get("find_homes_on_proplane")).toBeFalsy();
    // `channel` is optional: an unset channel is not the portal, so the public catalog stays out (fail closed).
    expect(buildResidentRegistry(residentCtx({ channel: undefined })).get("find_homes_on_proplane")).toBeFalsy();
  });

  it("reads the public catalog with no prospect identity and no service catalog", () => {
    const ctx = publicCatalogContext(residentCtx());
    expect(ctx.listingPublicOnly).toBe(true);
    expect(ctx.leasingScope?.crossCatalog).toBe(true);
    expect(ctx.leasingScope?.serviceCatalog).toBe(false);
    expect(ctx.leasingScope?.prospectPhoneE164).toBe("");
    // Never "sms": a portal turn must not carry a text conversation's authority.
    expect(ctx.leasingScope?.channel).toBe("portal");
    expect(ctx.landlordId).toBe("");
    expect(ctx.isAdmin).toBe(false);
  });

  it("returns each home with absolute tour and apply links beside its listing link", async () => {
    listHandler.mockResolvedValueOnce({
      count: 1,
      browseUrl: "https://proplane.ai/rent/browse",
      listings: [{ propertyId: "mgr-listing-a b", listingUrl: "https://proplane.ai/rent/listings/x", rooms: [] }],
    });
    const out = (await findHomesOnPropLaneTool.handler(residentCtx(), { area: "University of Washington" })) as {
      listings: Array<{ tourUrl: string; applyUrl: string; listingUrl: string }>;
      browseUrl: string;
    };
    expect(listHandler).toHaveBeenCalledWith(expect.objectContaining({ listingPublicOnly: true }), { area: "University of Washington" });
    // Built by the shared link builders, so a change to the query shape reaches this surface too.
    expect(out.listings[0]!.tourUrl).toBe(buildManagerTourUrl("https://proplane.ai", "mgr-listing-a b"));
    expect(out.listings[0]!.applyUrl).toBe(buildManagerApplyUrl("https://proplane.ai", { propertyId: "mgr-listing-a b" }));
    expect(out.listings[0]!.tourUrl).toContain("https://proplane.ai/rent/tours-contact?propertyId=");
    expect(out.listings[0]!.applyUrl).toContain("https://proplane.ai/rent/apply?propertyId=");
    // A link that names no route 404s silently; the string assertion alone would still pass.
    for (const url of [out.listings[0]!.tourUrl, out.listings[0]!.applyUrl]) {
      expect(routeResolves(new URL(url).pathname), `${url} must resolve against src/app`).toBe(true);
    }
    expect(out.listings[0]!.listingUrl).toBe("https://proplane.ai/rent/listings/x");
    expect(out.browseUrl).toBe("https://proplane.ai/rent/browse");
  });

  it("caps what the model reads to the homes whose availability was actually checked", async () => {
    listHandler.mockResolvedValueOnce({ count: 30, listings: Array.from({ length: 30 }, (_, i) => ({ propertyId: `p${i}`, rooms: [] })) });
    const out = (await findHomesOnPropLaneTool.handler(residentCtx(), {})) as { listings: unknown[]; count: number };
    expect(out.listings).toHaveLength(CHECKED_AVAILABILITY_HOME_LIMIT);
    expect(out.count).toBe(CHECKED_AVAILABILITY_HOME_LIMIT);
  });
});
