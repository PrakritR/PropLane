// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/applications/approved/AXIS-TEST",
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

const paymentProps: Array<{
  packageSlug: string;
  addOnProducts: string[];
}> = [];

vi.mock("@/components/portal/screening-inline-payment", () => ({
  ScreeningInlinePayment: (props: { packageSlug: string; addOnProducts: string[] }) => {
    paymentProps.push({ packageSlug: props.packageSlug, addOnProducts: props.addOnProducts });
    return <div data-testid="inline-payment" />;
  },
}));

import { CheckrScreeningModal } from "@/components/portal/checkr-screening-modal";

afterEach(() => {
  cleanup();
  paymentProps.length = 0;
  vi.unstubAllGlobals();
});

const row: DemoApplicantRow = {
  id: "AXIS-TEST",
  name: "Olivia Brooks",
  email: "olivia.brooks.workflow@test.proplane.local",
  property: "Ballard House",
  propertyId: "prop-ballard",
  stage: "Submitted",
  bucket: "approved",
  detail: "Pending",
  application: {
    consentCredit: true,
    email: "olivia.brooks.workflow@test.proplane.local",
  } as DemoApplicantRow["application"],
};

describe("CheckrScreeningModal — pricing", () => {
  it("updates order total and checkout selection when package or identity add-on changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          configured: true,
          screeningAllowed: true,
          packages: [
            {
              slug: "starter",
              name: "Starter",
              priceCents: 2499,
              tagline: "Basic",
              features: ["Criminal"],
            },
            {
              slug: "essential",
              name: "Essential",
              priceCents: 3499,
              tagline: "Full",
              features: ["Credit"],
              popular: true,
            },
          ],
          addOns: [
            {
              slug: "identity_verification",
              name: "Identity protection",
              priceCents: 295,
              description: "ID check",
            },
          ],
        }),
      }),
    );

    render(<CheckrScreeningModal row={row} open showPackagePickerInitially onClose={() => {}} />);

    const orderSummaryText = () =>
      document.querySelector('[data-attr="screening-order-summary"]')?.textContent ?? "";

    await waitFor(() => {
      expect(orderSummaryText()).toContain("$34.99");
    });

    fireEvent.click(screen.getByRole("button", { name: /Starter/i }));

    await waitFor(() => {
      expect(orderSummaryText()).toContain("$24.99");
    });

    fireEvent.click(screen.getByLabelText(/Add Identity protection/i));

    await waitFor(() => {
      expect(orderSummaryText()).toContain("$27.94");
    });

    await waitFor(
      () => {
        const last = paymentProps.at(-1);
        expect(last?.packageSlug).toBe("starter");
        expect(last?.addOnProducts).toEqual(["identity_verification"]);
      },
      { timeout: 2000 },
    );
  });
});
