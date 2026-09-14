// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

/**
 * "PropLane covers it" is PropLane paying Stripe's processing cost out of its own
 * balance, so it is unlocked by the promo code — never by a click alone. The gate has
 * to hold in two places: the dialog must not save the choice before the code checks
 * out, and the save itself must not accept a new `proplane` without one.
 */


import { resolveSavedServiceFeeSelection } from "@/lib/manager-manual-payment-settings";
import {
  LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID,
  PROCESSING_FEE_PROPLANE_PENDING_LABEL,
  SERVICE_FEE_PAYER_OPTION_LABELS,
} from "@/lib/payment-policy";

describe("resolveSavedServiceFeeSelection", () => {
  it("keeps PropLane absorb when the promo code is valid", () => {
    expect(
      resolveSavedServiceFeeSelection(
        { serviceFeePayer: "proplane", serviceFeeWaiverCode: "free100" },
        null,
        false,
        // The server resolved the code; the helper no longer holds the list.
        true,
      ),
    ).toEqual({ serviceFeePayer: "proplane", serviceFeeWaiverCode: "FREE100" });
  });

  it("keeps PropLane absorb when the account already carries a grant", () => {
    expect(resolveSavedServiceFeeSelection({ serviceFeePayer: "proplane" }, null, true)).toEqual({
      serviceFeePayer: "proplane",
    });
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
  loadManagerSubscriptionTierClient: vi.fn(async () => "pro"),
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
let patchRefusal: string | null = null;

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
      if (patchRefusal) {
        return { ok: false, status: 400, json: async () => ({ error: patchRefusal }) };
      }
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
  patchRefusal = null;
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
    PropLane pays is applied only by a code at the moment it is chosen (captain,
    2026-09-14). The option is always offered; picking it saves NOTHING and opens
    the code field, and the answer already in force stays in force until the
    server accepts the code. The dialog never prints a code back — only asks.

    The modal is mounted here without a workspace provider, so the save falls
    to the account scope (`serviceFeePayer` + `serviceFeeWaiverCode`), which the
    route validates the same way. The workspace-scoped pair is covered by
    `evidence-manual-payment-settings-route-waiver`.
  */
  async function pickProplane() {
    await mountModal();
    expect(document.body.textContent).not.toContain("FREE100");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Processing fee paid by", expanded: false }));
    });
    const listbox = screen.getByRole("listbox");
    const option = within(listbox).getByText(SERVICE_FEE_PAYER_OPTION_LABELS.proplane);
    await act(async () => {
      fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
    });
  }

  function typeCode(value: string) {
    const input = document.querySelector<HTMLInputElement>('[data-attr="manager-service-fee-waiver-code"]')!;
    return act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function selectedLabel(): string {
    return screen.getByRole("button", { name: "Processing fee paid by" }).textContent ?? "";
  }

  it("offers the choice, but picking it only asks for a code and saves nothing", async () => {
    await pickProplane();

    expect(document.querySelector('[data-attr="manager-service-fee-waiver-code"]')).toBeTruthy();
    expect(screen.getByText(PROCESSING_FEE_PROPLANE_PENDING_LABEL)).toBeTruthy();
    // The helper names the answer still in force, so a pending pick never reads as saved.
    expect(document.body.textContent).toContain("Resident pays stays in effect until it is applied.");
    expect(document.body.textContent).not.toContain("FREE100");
    expect(patches).toHaveLength(0);
  });

  it("cancelling the pick puts the saved answer back", async () => {
    await pickProplane();
    expect(selectedLabel()).toContain(SERVICE_FEE_PAYER_OPTION_LABELS.proplane);

    await click("manager-service-fee-waiver-cancel");

    expect(document.querySelector('[data-attr="manager-service-fee-waiver-code"]')).toBeNull();
    expect(selectedLabel()).toContain(SERVICE_FEE_PAYER_OPTION_LABELS.resident);
    expect(patches).toHaveLength(0);
  });

  it("refuses malformed input locally and saves nothing", async () => {
    // Shape is all the browser may judge: the coverage codes are server-only,
    // because one of them was readable in a client chunk and a code is a
    // credential. Something too short to be a code never leaves the page.
    await pickProplane();
    await typeCode("NO");
    await click("manager-service-fee-waiver-apply");

    expect(patches).toHaveLength(0);
    expect(screen.getByText(LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID)).toBeTruthy();
  });

  it("sends a well-formed but wrong code for the SERVER to refuse, and stays pending", async () => {
    // The browser cannot tell `NOPE` from a real code and must not pretend to.
    // It sends it; the route checks it against the server-only list and 400s,
    // and that refusal lands under the field rather than as a toast.
    patchRefusal = LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID;
    await pickProplane();
    await typeCode("NOPE");
    await click("manager-service-fee-waiver-apply");

    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ serviceFeePayer: "proplane", serviceFeeWaiverCode: "NOPE" });
    expect(screen.getByText(LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID)).toBeTruthy();
    expect(document.querySelector('[data-attr="manager-service-fee-waiver-code"]')).toBeTruthy();
    expect(showToast).not.toHaveBeenCalledWith(LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID);
  });

  it("saves the choice with the code once it checks out", async () => {
    await pickProplane();
    await typeCode("free100");
    await click("manager-service-fee-waiver-apply");

    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ serviceFeePayer: "proplane", serviceFeeWaiverCode: "FREE100" });
    expect(document.querySelector('[data-attr="manager-service-fee-waiver-code"]')).toBeNull();
    expect(selectedLabel()).toContain(SERVICE_FEE_PAYER_OPTION_LABELS.proplane);
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
