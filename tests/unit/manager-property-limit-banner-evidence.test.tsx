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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// Transform the full portal before the assertion timer starts. The test still
// seeds and exercises the real component, without charging cold module loading
// against its behavior deadline.
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ManagerProperties } from "@/components/portal/pro-properties";

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
    // The circle reads a bare glyph like every other portal add control; "Add property"
    // is its ACCESSIBLE name, which is what a user is actually offered here — so
    // match on the role, not the visible glyph. One door in: no menu to open.
    const trigger = document.querySelector('[data-attr="manager-properties-add-top"]') as HTMLElement | null;
    expect(trigger).toBeTruthy();
    expect(trigger!.getAttribute("aria-label")).toBe("Add property");
    // Radix's dropdown trigger opens on pointerdown, not a bare click event,
    // so the interaction needs `userEvent` here even though nothing else in
    // this test does.
    await userEvent.click(trigger!);
    // A gate is a dialog, not a silent redirect (PLAN-0920-1058 "1d · The
    // pop-up") — clicking + at the cap opens a PortalDialog confirm naming the
    // limit, with an explicit Upgrade action, rather than a toast that
    // auto-navigates to Billing.
    await waitFor(() => {
      expect(screen.getByText(/Your plan allows 1 property/)).toBeTruthy();
    });
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Your plan allows 1 property. Upgrade to add more.");
    expect(screen.getByRole("button", { name: "Upgrade" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
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

  it("publish opens the confirmation dialog rather than navigating immediately (PRP-496)", () => {
    // A full click-through publish means walking the whole wizard to Review
    // (see `listing-wizard-v2-publish-navigates.test.tsx`); this pins the one
    // regression that matters here — the handler that used to `router.push`
    // straight to the listing detail route the instant publish resolved now
    // opens `ListingPublishedDialog` instead, so the manager picks where to go.
    const source = readFileSync(
      path.join(process.cwd(), "src/components/portal/pro-properties.tsx"),
      "utf8",
    );
    const region = source.slice(
      source.indexOf("onPublished={(listingId) => {"),
      source.indexOf("initialSubmission={resumeDraftRow?.submission"),
    );
    expect(region).toContain("setPublishedDialog(");
    expect(region).not.toMatch(/router\.push\(\s*propertyDetailHref/);
  });
});
