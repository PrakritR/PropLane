import { beforeEach, describe, expect, it, vi } from "vitest";

const redeem = vi.hoisted(() => vi.fn());
const resolve = vi.hoisted(() => vi.fn());
const getUser = vi.hoisted(() => vi.fn());
const validateToken = vi.hoisted(() => vi.fn());
const application = vi.hoisted(() => ({
  id: "app-one", manager_user_id: "manager-1", property_id: "property-1",
  resident_email: "resident@example.com", row_data: { bucket: "pending", stage: "In progress" },
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })), clientIpFrom: () => "test" }));
vi.mock("@/lib/application-fee-checkout.server", () => ({ resolveApplicationFeeProperty: resolve }));
vi.mock("@/lib/application-fee-waiver", () => ({ redeemApplicationFeeWaiverCode: redeem }));
vi.mock("@/lib/auth/resident-setup-token", () => ({ isResidentSetupTokenValid: validateToken }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({
  from: (table: string) => ({ select() { return this; }, eq() { return this; },
    maybeSingle: async () => ({ data: table === "manager_application_records" ? application : null, error: null }) }),
}) }));

import { POST } from "@/app/api/public/application-fee-waiver/route";

function post(overrides: Record<string, unknown> = {}) {
  return POST(new Request("http://localhost/api/public/application-fee-waiver", { method: "POST",
    body: JSON.stringify({ applicationId: "app-one", propertyId: "property-1", managerUserId: "manager-1",
      residentEmail: "resident@example.com", setupToken: "owned-draft-token", code: "APPFREE", ...overrides }) }));
}

describe("application fee waiver redemption binds one saved draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: null } });
    validateToken.mockReturnValue(true);
    resolve.mockResolvedValue({ ok: true, value: { managerUserId: "manager-1" } });
    redeem.mockResolvedValue({ ok: true, codeId: "waiver-code-1" });
  });

  it("redeems an application code only against its owned draft", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(redeem).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      applicationId: "app-one", managerUserId: "manager-1", residentEmail: "resident@example.com" }));
  });

  it("rejects missing draft identity or invalid access before consuming a code", async () => {
    expect((await post({ applicationId: "" })).status).toBe(400);
    validateToken.mockReturnValue(false);
    expect((await post()).status).toBe(403);
    expect(redeem).not.toHaveBeenCalled();
  });

  it("does not accept a lease-only code as an application fee waiver", async () => {
    redeem.mockResolvedValue({ ok: false, reason: "NOT_FOUND", error: "That code does not waive the application fee." });
    const response = await post({ code: "LEASEONLY" });
    expect(response.status).toBe(400);
    expect((await response.json()).waived).toBeUndefined();
  });
});
