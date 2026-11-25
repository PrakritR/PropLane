import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ scope: vi.fn(), tier: vi.fn() }));
vi.mock("react", () => ({ cache: (fn: unknown) => fn }));
vi.mock("@/lib/auth/portal-access", () => ({ getPortalAccessContext: async () => ({ user: { id: "staff", email: "staff@example.invalid" }, roles: ["manager"], effectiveRole: "manager" }), hasAdminRole: () => false, hasRole: () => true }));
vi.mock("@/lib/auth/admin-preview", () => ({ getAdminPreviewFromCookies: async () => null }));
vi.mock("@/lib/auth/effective-session", () => ({ getEffectiveUserIdForPortal: async () => "staff" }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/service/service-mode.server", () => ({ loadServiceStaffScope: mocks.scope }));
vi.mock("@/lib/manager-access-server", () => ({ getManagerPortalNavSubscriptionTier: mocks.tier, getManagerPurchaseSku: async () => ({ tier: "free", billing: "free", stripeSubscriptionId: null }) }));
import { getProPortalRenderContext } from "@/lib/portals/pro-nav";
beforeEach(() => { vi.clearAllMocks(); mocks.tier.mockResolvedValue("free"); mocks.scope.mockResolvedValue(null); });
describe("managed staff page entitlement", () => {
  it("opens the managed workspace's pages despite a free personal plan", async () => {
    mocks.scope.mockResolvedValue({ workspaceId: "managed", propertyIds: ["house"] });
    expect(await getProPortalRenderContext()).toMatchObject({ subscriptionTier: "paid", isFree: false });
  });
  it("keeps the personal plan gate outside authorized service mode", async () => {
    expect(await getProPortalRenderContext()).toMatchObject({ subscriptionTier: "free", isFree: true });
  });
});
