import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { provisionApprovedResidentAccount } from "@/lib/auth/provision-approved-resident";

describe("approved resident mailbox proof", () => {
  it.each([undefined, { mode: "silent_migration" as const }])("does not touch auth or profile for an approved email in mode %s", async (options) => {
    const from = vi.fn(() => { throw new Error("unexpected database access"); });
    const auth = { admin: { createUser: vi.fn(), updateUserById: vi.fn(), getUserById: vi.fn() } };
    const result = await provisionApprovedResidentAccount({ from, auth } as never, { bucket: "approved", email: "victim@example.test" } as never, options);
    expect(result).toMatchObject({ ok: false, reason: "invitation_required" });
    expect(from).not.toHaveBeenCalled();
    expect(auth.admin.createUser).not.toHaveBeenCalled();
    expect(auth.admin.updateUserById).not.toHaveBeenCalled();
    expect(auth.admin.getUserById).not.toHaveBeenCalled();
  });
  it("does not backfill accounts on application reads", () => {
    const route = readFileSync("src/app/api/manager-applications/route.ts", "utf8");
    expect(route).not.toContain("scheduleApprovedResidentBackfill");
    expect(route).not.toContain("provisionApprovedResidentAccount");
    expect(route).toContain('residentAccess: "invitation_required"');
  });
  it("preflights both imports before inserting application records", () => {
    for (const file of ["src/lib/portfolio-import/create.server.ts", "src/lib/sales-migration/server.ts"]) {
      const source = readFileSync(file, "utf8");
      const start = file.includes("portfolio-import") ? source.indexOf("async function createResident(") : source.indexOf('"tenancy", { ...stay.source');
      const scope = source.slice(start);
      expect(scope.indexOf("await provisionApprovedResidentAccount")).toBeLessThan(scope.indexOf('from("manager_application_records").insert') < 0 ? scope.indexOf('from("manager_application_records").upsert') : scope.indexOf('from("manager_application_records").insert'));
    }
  });
});
