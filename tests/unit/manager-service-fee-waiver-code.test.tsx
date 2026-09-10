// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

/**
 * "PropLane covers it" is PropLane paying Stripe's processing cost out of its own
 * balance, so it is unlocked by the promo code — never by a click alone. The gate has
 * to hold in two places: the dialog must not save the choice before the code checks
 * out, and the save itself must not accept a new `proplane` without one.
 */


import {
  resolveSavedServiceFeeSelection,
} from "@/lib/manager-manual-payment-settings";

describe("resolveSavedServiceFeeSelection", () => {
  it("does not accept a shared promo code as staff approval", () => {
    expect(
      resolveSavedServiceFeeSelection({ serviceFeePayer: "proplane", serviceFeeWaiverCode: "free100" }, null),
    ).toEqual({ serviceFeePayer: "resident" });
  });

  it("falls back to resident pays when a NEW selection carries no valid code", () => {
    expect(resolveSavedServiceFeeSelection({ serviceFeePayer: "proplane" }, null)).toEqual({
      serviceFeePayer: "resident",
    });
    expect(
      resolveSavedServiceFeeSelection({ serviceFeePayer: "proplane", serviceFeeWaiverCode: "NOPE" }, {
        serviceFeePayer: "resident",
      }),
    ).toEqual({ serviceFeePayer: "resident" });
  });

  it("does not treat legacy PropLane selection as staff approval", () => {
    // A legacy account already absorbing fees has no stored code. Toggling something
    // else in the dialog must not silently start charging that manager's residents.
    expect(resolveSavedServiceFeeSelection({ serviceFeePayer: "proplane" }, { serviceFeePayer: "proplane" })).toEqual({
      serviceFeePayer: "resident",
    });
  });

  it("leaves the other two choices alone", () => {
    expect(resolveSavedServiceFeeSelection({ serviceFeePayer: "manager" }, null)).toEqual({
      serviceFeePayer: "manager",
    });
    expect(resolveSavedServiceFeeSelection({ serviceFeePayer: "resident" }, null)).toEqual({
      serviceFeePayer: "resident",
    });
  });
});

const showToast = vi.fn();
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),
 useAppUi: () => ({ showToast }) }));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/lib/manager-subscription-client", () => ({
  loadManagerPaymentWaiverGrantedClient: vi.fn(async () => false),
}));
vi.mock("@/lib/stripe-connect-onboarding-client", () => ({
  openStripeConnectOnboarding: vi.fn(async () => undefined),
}));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ open, children, footer }: { open: boolean; children: ReactNode; footer?: ReactNode }) =>
    open ? (
      <div role="dialog">
        {children}
        {footer}
      </div>
    ) : null,
  ModalFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { ManagerPaymentSetupModal } from "@/components/portal/pro-payment-setup-modal";

let patches: Record<string, unknown>[] = [];
let settingsReadFails = false;

function respond(url: string, init?: RequestInit) {
  if (url.startsWith("/api/stripe/connect/status")) {
    return { ok: true, status: 200, json: async () => ({ connected: true, paymentReady: true, payoutsEnabled: true }) };
  }
  if (url.startsWith("/api/manager/subscription")) {
    return { ok: true, status: 200, json: async () => ({ tier: "pro" }) };
  }
  if (url.startsWith("/api/portal/manager-manual-payment-settings")) {
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      patches.push(body);
      return { ok: true, status: 200, json: async () => ({ settings: { ...body } }) };
    }
    if (settingsReadFails) {
      return { ok: false, status: 500, json: async () => ({ error: "Could not load payment setup." }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ settings: { axisPaymentsEnabled: true, serviceFeePayer: "resident" } }),
    };
  }
  return { ok: true, status: 200, json: async () => ({}) };
}

beforeEach(() => {
  vi.clearAllMocks();
  patches = [];
  settingsReadFails = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init)),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mountModal() {
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

describe("payment setup: staff-only processing coverage", () => {
  it("offers no shared waiver code or PropLane choice to an unapproved manager", async () => {
    await mountModal();
    expect(document.querySelector('[data-attr="manager-service-fee-waiver-open"]')).toBeNull();
    expect(document.querySelector('[data-attr="manager-service-fee-waiver-code"]')).toBeNull();
    expect(document.querySelector('[data-attr="manager-service-fee-payer-proplane"]')).toBeNull();
    expect(document.body.textContent).not.toContain("FREE100");
    expect(patches).toHaveLength(0);
  });
});

describe("payment setup: settings that could not be read", () => {
  /**
   * A failed GET leaves the draft at the defaults, whose `serviceFeePayer` is
   * "resident" — and every save sends the whole draft. Writing that back would move
   * Stripe's cost onto an account that was absorbing it, and the server cannot refuse
   * it, because switching to "resident" is a legitimate choice.
   */
  it("writes nothing when the stored settings could not be read", async () => {
    settingsReadFails = true;
    await mountModal();

    const feeSelect = document.querySelector<HTMLButtonElement | HTMLSelectElement>(
      '[data-attr="manager-service-fee-payer-select"]',
    );
    expect(feeSelect, "fee-payer control").toBeTruthy();
    expect((feeSelect as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      (feeSelect as HTMLButtonElement).click();
    });

    expect(patches).toHaveLength(0);
  });
});
