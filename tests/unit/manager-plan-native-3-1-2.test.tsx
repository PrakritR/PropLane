// @vitest-environment jsdom
//
// App Store Guideline 3.1.2: the native purchase screen itself must carry
//
//   1. the subscription title,
//   2. the subscription length and monthly/annual renewal cadence,
//   3. the price per period,
//   4. a plain auto-renew statement,
//   5. a working Terms of Use (EULA) link, and
//   6. a working Privacy Policy link,
//
// and PropLane was already rejected once for the missing Terms link. The legal
// links are BUTTONS driving the in-app browser (`openAppUrl`) — never `<a href>`
// anchors, which the companion 3.1.1 test forbids on this surface and which
// would bounce the manager out of the WebView, losing their session.
//
// The screen also shows all three tiers with the current one marked, so a
// manager can see where they stand — Free included, with an honest
// "Switch to Free" for trial/comped accounts (no store purchase involved).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/hooks/use-is-native-app", () => ({
  useIsNativeApp: () => ({ isNative: true, platform: "ios" }),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "u1", email: "m@x.com", ready: true }),
}));
const showToast = vi.fn();
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));

const openAppUrl = vi.fn(async () => undefined);
vi.mock("@/lib/native/open-url", () => ({
  openAppUrl: (...a: unknown[]) => openAppUrl(...a),
}));

const proPkg = { __pkg: "pro" };
const businessPkg = { __pkg: "business" };
vi.mock("@/lib/native/revenuecat-client", () => ({
  configureRevenueCat: vi.fn(async () => true),
  getManagerOfferings: vi.fn(async () => [
    {
      productId: "space.proplane.app.pro.monthly",
      tier: "pro",
      billing: "monthly",
      priceString: "$20.00",
      title: "Pro",
      pkg: proPkg,
    },
    {
      productId: "space.proplane.app.pro.annual",
      tier: "pro",
      billing: "annual",
      priceString: "$192.00",
      title: "Pro Annual",
      pkg: { __pkg: "pro-annual" },
    },
    {
      productId: "space.proplane.app.business.monthly",
      tier: "business",
      billing: "monthly",
      priceString: "$200.00",
      title: "Business",
      pkg: businessPkg,
    },
    {
      productId: "space.proplane.app.business.annual",
      tier: "business",
      billing: "annual",
      priceString: "$1,920.00",
      title: "Business Annual",
      pkg: { __pkg: "business-annual" },
    },
  ]),
  purchaseManagerPackage: vi.fn(async () => ({ status: "cancelled" as const })),
  restoreManagerPurchases: vi.fn(async () => ({ ok: true, hasActiveEntitlement: false })),
}));

import {
  ManagerPlanNative,
  NATIVE_PLAN_PRIVACY_URL,
  NATIVE_PLAN_TERMS_URL,
} from "@/components/portal/pro-plan-native";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPurchaseSurface(overrides: Partial<Parameters<typeof ManagerPlanNative>[0]> = {}) {
  return render(
    <ManagerPlanNative
      currentTier="free"
      subLoaded
      stripeManaged={false}
      appleManaged={false}
      isFree
      onReload={vi.fn()}
      {...overrides}
    />,
  );
}

