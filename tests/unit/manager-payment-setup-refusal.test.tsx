// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

/**
 * `/api/stripe/connect/status` can refuse outright — a co-manager linked to two
 * owners (409) or an unreadable plan/link lookup (500) — and those bodies carry
 * only `{ error }`. Reading `canEditBankAccount` off such a body leaves bank
 * editing enabled (`undefined !== false`) and throws away the one sentence that
 * explains the refusal.
 */
const showToast = vi.fn();
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast }) }));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/lib/manager-subscription-client", () => ({
  loadManagerPaymentWaiverGrantedClient: vi.fn(async () => false),
}));
const openStripeConnectOnboarding = vi.fn(async () => undefined);
vi.mock("@/lib/stripe-connect-onboarding-client", () => ({
  openStripeConnectOnboarding: (...args: unknown[]) => openStripeConnectOnboarding(...args),
}));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ open, children, footer }: { open: boolean; children: ReactNode; footer?: ReactNode }) =>
    open ? <div role="dialog">{children}{footer}</div> : null,
  ModalFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { ManagerPaymentSetupModal } from "@/components/portal/pro-payment-setup-modal";

const AMBIGUOUS =
  "You co-manage properties for more than one owner, so payouts must be set up from the owner's own account.";

function respond(url: string) {
  if (url.startsWith("/api/stripe/connect/status")) {
    return { ok: false, status: 409, json: async () => ({ error: AMBIGUOUS }) };
  }
  return { ok: true, status: 200, json: async () => ({ settings: null }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => respond(String(input))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function mount() {
  await act(async () => {
    render(
      <ManagerPaymentSetupModal
        open
        onClose={vi.fn()}
        portalBase="/portal"
        propertyOptions={[{ id: "home", label: "Test home" }]}
        presetPropertyIds={["home"]}
      />,
    );
  });
}

it("shows the server's refusal instead of a generic retry message", async () => {
  await mount();
  expect(screen.getByText(AMBIGUOUS)).toBeTruthy();
});

it("does not leave bank editing enabled when the payout owner could not be resolved", async () => {
  await mount();
  const link = document.querySelector<HTMLButtonElement>('[data-attr="manager-payment-stripe-link"]');
  expect(link).toBeTruthy();
  await act(async () => { link!.click(); });
  expect(openStripeConnectOnboarding).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Only the property owner"));
});
