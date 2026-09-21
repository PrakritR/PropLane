import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceRequestScope: vi.fn().mockResolvedValue({ kind: "normal" }),
}));

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
});
