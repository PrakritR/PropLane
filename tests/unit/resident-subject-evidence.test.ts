import { describe, expect, it } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { residentSubjectHasHouse, residentSubjectManagerIds } from "@/lib/auth/resident-subject-evidence.server";

function db(userId: string, authEmail = "r@example.test", confirmed = true) {
  const service = createMemoryDb({
    manager_application_records: [{ manager_user_id: "manager", resident_email: "r@example.test", property_id: "home", row_data: { residentUserId: "old-user", bucket: "approved" } }],
    portal_household_charge_records: [], portal_lease_pipeline_records: [],
  });
  return Object.assign(service, { auth: { admin: { getUserById: async () => ({ data: { user: { id: userId, email: authEmail, email_confirmed_at: confirmed ? "confirmed" : null } }, error: null }) } } });
}
describe("resident subject evidence", () => {
  it("recognizes an exact subject-bound application", async () => {
    const service = db("old-user");
    expect(await residentSubjectManagerIds(service as never, "old-user", "r@example.test")).toEqual(["manager"]);
    expect(await residentSubjectHasHouse(service as never, "old-user", "r@example.test", "manager", "home")).toBe(true);
  });
  it("does not inherit a same-email former subject's manager or house", async () => {
    const service = db("new-user");
    expect(await residentSubjectManagerIds(service as never, "new-user", "r@example.test")).toEqual([]);
    expect(await residentSubjectHasHouse(service as never, "new-user", "r@example.test", "manager", "home")).toBe(false);
  });
  it.each([["other@example.test", true], ["r@example.test", false]])("requires the confirmed Auth mailbox", async (authEmail, confirmed) => {
    expect(await residentSubjectHasHouse(db("old-user", authEmail, confirmed) as never, "old-user", "r@example.test", "manager", "home")).toBe(false);
  });
});
