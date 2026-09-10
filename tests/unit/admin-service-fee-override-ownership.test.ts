import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS, saveManagerManualPaymentSettings, saveAdminServiceFeeOverride } from "@/lib/manager-manual-payment-settings";

// SQL authorization/concurrency behavior is exercised against PostgreSQL in comms-credit-postgres.test.ts.
describe("staff coverage write boundary", () => {
  it("strips a forged manager override and shared code before calling the atomic manager writer", async () => {
    const rpc = vi.fn().mockResolvedValue({data: {...DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS, serviceFeePayer:"resident"},error:null});
    await saveManagerManualPaymentSettings({rpc} as never,"owner", {...DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS,adminServiceFeeOverride:"proplane",serviceFeeWaiverCode:"FREE100"},{accountWaiverGranted:true});
    expect(rpc).toHaveBeenCalledWith("save_manager_payment_preferences", {p_owner:"owner",p_settings:expect.not.objectContaining({adminServiceFeeOverride:expect.anything()})});
    expect(rpc.mock.calls[0][1].p_settings.serviceFeeWaiverCode).toBeUndefined();
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
