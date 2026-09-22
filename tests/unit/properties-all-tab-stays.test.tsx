// @vitest-environment jsdom
//
// PRP-494 added a first-listing onboarding effect that could redirect a
// brand-new manager (no listing of any kind yet) to the Drafts tab after an
// AWAITED account-links fetch resolved — well after the click that may have
// already sent the manager somewhere else on purpose. `origin/prakrit`
// removed that whole effect (and the click-tracking ref it needed): Add now
// always starts a blank listing instead, and drafts are only ever resumed
// from the Drafts tab itself. This guard keeps proving the outcome PRP-494
// cared about — the Properties stage is never yanked to Drafts on its own —
// now that there is no redirect code path left to race.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
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
        return { ok: true, status: 200, json: async () => ({ invites: [] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ snapshot: null }) } as unknown as Response;
    }),
  );
}

async function settle() {
  // Give every microtask/promise the mount kicked off a turn to run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
  push.mockClear();
  const { invalidateAccountLinksCache } = await import("@/lib/portal-data-store");
  invalidateAccountLinksCache();
});

describe("Properties stage is never redirected to Drafts on its own (PRP-494 effect removed)", () => {
  it("clicking All on a brand-new account never redirects to Drafts", async () => {
    // A brand-new manager: no listing of any kind. This is exactly the
    // account shape the old onboarding effect acted on — without the removal
    // holding, this scenario used to redirect to Drafts out from under the
    // manager's own click.
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

    const allTab = document.querySelector('[data-attr="manager-properties-tab-all"]') as HTMLElement;
    expect(allTab).toBeTruthy();
    fireEvent.click(allTab);

    await settle();

    expect(push).not.toHaveBeenCalledWith("/portal/properties/drafts", expect.anything());
  });

  it("the same brand-new account is also never redirected without a click — there is no automatic redirect left at all", async () => {
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

    await settle();

    expect(push).not.toHaveBeenCalledWith("/portal/properties/drafts", expect.anything());
  });
});
