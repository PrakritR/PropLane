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

import { findHomesOnPropLaneTool, publicCatalogContext } from "@/lib/tools/domains/resident/public-homes";
import { buildResidentRegistry } from "@/lib/tools/resident-index";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";

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
  });

  it("reads the public catalog with no prospect identity and no service catalog", () => {
    const ctx = publicCatalogContext(residentCtx());
    expect(ctx.listingPublicOnly).toBe(true);
    expect(ctx.leasingScope?.crossCatalog).toBe(true);
    expect(ctx.leasingScope?.serviceCatalog).toBe(false);
    expect(ctx.leasingScope?.prospectPhoneE164).toBe("");
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
    expect(out.listings[0]!.tourUrl).toBe("https://proplane.ai/rent/tours-contact?propertyId=mgr-listing-a%20b");
    expect(out.listings[0]!.applyUrl).toBe("https://proplane.ai/rent/apply?propertyId=mgr-listing-a%20b");
    expect(out.listings[0]!.listingUrl).toBe("https://proplane.ai/rent/listings/x");
    expect(out.browseUrl).toBe("https://proplane.ai/rent/browse");
  });

  it("caps what the model reads to twelve homes", async () => {
    listHandler.mockResolvedValueOnce({ listings: Array.from({ length: 30 }, (_, i) => ({ propertyId: `p${i}`, rooms: [] })) });
    const out = (await findHomesOnPropLaneTool.handler(residentCtx(), {})) as { listings: unknown[] };
    expect(out.listings).toHaveLength(12);
  });
});
