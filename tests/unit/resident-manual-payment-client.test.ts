import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { isDemoModeActive } = vi.hoisted(() => ({
  isDemoModeActive: vi.fn(() => false),
}));

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive,
}));

vi.mock("@/lib/household-charges", () => ({
  applyHouseholdChargePatches: vi.fn(),
}));

import {
  RESIDENT_MANUAL_PAYMENT_AUTO_CHECK_MS,
  checkResidentManualPayment,
} from "@/lib/resident-manual-payment-client";

describe("resident-manual-payment-client", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("fetch", vi.fn());
    isDemoModeActive.mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exports a resident auto-check interval", () => {
    expect(RESIDENT_MANUAL_PAYMENT_AUTO_CHECK_MS).toBeGreaterThanOrEqual(15_000);
  });

  it("returns paid=false with server message when payment not found", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ paid: false, message: "Not received yet." }), { status: 200 }),
    );
    const result = await checkResidentManualPayment(["chg-1"], "zelle");
    expect(result).toEqual({ ok: true, paid: false, message: "Not received yet." });
    expect(fetch).toHaveBeenCalledWith(
      "/api/portal/resident-check-manual-payment",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ chargeIds: ["chg-1"], channel: "zelle" }),
      }),
    );
  });

  it("returns paid=true when server confirms payment", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ paid: true, charges: [{ id: "chg-1", status: "paid" }] }), { status: 200 }),
    );
    const result = await checkResidentManualPayment(["chg-1"], "venmo");
    expect(result.ok).toBe(true);
    if (result.ok && result.paid) {
      expect(result.charges).toHaveLength(1);
    }
  });
});
