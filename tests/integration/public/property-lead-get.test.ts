import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceRequestScope: vi.fn().mockResolvedValue({ kind: "normal" }),
}));

const geocode = vi.hoisted(() => vi.fn());
vi.mock("@/lib/listing-geocode.server", () => ({ geocodeListingAddressWithin: geocode }));
vi.mock("@/lib/listing-text-number.server", () => ({ resolveListingTextNumber: vi.fn().mockResolvedValue("+12065550100") }));

let propertyExtras: Record<string, unknown> = {};

import { GET as getPropertyLead } from "@/app/api/public/property-lead/route";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

function makeDb() {
  return {
    from: vi.fn((table: string) => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => {
          const result = {
            maybeSingle: vi.fn(async () =>
            table === "manager_property_records"
              ? {
                  data: {
                    id: "prop-live",
                    manager_user_id: "mgr-1",
                    status: "live",
                    // Legacy JSON intentionally has no `adminPublishLive`.
                    property_data: {
                      id: "prop-live",
                      title: "Live legacy listing",
                      address: "123 Main St",
                      neighborhood: "Seattle",
                      buildingName: "Main House",
                      unitLabel: "Room A",
                      rentLabel: "$1,200/mo",
                      ...propertyExtras,
                    },
                  },
                  error: null,
                }
              : {
                  data: {
                    id: "mgr-1",
                    email: "manager@example.com",
                    phone: null,
                    phone_verified_at: null,
                    sms_from_number: null,
                  },
                  error: null,
                },
            ),
            is: vi.fn(),
          };
          result.is.mockReturnValue(result);
          return result;
        }),
      })),
    })),
  };
}

describe("GET /api/public/property-lead", () => {
  beforeEach(() => {
    propertyExtras = {};
    geocode.mockReset();
    geocode.mockResolvedValue(null);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(makeDb() as never);
  });

  it("serves a live database listing whose legacy JSON lacks the publish flag", async () => {
    const response = await getPropertyLead(
      jsonRequest("http://localhost/api/public/property-lead?propertyId=prop-live"),
    );
    const { status, data } = await parseJsonResponse<{ property?: { id?: string; adminPublishLive?: boolean } }>(response);

    expect(status).toBe(200);
    expect(data.property?.id).toBe("prop-live");
    expect(data.property?.adminPublishLive).toBe(true);
  });

  it("sets the map pin from the ZIP-verified geocode and the text number from the one resolver", async () => {
    propertyExtras = { zip: "98105", state: "WA" };
    geocode.mockResolvedValue({ lat: 47.66, lng: -122.31 });
    const response = await getPropertyLead(
      jsonRequest("http://localhost/api/public/property-lead?propertyId=prop-live"),
    );
    const { data } = await parseJsonResponse<{ property?: { mapLat?: number; mapLng?: number; contactSmsPhone?: string } }>(response);

    expect(geocode).toHaveBeenCalledWith(expect.objectContaining({ address: "123 Main St", zip: "98105", state: "WA" }));
    expect(data.property).toMatchObject({ mapLat: 47.66, mapLng: -122.31, contactSmsPhone: "+12065550100" });
  });

  it("ships without a pin when the geocode gives none; a geocoded pin beats a stored one, which is only the fallback", async () => {
    propertyExtras = { zip: "98105" };
    const plain = await parseJsonResponse<{ property?: { mapLat?: number } }>(
      await getPropertyLead(jsonRequest("http://localhost/api/public/property-lead?propertyId=prop-live")),
    );
    expect(plain.data.property?.mapLat).toBeUndefined();

    propertyExtras = { zip: "98105", mapLat: 1, mapLng: 2 };
    geocode.mockResolvedValue({ lat: 47.66, lng: -122.31 });
    const geocoded = await parseJsonResponse<{ property?: { mapLat?: number } }>(
      await getPropertyLead(jsonRequest("http://localhost/api/public/property-lead?propertyId=prop-live")),
    );
    expect(geocoded.data.property?.mapLat).toBe(47.66);
    geocode.mockResolvedValue(null);
    const stored = await parseJsonResponse<{ property?: { mapLat?: number } }>(
      await getPropertyLead(jsonRequest("http://localhost/api/public/property-lead?propertyId=prop-live")),
    );
    expect(stored.data.property?.mapLat).toBe(1);
  });
});
