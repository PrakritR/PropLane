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
  it("asks for the promo code instead of saving the choice", async () => {
    await mountModal();
    await click("manager-service-fee-payer-proplane");

    expect(document.querySelector('[data-attr="manager-service-fee-waiver-code"]')).toBeTruthy();
    expect(patches).toHaveLength(0);
  });

  it("refuses a wrong code and saves nothing", async () => {
    await mountModal();
    await click("manager-service-fee-payer-proplane");

    const input = document.querySelector<HTMLInputElement>('[data-attr="manager-service-fee-waiver-code"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "NOPE");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("manager-service-fee-waiver-apply");

    expect(patches).toHaveLength(0);
    expect(screen.getByText("That promo code isn't valid.")).toBeTruthy();
  });

  it("saves the choice with the code once it checks out", async () => {
    await mountModal();
    await click("manager-service-fee-payer-proplane");

    const input = document.querySelector<HTMLInputElement>('[data-attr="manager-service-fee-waiver-code"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "free100");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
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

    const allow = document.querySelector<HTMLInputElement>('[data-attr="manager-payment-stripe-allowed"]')!;
    expect(allow.disabled).toBe(true);
    await act(async () => {
      allow.click();
    });

    expect(patches).toHaveLength(0);
  });
});

function stubSettingsDb(options: { readFails?: boolean; storedPayer?: "proplane" | "resident" }) {
  const upserts: Record<string, unknown>[] = [];
  const db = {
    from: () => ({
      select: () => ({
        limit: async () => ({ error: null }),
        eq: () => ({
          maybeSingle: async () =>
            options.readFails
              ? { data: null, error: { message: "read failed" } }
              : {
                  data: { manual_payments: { serviceFeePayer: options.storedPayer ?? "resident" }, row_data: null },
                  error: null,
                },
        }),
      }),
      upsert: async (row: Record<string, unknown>) => {
        upserts.push(row);
        return { error: null };
      },
    }),
  };
  return { db: db as unknown as SupabaseClient, upserts };
}

function savedPayer(upserts: Record<string, unknown>[]) {
  const written = upserts.at(-1)?.manual_payments as { serviceFeePayer?: string } | undefined;
  return written?.serviceFeePayer;
}

describe("saveManagerManualPaymentSettings: who pays the service fee", () => {
  /**
   * Without the stored settings a legacy account already absorbing fees is
   * indistinguishable from a code-less new selection, so resolving to "resident" would
   * move Stripe's cost onto that manager's residents while the route answered 200.
   */
  it("refuses a code-less proplane save when the stored settings could not be read", async () => {
    const { db, upserts } = stubSettingsDb({ readFails: true });
    await expect(
      saveManagerManualPaymentSettings(db, "manager-1", {
        axisPaymentsEnabled: true,
        zellePaymentsEnabled: false,
        zelleContact: "",
        venmoPaymentsEnabled: false,
        venmoContact: "",
        receiptAutoMarkEnabled: true,
        serviceFeePayer: "proplane",
      }),
    ).rejects.toThrow();
    expect(upserts).toHaveLength(0);
  });

  it("still writes a proplane save that carries a valid code when the read fails", async () => {
    const { db, upserts } = stubSettingsDb({ readFails: true });
    await saveManagerManualPaymentSettings(db, "manager-1", {
      axisPaymentsEnabled: true,
      zellePaymentsEnabled: false,
      zelleContact: "",
      venmoPaymentsEnabled: false,
      venmoContact: "",
      receiptAutoMarkEnabled: true,
      serviceFeePayer: "proplane",
      serviceFeeWaiverCode: "free100",
    });
    expect(savedPayer(upserts)).toBe("proplane");
  });

  it("still lets a failed read save the other choices", async () => {
    const { db, upserts } = stubSettingsDb({ readFails: true });
    await saveManagerManualPaymentSettings(db, "manager-1", {
      axisPaymentsEnabled: true,
      zellePaymentsEnabled: false,
      zelleContact: "",
      venmoPaymentsEnabled: false,
      venmoContact: "",
      receiptAutoMarkEnabled: true,
      serviceFeePayer: "resident",
    });
    expect(savedPayer(upserts)).toBe("resident");
  });

  it("keeps downgrading a code-less NEW selection when the read succeeds", async () => {
    const { db, upserts } = stubSettingsDb({ storedPayer: "resident" });
    await saveManagerManualPaymentSettings(db, "manager-1", {
      axisPaymentsEnabled: true,
      zellePaymentsEnabled: false,
      zelleContact: "",
      venmoPaymentsEnabled: false,
      venmoContact: "",
      receiptAutoMarkEnabled: true,
      serviceFeePayer: "proplane",
    });
    expect(savedPayer(upserts)).toBe("resident");
  });

  it("carries a stored proplane forward when the read succeeds", async () => {
    const { db, upserts } = stubSettingsDb({ storedPayer: "proplane" });
    await saveManagerManualPaymentSettings(db, "manager-1", {
      axisPaymentsEnabled: true,
      zellePaymentsEnabled: false,
      zelleContact: "",
      venmoPaymentsEnabled: false,
      venmoContact: "",
      receiptAutoMarkEnabled: true,
      serviceFeePayer: "proplane",
    });
    expect(savedPayer(upserts)).toBe("proplane");
  });
});
