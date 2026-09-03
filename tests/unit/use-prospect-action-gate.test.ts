/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useProspectActionGate } from "@/hooks/use-prospect-action-gate";

const autofillState = {
  ready: true,
  userId: null as string | null,
  hasResidentRole: false,
};

vi.mock("@/hooks/use-prospect-contact-autofill", () => ({
  useProspectContactAutofill: () => autofillState,
}));

describe("useProspectActionGate", () => {
  afterEach(() => {
    sessionStorage.clear();
    autofillState.ready = true;
    autofillState.userId = null;
    autofillState.hasResidentRole = false;
  });

  it("shows the account prompt for anonymous guests on tour and message", () => {
    const tour = renderHook(() => useProspectActionGate("tour", "mgr-5259", false));
    const message = renderHook(() => useProspectActionGate("message", "mgr-5259", false));

    expect(tour.result.current.gateView).toBe("account-prompt");
    expect(message.result.current.gateView).toBe("account-prompt");
    expect(tour.result.current.gateKey).toBe("tour:mgr-5259");
    expect(message.result.current.gateKey).toBe("message:mgr-5259");
  });

  it("opens the action after continue-as-guest is chosen", async () => {
    const { result } = renderHook(() => useProspectActionGate("tour", "mgr-5259", false));
    expect(result.current.gateView).toBe("account-prompt");

    result.current.continueAsGuest();

    await waitFor(() => {
      expect(result.current.gateView).toBe("action");
    });
  });

  it("routes residents into the portal surface", () => {
    autofillState.hasResidentRole = true;
    autofillState.userId = "resident-1";

    const { result } = renderHook(() => useProspectActionGate("tour", "mgr-5259", false));
    expect(result.current.gateView).toBe("resident-portal");
  });
});
