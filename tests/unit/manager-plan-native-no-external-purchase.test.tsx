// @vitest-environment jsdom
//
// App Store Guideline 3.1.1 guard for the NATIVE (iOS) manager plan surface:
//
//  1. The in-app purchase surface (`ManagerPlanNative`) exposes a StoreKit
//     Subscribe path for Pro + Business and a REQUIRED "Restore purchases"
//     control (its absence is its own App Review rejection) — and it exposes NO
//     external/web purchase route (no anchor to Stripe checkout, the billing
//     portal, a pricing page, or any off-app URL).
//  2. The tier paywall's native branch links ONLY to the in-app plan page, never
//     an external upgrade URL, and the web upgrade CTA stays inside `.native-hide`
//     so it is display:none on native.
//
// These lock in that a manager on iOS can only ever be routed to StoreKit, so the
// 3.1.1 "digital content purchased outside the app" rejection cannot recur.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// ── Native shell context: pretend we are the iOS app with a signed-in manager.
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

// ── RevenueCat client wrapper: return two launch offerings; record purchase/restore.
const proPkg = { __pkg: "pro" };
const businessPkg = { __pkg: "business" };
const configureRevenueCat = vi.fn(async () => true);
const getManagerOfferings = vi.fn(async () => [
  { productId: "space.proplane.app.pro.monthly", tier: "pro", billing: "monthly", priceString: "$20.00", title: "Pro", pkg: proPkg },
  { productId: "space.proplane.app.business.monthly", tier: "business", billing: "monthly", priceString: "$200.00", title: "Business", pkg: businessPkg },
]);
const purchaseManagerPackage = vi.fn(async () => ({ status: "purchased" as const }));
const restoreManagerPurchases = vi.fn(async () => ({ ok: true, hasActiveEntitlement: true }));
vi.mock("@/lib/native/revenuecat-client", () => ({
  configureRevenueCat: (...a: unknown[]) => configureRevenueCat(...a),
  getManagerOfferings: (...a: unknown[]) => getManagerOfferings(...a),
  purchaseManagerPackage: (...a: unknown[]) => purchaseManagerPackage(...a),
  restoreManagerPurchases: (...a: unknown[]) => restoreManagerPurchases(...a),
}));

// Keep the paywall test focused on its own markup, not the portal page shell.
vi.mock("@/components/portal/portal-metrics", () => ({
  ManagerPortalPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { ManagerPlanNative } from "@/components/portal/pro-plan-native";
import { PortalTierPaywall } from "@/components/portal/portal-tier-paywall";

/** Any href that would take a native user off-app to buy/upgrade. */
const EXTERNAL_PURCHASE = /stripe|checkout|billing-portal|pricing|prop-lane\.space|axis-seattle|^https?:/i;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("native manager plan surface — StoreKit only, no external purchase route", () => {
  it("offers Subscribe + a Restore control and NO off-app purchase link", async () => {
    const { container } = render(
      <ManagerPlanNative
        currentTier="free"
        subLoaded
        stripeManaged={false}
        appleManaged={false}
        isFree
        onReload={vi.fn()}
      />,
    );

    // Offerings load asynchronously after configureRevenueCat.
    const subscribePro = await screen.findByRole("button", { name: /subscribe to pro/i });
    expect(subscribePro).toBeTruthy();
    expect(screen.getByRole("button", { name: /subscribe to business/i })).toBeTruthy();
    expect(configureRevenueCat).toHaveBeenCalledWith("u1");

    // Apple-required Restore control (AC#3).
    expect(container.querySelector('[data-attr="ios-restore-purchases"]')).toBeTruthy();

    // The whole surface is StoreKit buttons — no anchor, and certainly none that
    // routes to a web/Stripe purchase.
    for (const a of Array.from(container.querySelectorAll("a[href]"))) {
      expect(a.getAttribute("href")).not.toMatch(EXTERNAL_PURCHASE);
    }
  });

  it("Subscribe drives the StoreKit sheet, not a web checkout", async () => {
    // Cancelled outcome so the success-poll doesn't start — we only assert the
    // StoreKit sheet was invoked with the Pro package.
    purchaseManagerPackage.mockResolvedValueOnce({ status: "cancelled" as const });
    render(
      <ManagerPlanNative
        currentTier="free"
        subLoaded
        stripeManaged={false}
        appleManaged={false}
        isFree
        onReload={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /subscribe to pro/i }));
    await waitFor(() => expect(purchaseManagerPackage).toHaveBeenCalledWith(proPkg));
  });

  it("Restore purchases drives restorePurchases (the App Review-required control)", async () => {
    // No active entitlement so the success-poll doesn't start.
    restoreManagerPurchases.mockResolvedValueOnce({ ok: true, hasActiveEntitlement: false });
    render(
      <ManagerPlanNative
        currentTier="free"
        subLoaded
        stripeManaged={false}
        appleManaged={false}
        isFree
        onReload={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /restore purchases/i }));
    await waitFor(() => expect(restoreManagerPurchases).toHaveBeenCalledOnce());
  });

  it("does not offer a second purchase when the plan is already Apple-managed", () => {
    render(
      <ManagerPlanNative
        currentTier="pro"
        subLoaded
        stripeManaged={false}
        appleManaged
        isFree={false}
        onReload={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /subscribe/i })).toBeNull();
    expect(getManagerOfferings).not.toHaveBeenCalled();
    // Manage-in-App-Store copy (now also present in the 3.1.2 legal footer),
    // never a link to cancel/manage on the web.
    expect(screen.getAllByText(/App Store/i).length).toBeGreaterThan(0);
  });
});

describe("PortalTierPaywall native branch — links only in-app", () => {
  it("native-only content routes to the in-app plan page, web upgrade CTA is native-hidden", () => {
    const { container } = render(<PortalTierPaywall basePath="/portal" />);

    // There are several `.native-only` nodes (a text span + the CTA block);
    // gather links across all of them.
    const nativeOnlyNodes = Array.from(container.querySelectorAll(".native-only"));
    expect(nativeOnlyNodes.length).toBeGreaterThan(0);
    const nativeLinks = nativeOnlyNodes.flatMap((n) => Array.from(n.querySelectorAll("a[href]")));
    expect(nativeLinks.length).toBeGreaterThan(0);
    for (const a of nativeLinks) {
      const href = a.getAttribute("href") ?? "";
      expect(href).not.toMatch(EXTERNAL_PURCHASE);
      expect(href.startsWith("/")).toBe(true); // relative, stays in the WebView
    }

    // The web "upgrade" CTA must be inside a `.native-hide` container so it is
    // display:none on native — it must NOT live in the always-visible/native area.
    const upgradeCta = screen.getByText(/view plans & upgrade/i).closest("a");
    expect(upgradeCta).toBeTruthy();
    expect(upgradeCta!.closest(".native-hide")).toBeTruthy();
  });
});
