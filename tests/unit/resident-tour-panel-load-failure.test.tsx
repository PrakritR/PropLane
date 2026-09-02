// @vitest-environment jsdom
/**
 * The client half of "a failed read is not an empty tour list".
 *
 * `resident-tour-panel.tsx` used to run `if (data.degraded) setError(null)` —
 * it explicitly threw away the error — and swallowed a 401 outright, so a
 * backend failure rendered as the empty state plus the counts Pending 0 /
 * Confirmed 0 / Declined 0. That is an affirmative claim about the resident's
 * tours that the panel had no basis to make.
 *
 * Server half: `resident-tours-never-confident-zero.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ResidentTourPanel } from "@/components/portal/resident-tour-panel";

vi.mock("@/lib/portal-nav-client", () => ({
  usePortalNavigate: () => vi.fn(),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: () => {} }),
}));
// Spread the real module and stub only `Modal`. A hand-listed mock takes the
// whole file down the moment the module grows an export the component imports.
vi.mock("@/components/ui/modal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/modal")>()),
  Modal: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
}));
vi.mock("@/components/marketing/tour-schedule-flow", () => ({
  TourScheduleFlow: () => <div data-testid="tour-schedule-flow" />,
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  isPropertyActiveForLeads: () => true,
  loadPublicExtraListingsFromServer: () => Promise.resolve([]),
  loadPublicPropertyLeadFromServer: () => Promise.resolve(undefined),
  readExtraListingsPublic: () => [],
}));
vi.mock("@/lib/public-sandbox-listings", () => ({
  filterSandboxFromPublicCatalog: (list: unknown[]) => list,
}));
vi.mock("@/lib/public-demo-access", () => ({
  isProductionPublicSite: () => false,
}));
vi.mock("@/lib/rental-application/data", () => ({
  getPropertyById: () => undefined,
  getPropertyForPublicLink: () => undefined,
}));

afterEach(cleanup);

function stubToursResponse(response: { ok: boolean; status: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
    }),
  );
}

describe("ResidentTourPanel surfaces a failed read instead of an empty list", () => {
  it("shows an error state, not the empty state, when the route fails", async () => {
    stubToursResponse({
      ok: false,
      status: 503,
      body: { error: "We could not load your tours right now. Try again in a moment.", degraded: true },
    });

    render(<ResidentTourPanel />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("We could not load your tours");
    // The empty-state affordance is what made the zero look authoritative.
    expect(document.querySelector('[data-attr="resident-tour-list"]')).toBeNull();
    expect(document.querySelector('[data-attr="resident-tour-retry"]')).not.toBeNull();
  });

  it("does not print 0 counts on the status tabs when the read failed", async () => {
    stubToursResponse({
      ok: false,
      status: 503,
      body: { error: "We could not load your tours right now.", degraded: true },
    });

    render(<ResidentTourPanel />);
    await screen.findByRole("alert");

    // A resident with a confirmed tour was told "Confirmed 0". With no data,
    // the tabs must carry no number at all rather than a fabricated zero.
    for (const id of ["pending", "confirmed", "declined"]) {
      const tab = document.querySelector(`[data-attr="resident-tour-bucket-${id}"]`);
      expect(tab).not.toBeNull();
      expect(tab?.textContent ?? "").not.toMatch(/\b0\b/);
    }
  });

  it("treats a 401 as a load failure rather than zero tours", async () => {
    stubToursResponse({ ok: false, status: 401, body: {} });

    render(<ResidentTourPanel />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Sign in again");
  });

  it("still shows the ordinary empty state when the resident really has no tours", async () => {
    stubToursResponse({ ok: true, status: 200, body: { tours: [] } });

    render(<ResidentTourPanel />);

    await waitFor(() => {
      expect(document.querySelector('[data-attr="resident-tour-schedule"]')).not.toBeNull();
    });
    // "no tours" and "we could not read your tours" must never look the same:
    // an empty read shows the ordinary empty state and NO error.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector('[data-attr="resident-tour-load-error"]')).toBeNull();
    expect(document.querySelector('[data-attr="resident-tour-list"]')).toBeNull();
    // A genuine zero DOES get a count — that is the whole distinction this file
    // draws. The sibling test above pins the other half: when the read FAILED,
    // no count is printed, because "0" would be a lie rather than a fact.
    const pendingTab = document.querySelector('[data-attr="resident-tour-bucket-pending"]');
    expect(pendingTab?.textContent ?? "").toBe("Pending0");
  });
});
