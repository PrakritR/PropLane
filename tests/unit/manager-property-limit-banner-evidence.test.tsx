// @vitest-environment jsdom
/**
 * What the MANAGER sees when the Free plan's one-listing cap is spent.
 *
 * The route-level proof lives in
 * `tests/integration/free-plan-property-limit-evidence.test.ts`; this one renders
 * the real `ManagerProperties` surface — real banner copy, real "+ Add property"
 * gate, real toast through the real `AppUiProvider` — against the real
 * `/api/manager/subscription` client loader, so the sentence a manager actually
 * reads is pinned rather than described.
 *
 * Set `PROPERTY_LIMIT_EVIDENCE_DIR` to also write the rendered markup to that
 * directory, which is what a reviewer screenshots.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const MANAGER_ID = "mgr-free-plan-evidence";

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: MANAGER_ID, email: "free-manager@example.test", ready: true }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/portal/properties",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/manager-portfolio-access", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncManagerPortfolioFromServer: async () => {},
}));

/** The subscription route's answer for an account with no committed SKU. */
const SUBSCRIPTION_BODY = {
  tier: null,
  effectiveTier: "free",
  propertyLimit: 1,
  accountLinkLimit: 1,
  planUnknown: false,
};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/api/manager/subscription")) {
        return { ok: true, status: 200, json: async () => SUBSCRIPTION_BODY } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ snapshot: null }) } as unknown as Response;
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("manager Properties at the Free plan cap — rendered surface", () => {
  it("shows the limit banner with the upgrade path and refuses '+ Add property' by name", async () => {
    window.history.replaceState(null, "", "/portal/properties");
    window.localStorage.clear();
    stubFetch();

    const { resetManagerSubscriptionTierClientCache } = await import("@/lib/manager-subscription-client");
    resetManagerSubscriptionTierClientCache();

    // Seed the ONE listing the Free plan pays for, through the real publish path.
    const { createDefaultListingSubmission } = await import("@/lib/manager-listing-submission");
    const { publishManagerListingSubmissionToServer, countManagerManagedPropertiesForUser } = await import(
      "@/lib/demo-property-pipeline"
    );
    const published = await publishManagerListingSubmissionToServer(
      "mgr-maple-101",
      {
        ...createDefaultListingSubmission(),
        buildingName: "Maple St 101",
        address: "5200 Ravenna Ave NE",
        city: "Seattle",
        state: "WA",
        zip: "98105",
      },
      MANAGER_ID,
    );
    expect(published).toBe(true);
    expect(countManagerManagedPropertiesForUser(MANAGER_ID)).toBe(1);

    const { AppUiProvider } = await import("@/components/providers/app-ui-provider");
    const { ManagerProperties } = await import("@/components/portal/pro-properties");

    render(
      <AppUiProvider>
        <div className="portal-shell">
          <ManagerProperties />
        </div>
      </AppUiProvider>,
    );

    // The banner names the limit and links to the plans page.
    const banner = await screen.findByText(/reached your plan limit of/i);
    expect(banner.textContent).toContain("You've reached your plan limit of 1 property.");
    const { MANAGER_PLAN_PORTAL_URL } = await import("@/lib/portals/manager-plan-path");
    expect(banner.querySelector("a")?.textContent).toBe("View plans");
    expect(banner.querySelector("a")?.getAttribute("href")).toBe(MANAGER_PLAN_PORTAL_URL);

    const bannerHtml = document.body.innerHTML;

    // "+ Add property" is refused, and says why — with the limit and the upgrade path.
    // The row reads a uniform "ADD" like every other portal add row; "Add
    // property" is its ACCESSIBLE name, which is what a user is actually
    // offered here — so match on the role, not the visible glyph.
    const addButtons = screen.getAllByRole("button", { name: /Add property/i });
    fireEvent.click(addButtons[0]);
    await waitFor(() => {
      expect(screen.getByText(/Free includes 1 property/)).toBeTruthy();
    });
    const toast = screen.getByText(/Free includes 1 property/);
    expect(toast.textContent).toBe("Free includes 1 property. Upgrade to Pro or Business to add more.");
    // Refused before anything opens — the wizard never mounts.
    expect(screen.queryByText(/Submit listing/i)).toBeNull();

    const toastHtml = document.body.innerHTML;

    const outDir = process.env.PROPERTY_LIMIT_EVIDENCE_DIR;
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, "properties-at-limit.body.html"), bannerHtml);
      writeFileSync(path.join(outDir, "properties-add-refused.body.html"), toastHtml);
    }
  });
});
