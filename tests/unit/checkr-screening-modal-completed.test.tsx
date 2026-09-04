// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/applications",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/lib/screening/screening-test-mode", () => ({
  isScreeningTestModeActive: () => false,
}));
vi.mock("@/lib/analytics/track-client", () => ({
  track: () => undefined,
}));
vi.mock("@/lib/manager-applications-storage", () => ({
  replaceManagerApplicationRowInCache: () => undefined,
}));
vi.mock("@/components/portal/screening-inline-payment", () => ({
  ScreeningInlinePayment: () => <div data-testid="inline-payment" />,
}));

import { CheckrScreeningModal } from "@/components/portal/checkr-screening-modal";

afterEach(cleanup);

const completedRow: DemoApplicantRow = {
  id: "AXIS-TEST",
  name: "Olivia Brooks",
  email: "olivia.brooks.workflow@test.proplane.local",
  property: "Ballard House",
  propertyId: "prop-ballard",
  stage: "Submitted",
  bucket: "approved",
  detail: "Approved",
  application: {
    consentCredit: true,
    email: "olivia.brooks.workflow@test.proplane.local",
  } as DemoApplicantRow["application"],
  backgroundCheck: {
    provider: "checkr",
    candidateId: "cand-1",
    reportId: "order-1",
    packageSlug: "essential",
    status: "complete",
    result: "clear",
    orderedAt: "2026-07-31T00:00:00.000Z",
    completedAt: "2026-07-31T00:05:00.000Z",
  },
};

describe("CheckrScreeningModal — completed check", () => {
/**
 * This file is the home of the completed-check flow.
 *
 * Two older tests asserted the same behaviour against surfaces that no longer
 * own it: `manager-applications-screening-modal` drove it from the Applications
 * DETAIL route, and `application-screening-panel-completed` expected the banner
 * on the screening panel. Screening moved to the Background checks section
 * (3c23cfc2), where the panel runs `headerActionsPlacement="parent"` and
 * publishes its controls to an adaptive footer, and the completed banner moved
 * into this modal. Both were removed as superseded rather than re-pointed,
 * because the assertions they made are the two below.
 */
  it("shows completed summary first, then package picker after Run again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          configured: true,
          screeningAllowed: true,
          packages: [
            {
              slug: "essential",
              name: "Essential",
              priceCents: 3499,
              tagline: "Full package",
              features: ["Credit report"],
            },
          ],
          addOns: [],
        }),
      }),
    );

    render(<CheckrScreeningModal row={completedRow} open onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/Background check already completed/i)).toBeTruthy();
    });
    expect(screen.queryByText("Select a package")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Run again/i }));

    expect(await screen.findByText("Select a package")).toBeTruthy();
    expect(screen.getByTestId("inline-payment")).toBeTruthy();

    vi.unstubAllGlobals();
  });

  it("opens directly on package picker when showPackagePickerInitially is set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          configured: true,
          screeningAllowed: true,
          packages: [
            {
              slug: "complete",
              name: "Complete",
              priceCents: 4499,
              tagline: "Upgrade package",
              features: ["Income verification"],
            },
          ],
          addOns: [],
        }),
      }),
    );

    render(
      <CheckrScreeningModal row={completedRow} open showPackagePickerInitially onClose={() => {}} />,
    );

    expect(await screen.findByText("Select a package")).toBeTruthy();
    expect(screen.queryByText(/Background check already completed/i)).toBeNull();

    vi.unstubAllGlobals();
  });
});
