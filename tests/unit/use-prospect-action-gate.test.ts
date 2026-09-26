/**
 * @vitest-environment jsdom
 *
 * A resident account is required for every prospect action (PLAN-0924-1421), so
 * the only way past this gate is holding the resident role.
 */
import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useProspectActionGate } from "@/hooks/use-prospect-action-gate";
import type { ProspectContactAutofill } from "@/hooks/use-prospect-contact-autofill";

function makeAutofill(overrides: Partial<ProspectContactAutofill> = {}): ProspectContactAutofill {
  return {
    ready: true,
    userId: null,
    name: "",
    email: "",
    phone: "",
    hasResidentRole: false,
    ...overrides,
  };
}

describe("useProspectActionGate", () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it("shows the account prompt for anonymous visitors on tour and message", () => {
    const autofill = makeAutofill();
    const tour = renderHook(() => useProspectActionGate("tour", "mgr-5259", false, autofill));
    const message = renderHook(() => useProspectActionGate("message", "mgr-5259", false, autofill));

    expect(tour.result.current.gateView).toBe("account-prompt");
    expect(message.result.current.gateView).toBe("account-prompt");
    expect(tour.result.current.gateKey).toBe("tour:mgr-5259");
    expect(message.result.current.gateKey).toBe("message:mgr-5259");
  });

  it("stays gated even when a stale guest-continue session key exists", () => {
    sessionStorage.setItem("proplane_prospect_guest:tour:mgr-5259", "1");
    const { result } = renderHook(() =>
      useProspectActionGate("tour", "mgr-5259", false, makeAutofill()),
    );
    expect(result.current.gateView).toBe("account-prompt");
  });

  it("sends a signed-in non-resident to add a resident account", () => {
    const { result } = renderHook(() =>
      useProspectActionGate("tour", "mgr-5259", true, makeAutofill({ userId: "mgr-1" })),
    );
    expect(result.current.gateView).toBe("signed-in-create-resident");
  });

  it("routes residents into the portal surface", () => {
    const autofill = makeAutofill({ userId: "resident-1", hasResidentRole: true });

    const { result } = renderHook(() => useProspectActionGate("tour", "mgr-5259", false, autofill));
    expect(result.current.gateView).toBe("resident-portal");
  });

  it("keeps the gate up when the property changes", () => {
    const autofill = makeAutofill();
    const { result, rerender } = renderHook(
      ({ propertyId }) => useProspectActionGate("tour", propertyId, false, autofill),
      { initialProps: { propertyId: "mgr-5259" } },
    );
    expect(result.current.gateView).toBe("account-prompt");

    rerender({ propertyId: "mgr-5260" });
    expect(result.current.gateView).toBe("account-prompt");
    expect(result.current.gateKey).toBe("tour:mgr-5260");
  });
});
