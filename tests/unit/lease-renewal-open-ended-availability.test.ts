import { describe, expect, it } from "vitest";
import { checkMoveOutAvailabilityForLease } from "@/lib/lease-amendment.server";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A month-to-month lease has no end date (`application.leaseEnd === ""`). Renewing it — to a fixed
 * term, or to another month-to-month at a new rent — threw `RangeError: Invalid time value` while
 * computing the extension window, so the route answered 500 for the most ordinary renewal there is.
 */
const openEndedLease = {
  id: "lease_app_AXIS-M2M",
  axisId: "AXIS-M2M",
  residentEmail: "m2m@example.test",
  application: { leaseStart: "2025-01-01", leaseEnd: "", leaseTerm: "Month-to-Month" },
} as unknown as LeasePipelineRow;

const noDb = {} as SupabaseClient;

describe("checkMoveOutAvailabilityForLease on an open-ended lease", () => {
  it("renewing month-to-month into a fixed term is a shortening, never a room conflict", async () => {
    await expect(checkMoveOutAvailabilityForLease(noDb, openEndedLease, {}, "2027-11-14")).resolves.toEqual({
      ok: true,
      direction: "decrease",
    });
  });

  it("renewing month-to-month into month-to-month changes nothing about availability", async () => {
    await expect(checkMoveOutAvailabilityForLease(noDb, openEndedLease, {}, "9999-12-31")).resolves.toEqual({
      ok: true,
      direction: "same",
    });
  });
});