describe("native purchase screen — Guideline 3.1.2 required elements", () => {
  it("shows annual pricing by default and keeps monthly pricing selectable", async () => {
    renderPurchaseSurface();

    // Annual is the value-forward default, using localized App Store prices.
    expect(await screen.findByText("PropLane Pro")).toBeTruthy();
    expect(screen.getByText("PropLane Business")).toBeTruthy();
    expect(screen.getByText("$192.00")).toBeTruthy();
    expect(screen.getByText("$1,920.00")).toBeTruthy();
    expect(screen.getAllByText(/1-year subscription · renews annually until canceled/i).length).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: "Monthly" }));
    expect(screen.getByText("$20.00")).toBeTruthy();
    expect(screen.getByText("$200.00")).toBeTruthy();
    expect(screen.getAllByText(/1-month subscription · renews monthly until canceled/i).length).toBe(2);

    // Plain auto-renew statement.
    expect(screen.getByText(/selected monthly or annual period/i)).toBeTruthy();
    expect(screen.getByText(/cancel anytime in your App Store account settings/i)).toBeTruthy();
  });

  it("Terms of Use (EULA) and Privacy Policy open in-app via openAppUrl — never an anchor", async () => {
    const { container } = renderPurchaseSurface();
    await screen.findByText("PropLane Pro");

    const terms = screen.getByRole("button", { name: /terms of use/i });
    const privacy = screen.getByRole("button", { name: /privacy policy/i });

    fireEvent.click(terms);
    await waitFor(() => expect(openAppUrl).toHaveBeenCalledWith(NATIVE_PLAN_TERMS_URL));
    fireEvent.click(privacy);
    await waitFor(() => expect(openAppUrl).toHaveBeenCalledWith(NATIVE_PLAN_PRIVACY_URL));

    expect(NATIVE_PLAN_TERMS_URL).toBe("https://prop-lane.space/tos");
    expect(NATIVE_PLAN_PRIVACY_URL).toBe("https://prop-lane.space/privacy");

    // The 3.1.1 companion test's rule, restated here: no anchors at all.
    expect(container.querySelectorAll("a[href]").length).toBe(0);
  });

  it("marks the current tier — Free badge when free, paid card badge when trialing that tier", async () => {
    renderPurchaseSurface();
    await screen.findByText("PropLane Pro");
    expect(screen.getByText(/current plan/i)).toBeTruthy();

    cleanup();

    renderPurchaseSurface({ currentTier: "pro", isFree: false, trialActive: true });
    await screen.findByText("PropLane Pro");
    expect(screen.getByText(/current · trial/i)).toBeTruthy();
    // Trial accounts can honestly step down to Free — a server-side plan
    // change, not a purchase and not an Apple-subscription cancellation.
    expect(screen.getByRole("button", { name: /switch to free/i })).toBeTruthy();
  });

  it("offers no plan change at all when the plan could not be read — restore stays", async () => {
    // A failed purchase-row read reports `planUnknown` with every paid signal
    // nulled, so an active Stripe/Apple subscription is invisible: both
    // manage-only branches would be bypassed. Writing tier=free off that guess
    // cancels a real plan, and a StoreKit purchase bills a duplicate one.
    renderPurchaseSurface({ currentTier: "pro", isFree: false, trialActive: true, planUnknown: true });

    expect(await screen.findByText(/couldn’t load your plan|couldn't load your plan/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /switch to free/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /subscribe to/i })).toBeNull();
    expect(screen.queryByText("PropLane Pro")).toBeNull();
    expect(screen.queryByText("PropLane Business")).toBeNull();
    // Restore only re-reads what the App Store already knows — safe, and the
    // way a manager whose row failed to read gets their entitlement back.
    expect(screen.getByRole("button", { name: /restore purchases/i })).toBeTruthy();
  });

  it("a PARTIAL read failure that still knows the subscription keeps the manage-only notice", async () => {
    // `readFailed` is ORed across the profile / by-user-id / by-email lookups,
    // so `planUnknown` can arrive alongside a real Apple or Stripe signal. The
    // more specific state wins there — the generic retry card would tell an
    // Apple subscriber nothing about where their plan is managed.
    renderPurchaseSurface({ currentTier: "pro", isFree: false, appleManaged: true, planUnknown: true });
    expect(screen.getByText(/Apple Account › Subscriptions/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /terms of use/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /subscribe to/i })).toBeNull();

    cleanup();

    renderPurchaseSurface({ currentTier: "pro", isFree: false, stripeManaged: true, planUnknown: true });
    expect(screen.getByText(/nothing to purchase here/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /subscribe to/i })).toBeNull();
  });

  it("the legal footer also renders on the Apple-managed manage-only branch", () => {
    renderPurchaseSurface({ currentTier: "pro", isFree: false, appleManaged: true });
    expect(screen.getByRole("button", { name: /terms of use/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /privacy policy/i })).toBeTruthy();
    // Downgrade honesty: Apple subscriptions change in App Store settings.
    expect(screen.getByText(/Apple Account › Subscriptions/i)).toBeTruthy();
  });
});
