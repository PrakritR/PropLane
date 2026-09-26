import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";
import { DEFAULT_MANAGER_AUTOMATION_SETTINGS } from "@/lib/payment-automation-settings";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/payment-automation-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payment-automation-settings")>();
  return {
    ...actual,
    loadManagerAutomationSettings: vi.fn(),
    saveManagerAutomationSettings: vi.fn(),
  };
});

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  loadManagerAutomationSettings,
  saveManagerAutomationSettings,
} from "@/lib/payment-automation-settings";
import { GET, PATCH } from "@/app/api/portal/automation-settings/route";

function mockManagerAuth(userId = "mgr-a") {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: userId, email: "mgr@test.com" } },
      }),
    },
  } as never);

  const profileChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { role: "manager" } }),
  };
  const rolesChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(),
  };
  rolesChain.eq = vi.fn().mockResolvedValue({ data: [{ role: "manager" }] });

  // Backs the real loadVendorDispatchSettings/saveVendorDispatchSettings reads.
  const settingsChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
    upsert: vi.fn().mockResolvedValue({ error: null }),
  };

  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
    from: vi.fn((table: string) => {
      if (table === "profiles") return profileChain;
      if (table === "profile_roles") return rolesChain;
      if (table === "manager_automation_settings") return settingsChain;
      if (table === "manager_property_records") return {
        select: () => ({ eq: async () => ({ data: [], error: null }) }),
      };
      throw new Error(`Unexpected table ${table}`);
    }),
  } as never);
  return { settingsChain };
}

describe("/api/portal/automation-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadManagerAutomationSettings).mockResolvedValue(DEFAULT_MANAGER_AUTOMATION_SETTINGS);
    vi.mocked(saveManagerAutomationSettings).mockImplementation(async (_db, _id, settings) => settings);
  });

  it("GET returns 401 when unauthenticated", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    } as never);

    const res = await GET(new Request("http://localhost/api/portal/automation-settings"));
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(401);
  });

  it("GET returns 401 for non-manager users", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: "res-a", email: "res@test.com" } },
        }),
      },
    } as never);

    const profileChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { role: "resident" } }),
    };
    const rolesChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ data: [] }),
    };
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "profiles") return profileChain;
        if (table === "profile_roles") return rolesChain;
        throw new Error(`Unexpected table ${table}`);
      }),
    } as never);

    const res = await GET(new Request("http://localhost/api/portal/automation-settings"));
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(401);
  });

  it("GET returns manager automation settings", async () => {
    mockManagerAuth();

    const res = await GET(new Request("http://localhost/api/portal/automation-settings"));
    const { status, data } = await parseJsonResponse<{ settings?: { preDueReminderDays: number[] } }>(res);
    expect(status).toBe(200);
    expect(data.settings?.preDueReminderDays).toEqual([3, 2, 1]);
    expect(loadManagerAutomationSettings).toHaveBeenCalledWith(expect.anything(), "mgr-a");
  });

  it("PATCH updates settings for authenticated manager", async () => {
    mockManagerAuth();

    const req = jsonRequest("http://localhost/api/portal/automation-settings", {
      method: "PATCH",
      body: { preDueReminderDays: [5, 1] },
    });
    const res = await PATCH(req);
    const { status, data } = await parseJsonResponse<{ settings?: { preDueReminderDays: number[] } }>(res);
    expect(status).toBe(200);
    expect(data.settings?.preDueReminderDays).toEqual([5, 1]);
    expect(saveManagerAutomationSettings).toHaveBeenCalled();
  });

  it("GET includes vendor-dispatch settings defaulting to off", async () => {
    mockManagerAuth();

    const res = await GET(new Request("http://localhost/api/portal/automation-settings"));
    const { status, data } = await parseJsonResponse<{ vendorDispatch?: { mode: string } }>(res);
    expect(status).toBe(200);
    expect(data.vendorDispatch?.mode).toBe("off");
  });

  it("PATCH saves vendorDispatch without touching payment settings", async () => {
    const { settingsChain } = mockManagerAuth();

    const req = jsonRequest("http://localhost/api/portal/automation-settings", {
      method: "PATCH",
      body: { vendorDispatch: { mode: "approve", agentMessagingEnabled: true } },
    });
    const res = await PATCH(req);
    const { status, data } = await parseJsonResponse<{
      vendorDispatch?: { mode: string; agentMessagingEnabled: boolean };
    }>(res);
    expect(status).toBe(200);
    expect(data.vendorDispatch?.mode).toBe("approve");
    expect(data.vendorDispatch?.agentMessagingEnabled).toBe(true);
    expect(saveManagerAutomationSettings).not.toHaveBeenCalled();
    expect(settingsChain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ manager_user_id: "mgr-a", vendor_dispatch: expect.objectContaining({ mode: "approve" }) }),
      { onConflict: "manager_user_id" },
    );
  });
});
