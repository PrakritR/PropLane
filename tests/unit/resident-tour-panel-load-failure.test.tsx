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
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),

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

  it("does not render like a genuine empty list when the read failed", async () => {
    stubToursResponse({
      ok: false,
      status: 503,
      body: { error: "We could not load your tours right now.", degraded: true },
    });

    render(<ResidentTourPanel />);
    await screen.findByRole("alert");

    // C120 collapsed the Pending/Confirmed/Declined status tabs (which used to
    // print a fabricated "Confirmed 0" on a failed read) into one merged list
    // with per-row status text — there is no longer a per-bucket count
    // anywhere to fabricate. The invariant this file guards now lives in the
    // load-error surface itself: a failure must render its own alert box
    // (asserted above) and never the "schedule a tour" empty-state row a
    // genuinely empty list shows.
    expect(document.querySelector('[data-attr="resident-tour-schedule"]')).toBeNull();
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
    // an empty read shows the ordinary empty state and NO error. The sibling
    // test above pins the other half: a load failure never renders this same
    // "schedule a tour" empty state (which is what would have made a failure
    // look like a confident, genuine zero).
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector('[data-attr="resident-tour-load-error"]')).toBeNull();
    expect(document.querySelector('[data-attr="resident-tour-list"]')).toBeNull();
  });
});
