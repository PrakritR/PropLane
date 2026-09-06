import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sealApplicantRow } from "@/lib/security/applicant-identity";
import { precheckBackgroundCheckOrder } from "@/lib/checkr/background-check";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("@/lib/manager-access-server", () => ({ getManagerSubscriptionTier: vi.fn(async () => "pro") }));
vi.mock("@/lib/checkr/config", () => ({ backgroundCheckConfigured: () => true, checkrSimulate: () => true, checkrSkipsManagerCardCharge: () => true }));
beforeEach(() => {
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "test");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") }));
});
afterEach(() => vi.unstubAllEnvs());
function dbFor(owner: string) {
  const stored = sealApplicantRow({ id: "PROPLANE-SCREEN", managerUserId: "old-manager", application: { ssn: "123-45-6789", dateOfBirth: "1980-01-02", consentCredit: true } }, "PROPLANE-SCREEN", "old-manager");
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { id: "PROPLANE-SCREEN", manager_user_id: owner, row_data: stored }, error: null }) };
  return { from: () => query } as unknown as SupabaseClient;
}
it("opens screening identity only for the current owner after transfer", async () => {
  const db = dbFor("new-manager");
  const result = await precheckBackgroundCheckOrder({ db, applicationId: "PROPLANE-SCREEN", managerUserId: "new-manager" });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.row.application?.ssn).toBe("123-45-6789");
    expect(result.row.managerUserId).toBe("new-manager");
    expect(result.row).not.toHaveProperty("_applicantIdentity");
  }
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", "");
  await expect(precheckBackgroundCheckOrder({ db, applicationId: "PROPLANE-SCREEN", managerUserId: "old-manager" })).rejects.toThrow("Application access denied.");
});
