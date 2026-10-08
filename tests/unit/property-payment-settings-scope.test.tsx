// @vitest-environment jsdom
//
// The Pricing gear's pop-up is gone. Both things it carried live on the
// property record's own Pricing tab: which scope a payment row is in
// ("Workspace default" vs "This property"), and the way back out of a
// property's own answer.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/properties/listed/p1/pricing",
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/lib/workspaces/selection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspaces/selection")>();
  return { ...actual, activeWorkspaceIdentity: () => ({ id: "ws-1", name: "Axis" }) };
});
vi.mock("@/lib/manager-property-save-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-property-save-target")>();
  return { ...actual, persistManagerListingSubmissionOnServer: vi.fn(async () => true) };
});
vi.mock("@/lib/portal-mobile-top-chrome", () => ({
  getPortalScrollRoot: () => null,
  syncPortalDetailDestinationOffset: () => 0,
  syncPortalMobileTopChrome: () => 0,
}));

import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { persistManagerListingSubmissionOnServer } from "@/lib/manager-property-save-target";
import {
  markPaymentFieldOwn,
  paymentSettingsFieldScope,
  pickPaymentSettings,
  resetPaymentFieldToWorkspace,
} from "@/lib/property-payment-settings-scope";
import { PropertyPricingPanel } from "@/components/portal/property-pricing-panel";

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  vi.mocked(persistManagerListingSubmissionOnServer).mockClear();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ workspacePaymentSettings: { "ws-1": { serviceFeePayer: "manager" } } }),
    })),
  );
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  vi.unstubAllGlobals();
});

describe("payment settings scope", () => {
  it("reads as the workspace default until the property answers for itself", () => {
    const sub = createDefaultListingSubmission();
    expect(paymentSettingsFieldScope(sub, "rentDueDayMode")).toBe("workspace");
    expect(paymentSettingsFieldScope(sub, "lateFeeGraceDays")).toBe("workspace");
    expect(paymentSettingsFieldScope(sub, "serviceFeeWaiverCode")).toBe("workspace");
    expect(paymentSettingsFieldScope(sub, "serviceFeePayer", { serviceFeePayer: "manager" })).toBe("own");
  });

  it("resets a field the property took over back to the workspace default", () => {
    const base = createDefaultListingSubmission();
    const edited = markPaymentFieldOwn({ ...base, lateFeeGraceDays: 12 }, "lateFeeGraceDays");
    expect(paymentSettingsFieldScope(edited, "lateFeeGraceDays")).toBe("own");

    const reset = resetPaymentFieldToWorkspace(edited, "lateFeeGraceDays", null);
    expect(reset.lateFeeGraceDays).toBe(5);
    expect(reset.paymentSettingsScope?.lateFeeGraceDays).toBeUndefined();
    expect(paymentSettingsFieldScope(reset, "lateFeeGraceDays")).toBe("workspace");
  });

  it("puts the processing fee payer back on the workspace's answer", () => {
    const ws = { serviceFeePayer: "manager" as const };
    const edited = markPaymentFieldOwn({ ...createDefaultListingSubmission(), serviceFeePayer: "proplane" }, "serviceFeePayer");
    const reset = resetPaymentFieldToWorkspace(edited, "serviceFeePayer", ws);
    expect(reset.serviceFeePayer).toBe("manager");
    expect(paymentSettingsFieldScope(reset, "serviceFeePayer", ws)).toBe("workspace");
  });

  it("clears a coverage code the property typed", () => {
    const edited = markPaymentFieldOwn(
      { ...createDefaultListingSubmission(), serviceFeeWaiverCode: "FREE100" },
      "serviceFeeWaiverCode",
    );
    expect(paymentSettingsFieldScope(edited, "serviceFeeWaiverCode")).toBe("own");
    const reset = resetPaymentFieldToWorkspace(edited, "serviceFeeWaiverCode", null);
    expect(reset.serviceFeeWaiverCode).toBeUndefined();
    expect(paymentSettingsFieldScope(reset, "serviceFeeWaiverCode")).toBe("workspace");
  });

  it("carries only the payment answers, so a save never writes back stale rooms", () => {
    const sub = markPaymentFieldOwn({ ...createDefaultListingSubmission(), lateFeeAmount: "75" }, "lateFeeAmount");
    const patch = pickPaymentSettings(sub);
    expect(patch.lateFeeAmount).toBe("75");
    expect(patch.paymentSettingsScope?.lateFeeAmount).toBe("own");
    expect("rooms" in patch).toBe(false);
  });
});

describe("the property Pricing tab's Rent & fees card", () => {
  const seeded = (over: Partial<ManagerListingSubmissionV1> = {}): ManagerListingSubmissionV1 => ({
    ...createDefaultListingSubmission(),
    rooms: [{ ...createDefaultListingSubmission().rooms[0]!, id: "r1", name: "Room 1", monthlyRent: 900 }],
    ...over,
  });

  function renderPanel(submission = seeded()) {
    return render(
      <PropertyPricingPanel
        submission={submission}
        saveTarget={{ mode: "listing", saveId: "p1" } as never}
        managerUserId="mgr-1"
        propertyLabel="Magnolia House"
        onUpdated={() => {}}
        showToast={() => {}}
      />,
    );
  }

  const scopeOf = (field: string) =>
    document.querySelector(`[data-attr="property-payment-scope-${field}"]`)?.textContent;
  const resetOf = (field: string) =>
    document.querySelector<HTMLElement>(`[data-attr="property-payment-reset-${field}"]`);

  it("renders the card on the tab managers actually open", () => {
    renderPanel();
    expect(document.querySelector('[data-attr="property-payment-settings"]')).not.toBeNull();
    expect(screen.getByText("Rent & fees")).toBeTruthy();
    expect(screen.getByText("Rent due")).toBeTruthy();
    expect(screen.getByText("Late fee amount")).toBeTruthy();
    expect(screen.getByText("Grace days")).toBeTruthy();
    expect(screen.getByText("Processing fee paid by")).toBeTruthy();
  });

  it("marks an edited row as this property's and resets it back to the workspace default", async () => {
    renderPanel();
    expect(scopeOf("lateFeeEnabled")).toBe("Workspace default");
    expect(resetOf("lateFeeEnabled")).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Automatic late fees" }));
    await waitFor(() => expect(persistManagerListingSubmissionOnServer).toHaveBeenCalled());
    expect(scopeOf("lateFeeEnabled")).toBe("This property");

    const reset = resetOf("lateFeeEnabled");
    expect(reset).not.toBeNull();
    fireEvent.click(reset!);
    await waitFor(() => expect(scopeOf("lateFeeEnabled")).toBe("Workspace default"));
    expect(screen.getByRole("switch", { name: "Automatic late fees" }).getAttribute("aria-checked")).toBe("true");
  });

  it("names the scope and resets the processing fee against the workspace's real answer", async () => {
    renderPanel();
    await waitFor(() => expect(scopeOf("serviceFeePayer")).toBe("This property"));

    fireEvent.click(resetOf("serviceFeePayer")!);
    await waitFor(() => expect(persistManagerListingSubmissionOnServer).toHaveBeenCalled());
    const saved = vi.mocked(persistManagerListingSubmissionOnServer).mock.calls.at(-1)?.[2] as
      | ManagerListingSubmissionV1
      | undefined;
    expect(saved?.serviceFeePayer).toBe("manager");
    expect(scopeOf("serviceFeePayer")).toBe("Workspace default");
  });
});
