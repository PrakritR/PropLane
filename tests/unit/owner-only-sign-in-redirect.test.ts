import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";

vi.mock("@/lib/auth/account-recovery.server", () => ({ recoverySetupRedirect: vi.fn(async () => null) }));
vi.mock("@/lib/auth/manager-portal-provision", () => ({ ensureFreeManagerPortalAccess: vi.fn() }));
vi.mock("@/lib/auth/complete-resident-signup-oauth", () => ({ completeResidentSignupFromOAuth: vi.fn() }));
vi.mock("@/lib/auth/manager-onboarding", () => ({
  // A plan-less owner would be sent to pricing by this check; the owner-only branch must win first.
  managerNeedsPricingSelection: vi.fn(async () => true),
  findManagerPurchaseForAccount: vi.fn(async () => null),
  isManagerOnboardingComplete: vi.fn(() => false),
}));
vi.mock("@/lib/auth/primary-admin", () => ({ isPrimaryAdminEmail: vi.fn(() => false) }));
vi.mock("@/lib/auth/profile-role-row", () => ({ ensureProfileRoleRow: vi.fn(async () => undefined) }));

const ownerOnly = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/property-owner/access.server", () => ({
  ownerAccessStateFor: vi.fn(async () => ({ hasOwnerAccess: true, ownerOnly: ownerOnly.value, messagesOn: false })),
}));

function db() {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () =>
          table === "profile_roles"
            ? Promise.resolve({ data: [{ role: "manager" }], error: null })
            : { maybeSingle: () => Promise.resolve({ data: { role: "manager" }, error: null }) },
      }),
    }),
  };
}

const user = { id: "owner-1", email: "owner@example.com" } as User;

describe("owner-only sign-in", () => {
  beforeEach(() => {
    ownerOnly.value = true;
  });

  it("lands a plan-less Property owner on /portal/owner, not the plan chooser", async () => {
    const { resolveOAuthPortalRedirect } = await import("@/lib/auth/resolve-oauth-portal-access");
    expect(await resolveOAuthPortalRedirect(db() as never, user, "/auth/continue")).toBe("/portal/owner");
  });

  it("leaves a manager who also has an owner row on the normal manager route", async () => {
    ownerOnly.value = false;
    const { resolveOAuthPortalRedirect } = await import("@/lib/auth/resolve-oauth-portal-access");
    expect(await resolveOAuthPortalRedirect(db() as never, user, "/auth/continue")).not.toBe("/portal/owner");
  });
});
