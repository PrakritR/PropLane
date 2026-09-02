import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";

vi.mock("@/lib/property-lead-notification.server", () => ({
  notifyManagerPropertyLeadMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/tour-notification-delivery.server", () => ({
  recordResidentProspectInboxMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

// Three dependencies the route gained since this test was written. Unmocked they
// run for real (including a live Supabase auth read) and the handler answers 500.
vi.mock("@/lib/property-lead-prospect-handoff.server", () => ({
  notifyProspectPropertyMessageHandoff: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/tour-resident-link.server", () => ({
  reconcileProspectInboxThreadsForResident: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn().mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
  }),
}));

import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { POST as propertyLeadMessage } from "@/app/api/public/property-lead-message/route";

describe("POST /api/public/property-lead-message", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("validates required fields", async () => {
    const req = jsonRequest("http://localhost/api/public/property-lead-message", {
      method: "POST",
      body: { propertyId: "", name: "", email: "bad", topic: "", body: "" },
    });
    const res = await propertyLeadMessage(req);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("accepts valid property lead message", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "prop-1",
                manager_user_id: "mgr-1",
                property_data: { title: "Test Property" },
              },
              error: null,
            }),
          }),
        }),
      }),
    } as never);

    const req = jsonRequest("http://localhost/api/public/property-lead-message", {
      method: "POST",
      body: {
        propertyId: "prop-1",
        name: "Jane Smith",
        email: "jane@example.com",
        topic: "Availability",
        body: "Is this unit still available?",
      },
    });
    const res = await propertyLeadMessage(req);
    const { status, data } = await parseJsonResponse<{ ok?: boolean }>(res);
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
  });
});
