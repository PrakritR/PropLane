/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
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

  it("shows the account prompt for anonymous guests on tour and message", () => {
    const autofill = makeAutofill();
    const tour = renderHook(() => useProspectActionGate("tour", "mgr-5259", false, autofill));
    const message = renderHook(() => useProspectActionGate("message", "mgr-5259", false, autofill));

    expect(tour.result.current.gateView).toBe("account-prompt");
    expect(message.result.current.gateView).toBe("account-prompt");
    expect(tour.result.current.gateKey).toBe("tour:mgr-5259");
    expect(message.result.current.gateKey).toBe("message:mgr-5259");
  });

  it("opens the action after continue-as-guest is chosen", async () => {
    const autofill = makeAutofill();
    const { result } = renderHook(() => useProspectActionGate("tour", "mgr-5259", false, autofill));
    expect(result.current.gateView).toBe("account-prompt");

    result.current.continueAsGuest();

    await waitFor(() => {
      expect(result.current.gateView).toBe("action");
    });
  });

  it("routes residents into the portal surface", () => {
    const autofill = makeAutofill({ userId: "resident-1", hasResidentRole: true });

    const { result } = renderHook(() => useProspectActionGate("tour", "mgr-5259", false, autofill));
    expect(result.current.gateView).toBe("resident-portal");
  });

  it("resets guest bypass when the gate key changes", async () => {
    const autofill = makeAutofill();
    const { result, rerender } = renderHook(
      ({ propertyId }) => useProspectActionGate("tour", propertyId, false, autofill),
      { initialProps: { propertyId: "mgr-5259" } },
    );

    result.current.continueAsGuest();
    await waitFor(() => {
      expect(result.current.gateView).toBe("action");
    });

    rerender({ propertyId: "mgr-5260" });
    await waitFor(() => {
      expect(result.current.gateView).toBe("account-prompt");
    });
  });
});
