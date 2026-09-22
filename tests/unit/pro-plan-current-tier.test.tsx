// @vitest-environment jsdom
//
// PLAN-0920-1400: ONE resolved tier drives the whole Plan section — the
// header and the scheduled-change banner must never disagree about what plan
// the account is actually on, even while a downgrade is scheduled for the
// next renewal.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/profile",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "manager@test.proplane.local" }),
}));
vi.mock("@/lib/site-content", () => ({ loadManagerPlanTiers: async () => [] }));
vi.mock("@/components/portal/manager-usage-panel", () => ({
  ManagerUsagePanel: () => <div data-testid="stub-usage" />,
  ManagerExtraUsagePanel: () => <div data-testid="stub-extra-usage" />,
  ManagerDoorsPanel: () => <div data-testid="stub-doors" />,
  useUsageSummary: () => ({ summary: null, error: null, load: async () => null }),
  useDoorCount: () => ({ data: null, error: null, load: async () => null }),
}));
vi.mock("@/components/portal/manager-plan-addons-panel", () => ({
  ManagerPlanAddonsPanel: () => <div data-testid="stub-addons" />,
}));
vi.mock("@/components/portal/manager-payment-methods-panel", () => ({
  ManagerPaymentMethodsPanel: () => <div data-testid="stub-payment" />,
}));
vi.mock("@/components/portal/pro-plan-native", () => ({
  ManagerPlanNative: () => null,
}));
vi.mock("@/components/portal/pro-plan-adjust-sheet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/portal/pro-plan-adjust-sheet")>()),
  PlanAdjustSheet: () => null,
}));

import { ManagerPlan } from "@/components/portal/pro-plan";

// Noon UTC is safely still Oct 1 in Pacific time (UTC-7 during PDT) — picking
// midnight UTC here would format one day early once converted.
const RENEWAL_UNIX = Math.floor(Date.parse("2026-10-01T18:00:00Z") / 1000);

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/manager/subscription")) {
        return Response.json({
          tier: "business",
          billing: "monthly",
          isPro: false,
          isBusiness: true,
          isFree: false,
          isLegacyUnlimited: false,
          stripeManaged: true,
          appleManaged: false,
          cancelAtPeriodEnd: false,
          currentPeriodEnd: RENEWAL_UNIX,
          scheduledDowngrade: { tier: "pro", billing: "monthly" },
        });
      }
      if (url.includes("/api/manager/invoices")) {
        return Response.json({ invoices: [] });
      }
      return Response.json({});
    }),
  );
}

beforeEach(() => {
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Plan section reads one resolved tier, even with a scheduled downgrade", () => {
  it("shows the CURRENT paid tier in the header and the target tier in the banner — never disagreeing", async () => {
    render(<ManagerPlan embedded showCurrentPlan={false} />);

    // The header states what the account IS today (Business) — the resolver
    // this page is built around (`resolveEffectiveManagerSkuTier`'s client
    // twin) is a single value threaded through both spots below.
    await waitFor(() => {
      expect(screen.getByText("Business plan")).toBeTruthy();
    });

    // The banner states what it is SCHEDULED to become (Pro) — a different
    // value, but stated as a change FROM the header's value, never a second
    // disagreeing "current plan".
    expect(await screen.findByText("Your plan changes to Pro on October 1, 2026.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();

    // No stray "current plan" claim for anything other than Business.
    expect(screen.queryByText("Pro plan")).toBeNull();
  });
});
