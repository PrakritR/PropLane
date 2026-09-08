// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const showToast = vi.fn();

vi.mock("@/components/auth/auth-card", () => ({ AuthCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/auth/auth-mobile-primitives", () => ({
  AuthPageHeader: ({ title, subtitle }: { title: string; subtitle: string }) => (
    <header><h1>{title}</h1><p>{subtitle}</p></header>
  ),
}));
vi.mock("@/components/auth/manager-plan-tier-cards", () => ({
  ManagerPlanBillingToggle: () => <div>Billing toggle</div>,
  ManagerPlanTierCards: () => <div>Plan cards</div>,
}));
vi.mock("@/components/stripe/embedded-checkout", () => ({ EmbeddedCheckoutMount: () => null }));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),
 useAppUi: () => ({ showToast }) }));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));
vi.mock("@/lib/site-content", () => ({ loadManagerPlanTiers: () => Promise.reject(new Error("offline")) }));

import { ManagerEntryPlanChooser } from "@/components/auth/manager-entry-plan-chooser";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  showToast.mockReset();
  vi.restoreAllMocks();
});

describe("manager entry plan promo", () => {
  it("sends FREE100 to the server waiver path instead of opening Stripe", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tier: "pro", billing: "trial", stripeManaged: false, appleManaged: false }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ waiverApplied: true, message: "Promo code applied." }),
      });
    vi.stubGlobal("fetch", request);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<ManagerEntryPlanChooser />);
    const promo = await screen.findByLabelText(/promo code/i);
    fireEvent.change(promo, { target: { value: "free100" } });
    fireEvent.click(screen.getByRole("button", { name: /apply code and continue/i }));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenLastCalledWith(
      "/api/stripe/subscription/update-tier",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ tier: "pro", billing: "monthly", promo: "free100" }),
      }),
    );
    expect(request).not.toHaveBeenCalledWith("/api/manager/pricing-oauth-continue", expect.anything());
  });
});
