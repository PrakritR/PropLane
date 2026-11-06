import { expect, it } from "vitest";
import { resolveResidentFilingScope } from "@/lib/resident-manager-scope";

type App = { resident_email: string; manager_user_id: string; property_id: string; updated_at: string; row_data: { residentUserId?: string; bucket: string } };
function dbFor(rows: App[]) {
  let column = "", subject = "";
  const query = {
    select: () => query,
    eq: (key: string, value: string) => { column = key; subject = value; return query; },
    order: () => query,
    limit: async () => ({ data: rows.filter((row) => column === "row_data->>residentUserId" && row.row_data.residentUserId === subject), error: null }),
  };
  return { from: () => query };
}
const rows: App[] = [
  { resident_email: "same@example.test", manager_user_id: "old-manager", property_id: "old-house", updated_at: "2026-10-30", row_data: { residentUserId: "old-user", bucket: "approved" } },
  { resident_email: "same@example.test", manager_user_id: "current-manager", property_id: "current-house", updated_at: "2026-10-01", row_data: { residentUserId: "current-user", bucket: "approved" } },
  { resident_email: "same@example.test", manager_user_id: "unbound-manager", property_id: "unbound-house", updated_at: "2026-10-31", row_data: { bucket: "approved" } },
];
it("resolves only the exact Auth subject even when old and unbound applications exist", async () => {
  const result = await resolveResidentFilingScope(dbFor(rows) as never, { residentUserId: "current-user", claimedManagerUserId: "old-manager", claimedPropertyId: "old-house" });
  expect(result).toEqual({ managerUserId: "current-manager", propertyId: "current-house" });
});
it("denies another subject and does not require a mailbox for an owned application", async () => {
  expect(await resolveResidentFilingScope(dbFor(rows) as never, { residentUserId: "new-user" })).toBeNull();
  expect(await resolveResidentFilingScope(dbFor(rows) as never, { residentUserId: "current-user" })).toEqual({ managerUserId: "current-manager", propertyId: "current-house" });
  expect(await resolveResidentFilingScope(dbFor(rows) as never, { residentUserId: "" })).toBeNull();
});
