// @vitest-environment jsdom
//
// PRP-494: the first-listing onboarding effect decides whether to redirect a
// brand-new manager (no listing of any kind yet) to the Drafts tab — but that
// decision resolves only after an AWAITED account-links fetch, well after the
// click that may have already sent the manager somewhere else on purpose. It
// used to fire the redirect regardless, yanking the manager back to Drafts
// out from under a tab they had just picked. It now checks a ref set the
// moment a stage tab is clicked, and never overrides a stage the manager
// picked themselves.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ManagerProperties } from "@/components/portal/pro-properties";

let managerId = "";

const push = vi.fn();
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: managerId, email: "all-tab-stays@example.test", ready: true }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/portal/properties",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/manager-portfolio-access", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncManagerPortfolioFromServer: async () => true,
}));

/** Held open until the test releases it — models the awaited account-links fetch. */
let releaseAccountLinks: (() => void) | null = null;

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/api/manager/subscription")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ tier: null, effectiveTier: "starter", propertyLimit: null, accountLinkLimit: null, planUnknown: false }),
        } as unknown as Response;
      }
      if (href.includes("/api/pro/account-links")) {
        await new Promise<void>((resolve) => {
          releaseAccountLinks = resolve;
        });
        return { ok: true, status: 200, json: async () => ({ invites: [] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ snapshot: null }) } as unknown as Response;
    }),
  );
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
  push.mockClear();
  releaseAccountLinks = null;
  // `fetchAccountLinksCached` dedupes behind a short module-level TTL — force
  // the next test's mount to hit the (fresh) stub rather than replay this
  // test's cached, already-resolved answer.
  const { invalidateAccountLinksCache } = await import("@/lib/portal-data-store");
  invalidateAccountLinksCache();
});

describe("Properties stage never gets yanked back to Drafts after a manual pick (PRP-494)", () => {
  it("clicking All, then letting the pending onboarding decision resolve later, never redirects to Drafts", async () => {
    // A brand-new manager: no listing of any kind. This is exactly the
    // account shape `shouldAutoOpenFirstListingWizard` / `mustMoveToDrafts`
    // act on, so without the fix this scenario redirects to Drafts.
    managerId = "mgr-all-tab-stays-1";
    window.history.replaceState(null, "", "/portal/properties/listed");
    stubFetch();

    render(
      <AppUiProvider>
        <div className="portal-shell">
          <ManagerProperties stage="listed" />
        </div>
      </AppUiProvider>,
    );

    // The onboarding effect is now awaiting the account-links fetch (held open
    // above). Before it resolves, the manager clicks the All tab themselves.
    await waitFor(() => expect(releaseAccountLinks).not.toBeNull());
    const allTab = document.querySelector('[data-attr="manager-properties-tab-all"]') as HTMLElement;
    expect(allTab).toBeTruthy();
    fireEvent.click(allTab);

    // Now let the pending decision resolve.
    releaseAccountLinks?.();
    // Give every microtask/promise in the onboarding chain a turn to run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The redirect this fix guards against is the only thing that ever pushes
    // to the Drafts route from here.
    expect(push).not.toHaveBeenCalledWith("/portal/properties/drafts", expect.anything());
  });

  it("without a click, the same brand-new account IS moved to Drafts (control case — the guard is click-scoped, not a blanket disable)", async () => {
    managerId = "mgr-all-tab-stays-2";
    window.history.replaceState(null, "", "/portal/properties/listed");
    stubFetch();

    render(
      <AppUiProvider>
        <div className="portal-shell">
          <ManagerProperties stage="listed" />
        </div>
      </AppUiProvider>,
    );

    await waitFor(() => expect(releaseAccountLinks).not.toBeNull());
    // No click this time.
    releaseAccountLinks?.();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/portal/properties/drafts", expect.anything()));
  });
});
