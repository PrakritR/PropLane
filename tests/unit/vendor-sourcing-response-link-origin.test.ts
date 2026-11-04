import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ issue: vi.fn(), db: { from: vi.fn() } }));
vi.mock("@/lib/auth/portal-access", () => ({ getPortalAccessContext: async () => ({ user: { id: "fixture-manager" }, effectiveRole: "manager" }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => mocks.db }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: async () => ({ kind: "allowed" }) }));
vi.mock("@/lib/vendor-sourcing.server", () => ({ sweepVendorSourcing: vi.fn() }));
vi.mock("@/lib/vendor-quote-contact.server", () => ({ createVendorQuoteResponseLink: mocks.issue }));
vi.mock("@/lib/vendor-dispatch-settings", () => ({ loadVendorDispatchSettings: vi.fn() }));
import { POST } from "@/app/api/portal/vendor-sourcing/route";
beforeEach(() => {
  vi.clearAllMocks();
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: { id: "fixture-service", manager_user_id: "fixture-manager" }, error: null }) };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query); mocks.db.from.mockReturnValue(query);
  mocks.issue.mockResolvedValue({ url: "https://example.invalid/vendor-quote#fixture", capabilityId: "fixture-capability" });
});
describe("authenticated manager response link origin", () => {
  it.each([
    ["http://localhost:3013", "same-origin", 200],
    ["http://attacker.invalid", "cross-site", 403],
    ["http://localhost:3013", "cross-site", 403],
    ["", "same-origin", 403],
  ])("checks requested host %s and site %s", async (origin, site, expected) => {
    const request = new Request("http://0.0.0.0:3013/api/portal/vendor-sourcing", { method: "POST", headers: {
      Host: "localhost:3013", Origin: origin, "Sec-Fetch-Site": site, "Content-Type": "application/json",
    }, body: JSON.stringify({ action: "response_link", workOrderId: "fixture-service", candidateId: "fixture-candidate" }) });
    const response = await POST(request);
    expect(response.status).toBe(expected);
    expect(mocks.issue).toHaveBeenCalledTimes(expected === 200 ? 1 : 0);
  });
});
