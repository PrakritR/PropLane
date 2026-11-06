import { describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

vi.mock("@/lib/bookings/property-stay-times.server", () => ({
  loadPropertyStayClock: async () => ({ times: { checkInTime: "15:00" }, timeZone: "America/Los_Angeles" }),
  propertyStayClockFromRecord: () => ({ times: { checkInTime: "15:00" }, timeZone: "America/Los_Angeles" }),
}));
vi.mock("@/lib/resident-portal-access", () => ({
  loadResidentLeaseSignedStatus: async () => true,
  loadResidentManagerAttestedTenancy: async () => false,
}));
import { loadTenancyCheckInContext } from "@/lib/check-in.server";
import { recordResidentCheckIn } from "@/lib/check-in-event.server";

function db() {
  return createMemoryDb({ manager_application_records: [
    { id: "old-app", manager_user_id: "manager", resident_email: "same@example.test", updated_at: "2026-01-02", row_data: { id: "old-app", residentUserId: "old-user", email: "same@example.test", bucket: "approved", stage: "Approved", propertyId: "old-house" } },
    { id: "own-app", manager_user_id: "manager", resident_email: "same@example.test", updated_at: "2026-01-01", row_data: { id: "own-app", residentUserId: "new-user", email: "same@example.test", bucket: "approved", stage: "Approved", propertyId: "own-house" } },
  ] });
}

describe("subject-bound tenancy check-in", () => {
  it("selects the current subject even when another subject has the same mailbox", async () => {
    const context = await loadTenancyCheckInContext(db() as never, "same@example.test", { residentUserId: "new-user" });
    expect(context).toMatchObject({ recordId: "own-app", propertyId: "own-house" });
  });
  it("refuses a key for the former subject despite the caller's own unlocked lease", async () => {
    const result = await recordResidentCheckIn(db() as never, { userId: "new-user", email: "same@example.test", key: { kind: "tenancy", id: "old-app" } });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });
});
