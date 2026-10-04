// @vitest-environment jsdom
//
// "Promo codes" on an Application or Lease card opens the EXISTING waive-code list in a dialog, scoped to the fee
// that form owns. There is no second code system: the list and the create call are the Settings section's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApplicationFeeWaiverCode } from "@/lib/application-fee-waiver";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: toast }),
  useConfirm: () => async () => true,
}));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));

import { FormPromoCodesAction } from "@/components/portal/form-promo-codes";

function code(over: Partial<ApplicationFeeWaiverCode>): ApplicationFeeWaiverCode {
  return {
    id: "c1", managerUserId: "m1", code: "APPONLY", label: null, propertyId: null, propertyIds: [], appliesTo: "application",
    status: "active", maxUses: null, usedCount: 0, expiresAt: null, createdAt: "2026-10-01T00:00:00.000Z", revokedAt: null, ...over,
  };
}

const fetchMock = vi.fn();
beforeEach(() => {
  toast.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (!init?.method) {
      return {
        ok: true,
        json: async () => ({
          codes: [code({}), code({ id: "c2", code: "LEASEONLY", appliesTo: "lease" }), code({ id: "c3", code: "BOTH", appliesTo: "both" })],
          redemptions: [],
        }),
      };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Promo codes on a form card", () => {
  it("an Application card's Promo codes opens the waive-code list showing the codes that waive the application fee", async () => {
    render(<FormPromoCodesAction kind="application" propertyId="prop-1" propertyLabel="Cascade Lofts" dataAttr="app-promo" />);
    fireEvent.click(screen.getByRole("button", { name: "Promo codes" }));
    expect(await screen.findByText("APPONLY")).toBeTruthy();
    expect(screen.getByText("BOTH")).toBeTruthy();
    expect(screen.queryByText("LEASEONLY")).toBeNull();
  });

  it("a Lease card's Promo codes shows the codes that waive the lease fee", async () => {
    render(<FormPromoCodesAction kind="lease" propertyId="prop-1" propertyLabel="Cascade Lofts" dataAttr="lease-promo" />);
    fireEvent.click(screen.getByRole("button", { name: "Promo codes" }));
    expect(await screen.findByText("LEASEONLY")).toBeTruthy();
    expect(screen.getByText("BOTH")).toBeTruthy();
    expect(screen.queryByText("APPONLY")).toBeNull();
  });

  it("creates a code through the existing API, defaulting to the fee this form owns", async () => {
    render(<FormPromoCodesAction kind="lease" propertyId="prop-1" propertyLabel="Cascade Lofts" dataAttr="lease-promo" />);
    fireEvent.click(screen.getByRole("button", { name: "Promo codes" }));
    await screen.findByText("LEASEONLY");
    fireEvent.click(screen.getByRole("button", { name: "Add waive code" }));
    fireEvent.change(document.querySelector("[data-attr='waive-codes-new-code']")!, { target: { value: "WELCOME" } });
    fireEvent.click(screen.getByRole("button", { name: "Create code" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(post[0]).toBe("/api/manager/application-fee-waivers");
    expect(JSON.parse(String(post[1].body))).toMatchObject({ code: "WELCOME", appliesTo: "lease", propertyIds: [] });
  });
});
