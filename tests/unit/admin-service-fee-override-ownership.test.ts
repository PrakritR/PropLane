import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS, saveManagerManualPaymentSettings, saveAdminServiceFeeOverride } from "@/lib/manager-manual-payment-settings";

// SQL authorization/concurrency behavior is exercised against PostgreSQL in comms-credit-postgres.test.ts.
describe("staff coverage write boundary", () => {
  it("strips a forged manager override and shared code before calling the atomic manager writer", async () => {
    const rpc = vi.fn().mockResolvedValue({data: {...DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS, serviceFeePayer:"resident"},error:null});
    await saveManagerManualPaymentSettings({rpc} as never,"owner", {...DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS,adminServiceFeeOverride:"proplane",serviceFeeWaiverCode:"FREE100"},{accountWaiverGranted:true});
    expect(rpc).toHaveBeenCalledWith("save_manager_payment_preferences", {p_owner:"owner",p_settings:expect.not.objectContaining({adminServiceFeeOverride:expect.anything()}),p_coverage_granted:false});
    // A code beside a `resident` choice is noise, not a grant — it is not stored.
    expect(rpc.mock.calls[0][1].p_settings.serviceFeeWaiverCode).toBeUndefined();
  });
  it("hands the writer the server's grant answer with a promo-backed PropLane choice", async () => {
    const rpc = vi.fn().mockResolvedValue({data: {...DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS, serviceFeePayer:"proplane", serviceFeeWaiverCode:"FREE100"},error:null});
    const db = {
      rpc,
      from: () => ({ select: () => ({ limit: async () => ({ data: [], error: null }), eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    } as never;
    await saveManagerManualPaymentSettings(db,"owner", {...DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS,serviceFeePayer:"proplane",serviceFeeWaiverCode:"free100"});
    expect(rpc).toHaveBeenCalledWith("save_manager_payment_preferences", {p_owner:"owner",p_settings:expect.objectContaining({serviceFeePayer:"proplane",serviceFeeWaiverCode:"FREE100"}),p_coverage_granted:true});
    // Without a code and without a grant the same choice is written as resident, and the writer is told so.
    rpc.mockClear();
    await saveManagerManualPaymentSettings(db,"owner", {...DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS,serviceFeePayer:"proplane"});
    expect(rpc).toHaveBeenCalledWith("save_manager_payment_preferences", {p_owner:"owner",p_settings:expect.objectContaining({serviceFeePayer:"resident"}),p_coverage_granted:false});
  });
  it("routes staff revocation through the separate atomic staff writer", async () => {
    const rpc = vi.fn().mockResolvedValue({data:DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS,error:null});
    await saveAdminServiceFeeOverride({rpc} as never,"owner",null);
    expect(rpc).toHaveBeenCalledWith("set_staff_payment_fee_override",{p_owner:"owner",p_override:null});
  });
  it("does not report successful manager or staff saves when the database write fails", async () => {
    const rpc = vi.fn().mockResolvedValue({data:null,error:{message:"offline"}});
    await expect(saveManagerManualPaymentSettings({rpc} as never,"owner",DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS)).rejects.toThrow("Could not save");
    await expect(saveAdminServiceFeeOverride({rpc} as never,"owner","proplane")).rejects.toThrow("Could not save");
  });
});
