import { describe, expect, it } from "vitest";
import { ensureSandboxManagerLandlordProfile } from "@/lib/manager-landlord-profile";

function mockAutomationDb(initialRowData: Record<string, unknown> | null = null) {
  let rowData = initialRowData;
  const db = {
    from(table: string) {
      if (table !== "manager_automation_settings") {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          return { data: rowData ? { row_data: rowData } : null, error: null };
        },
        async upsert(payload: { manager_user_id: string; row_data: Record<string, unknown> }) {
          rowData = payload.row_data;
          return { error: null };
        },
      };
    },
  };
  return {
    db: db as never,
    readRowData: () => rowData,
  };
}

describe("ensureSandboxManagerLandlordProfile", () => {
  it("seeds landlord legal name from signup full name for sandbox managers", async () => {
    const { db, readRowData } = mockAutomationDb(null);
    await ensureSandboxManagerLandlordProfile(db, {
      managerUserId: "mgr-user",
      email: "fresh@test.proplane.local",
      fullName: "Test Manager",
    });
    expect(readRowData()?.landlordProfile).toEqual({ landlordLegalName: "Test Manager" });
  });

  it("skips non-sandbox emails", async () => {
    const { db, readRowData } = mockAutomationDb(null);
    await ensureSandboxManagerLandlordProfile(db, {
      managerUserId: "mgr-user",
      email: "owner@example.com",
      fullName: "Jane Owner",
    });
    expect(readRowData()).toBeNull();
  });

  it("does not overwrite an existing landlord legal name", async () => {
    const { db, readRowData } = mockAutomationDb({
      landlordProfile: { landlordLegalName: "Existing LLC" },
    });
    await ensureSandboxManagerLandlordProfile(db, {
      managerUserId: "mgr-user",
      email: "manager@test.proplane.local",
      fullName: "Test Manager",
    });
    expect(readRowData()?.landlordProfile).toEqual({ landlordLegalName: "Existing LLC" });
  });
});
