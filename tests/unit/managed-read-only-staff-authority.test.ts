import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { managedReadOnlyStaffExempt } from "@/lib/auth/managed-read-only.server";

function db(admin: boolean, owner: boolean, fail = false) {
  return { from: (table: string) => {
    const query = { select: () => query, eq: () => query, then: (resolve: (value: unknown) => unknown) => Promise.resolve({
      data: table === "profile_roles" && admin || table === "platform_service_settings" && owner ? [{}] : [],
      error: fail && table === "profile_roles" ? { message: "unavailable" } : null,
    }).then(resolve) };
    return query;
  } } as never;
}
it("exempts only stored admins and platform service owners, and fails closed on errors", async () => {
  expect(await managedReadOnlyStaffExempt(db(false, false), "primary-email-user")).toBe(false);
  expect(await managedReadOnlyStaffExempt(db(true, false), "admin")).toBe(true);
  expect(await managedReadOnlyStaffExempt(db(false, true), "service-owner")).toBe(true);
  await expect(managedReadOnlyStaffExempt(db(false, false, true), "u")).rejects.toThrow();
});
