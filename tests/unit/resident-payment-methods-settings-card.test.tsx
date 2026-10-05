// @vitest-environment jsdom
//
// C145: payment methods and autopay live in Settings, not the Payments
// list. This is the self-contained card `resident-profile-panel.tsx` mounts
// on the Account pane, alongside sign out.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const replaced: string[] = [];
const pushed: string[] = [];
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (href: string) => pushed.push(href), replace: (href: string) => replaced.push(href) }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: () => {} }) }));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo/demo-session")>();
  return { ...actual, isDemoModeActive: () => false };
});
vi.mock("@/components/stripe-embedded-checkout", () => ({
  StripeEmbeddedCheckout: () => <div data-testid="stripe-checkout" />,
}));
vi.mock("@/components/portal/resident-bank-account-form", () => ({
  ResidentBankAccountForm: ({ intentId }: { intentId: string }) =>
    <div data-testid="resident-bank-form">{intentId}</div>,
}));

const AUTOPAY_RESPONSE = {
  managerAllowsAutopay: true,
  enabled: false,
  paymentMethodId: null,
  hasSavedMethod: true,
  savedMethods: [{ id: "pm_bank_1", type: "us_bank_account", label: "Chase •••• 4421", isDefault: true }],
  defaultMethod: { id: "pm_bank_1", type: "us_bank_account", label: "Chase •••• 4421", isDefault: true },
  runDaysBeforeDue: 0,
  nextScheduledCharge: null,
  failedRun: null,
};

vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/api/resident/autopay")) {
    return new Response(JSON.stringify(AUTOPAY_RESPONSE), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes("/api/stripe/resident-payment-methods")) {
    return new Response(JSON.stringify({ methods: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
});

import { ResidentPaymentMethodsSettingsCard } from "@/components/portal/resident-payment-methods-settings-card";

afterEach(() => {
  cleanup();
  replaced.length = 0;
  pushed.length = 0;
});

describe("ResidentPaymentMethodsSettingsCard", () => {
  it("renders a 'Payment methods' settings row with a Manage button", async () => {
    render(<ResidentPaymentMethodsSettingsCard />);
    expect(screen.getByText("Payment methods")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage" })).toBeInTheDocument();
  });

  it("opens the payment methods modal from Manage", async () => {
    render(<ResidentPaymentMethodsSettingsCard />);
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    await screen.findByRole("dialog");
    expect(screen.getByText(/Save a bank account or card/)).toBeInTheDocument();
  });

  it("resumes exact pending bank verification when Settings is reopened", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/stripe/resident-bank-setup")) {
        return new Response(JSON.stringify({ bankStatus: "verification",
          setupIntentId: "seti_pending", clientSecret: "seti_secret" }), { status: 200 });
      }
      if (url.includes("/api/resident/autopay")) return new Response(JSON.stringify(AUTOPAY_RESPONSE), { status: 200 });
      return new Response(JSON.stringify({ methods: [] }), { status: 200 });
    }));
    render(<ResidentPaymentMethodsSettingsCard />);
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(await screen.findByTestId("resident-bank-form")).toHaveTextContent("seti_pending");
    expect(screen.queryByTestId("stripe-checkout")).not.toBeInTheDocument();
  });

  it("shows an incomplete pending-bank read as an error instead of no pending bank", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/stripe/resident-bank-setup")) {
        return new Response(JSON.stringify({ error: "Bank setup history needs review." }), { status: 409 });
      }
      if (String(input).includes("/api/resident/autopay")) return new Response(JSON.stringify(AUTOPAY_RESPONSE), { status: 200 });
      return new Response(JSON.stringify({ methods: [] }), { status: 200 });
    }));
    render(<ResidentPaymentMethodsSettingsCard />);
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Bank setup history needs review.");
    expect(screen.queryByTestId("resident-bank-form")).not.toBeInTheDocument();
  });

  it("renders the autopay card alongside it", async () => {
    render(<ResidentPaymentMethodsSettingsCard />);
    await waitFor(() => expect(screen.getByTestId("resident-autopay-card")).toBeInTheDocument());
  });

  it("routes a declined-autopay 'Pay now' through the C248 ?pay= shortcut", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ...AUTOPAY_RESPONSE,
          enabled: true,
          paymentMethodId: "pm_bank_1",
          failedRun: { chargeId: "hc_1", chargeTitle: "October rent", failureReason: "Bank declined." },
        }),
      }),
    );
    render(<ResidentPaymentMethodsSettingsCard basePath="/resident" />);
    const payNow = await waitFor(() => {
      const el = document.querySelector('[data-attr="resident-autopay-pay-now"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    await act(async () => {
      fireEvent.click(payNow);
    });
    expect(pushed).toContain("/resident/payments?pay=hc_1");
  });
});
