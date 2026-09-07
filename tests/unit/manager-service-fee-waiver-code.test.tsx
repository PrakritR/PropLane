// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

/**
 * "PropLane covers it" is PropLane paying Stripe's processing cost out of its own
 * balance, so it is unlocked by the promo code — never by a click alone. The gate has
 * to hold in two places: the dialog must not save the choice before the code checks
 * out, and the save itself must not accept a new `proplane` without one.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  resolveSavedServiceFeeSelection,
  saveManagerManualPaymentSettings,
} from "@/lib/manager-manual-payment-settings";
import { LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID } from "@/lib/payment-policy";

describe("resolveSavedServiceFeeSelection", () => {
  it("keeps PropLane absorb when the promo code is valid", () => {
    expect(
      resolveSavedServiceFeeSelection({ serviceFeePayer: "proplane", serviceFeeWaiverCode: "free100" }, null),
    ).toEqual({ serviceFeePayer: "proplane", serviceFeeWaiverCode: "FREE100" });
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

  it("does not move fees back onto residents on an unrelated re-save", () => {
    // A legacy account already absorbing fees has no stored code. Toggling something
    // else in the dialog must not silently start charging that manager's residents.
    expect(resolveSavedServiceFeeSelection({ serviceFeePayer: "proplane" }, { serviceFeePayer: "proplane" })).toEqual({
      serviceFeePayer: "proplane",
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
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast }) }));
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

function click(dataAttr: string) {
  const el = document.querySelector<HTMLElement>(`[data-attr="${dataAttr}"]`);
  expect(el, dataAttr).toBeTruthy();
  return act(async () => {
    el!.click();
  });
}

describe("payment setup: PropLane covers it", () => {
  /*
    The dialog only OFFERS "PropLane covers it" once the account's waiver grant is
    server-verified, so the code entry is the door for a manager who was given a
    code but has no grant yet. It never prints the code back — only asks for one.
  */
  async function openWaiverEntry() {
    await mountModal();
    expect(document.querySelector('[data-attr="manager-service-fee-payer-proplane"]')).toBeNull();
    await click("manager-service-fee-waiver-open");
  }

  function typeCode(value: string) {
    const input = document.querySelector<HTMLInputElement>('[data-attr="manager-service-fee-waiver-code"]')!;
    return act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("asks for a code rather than offering the choice outright", async () => {
    await openWaiverEntry();

    expect(document.querySelector('[data-attr="manager-service-fee-waiver-code"]')).toBeTruthy();
    expect(patches).toHaveLength(0);
  });

  it("refuses a wrong code and saves nothing", async () => {
    await openWaiverEntry();
    await typeCode("NOPE");
    await click("manager-service-fee-waiver-apply");

    expect(patches).toHaveLength(0);
    expect(screen.getByText(LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID)).toBeTruthy();
  });

  it("saves the choice with the code once it checks out", async () => {
    await openWaiverEntry();
    await typeCode("free100");
    await click("manager-service-fee-waiver-apply");

    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ serviceFeePayer: "proplane", serviceFeeWaiverCode: "FREE100" });
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
