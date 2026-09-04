import { describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { linkResidentOnApplicationSubmit } from "@/lib/auth/link-resident-on-application-submit";

function makeDbMock(options: {
  propertyRecord?: { manager_user_id?: string | null; status?: string | null; property_data?: unknown } | null;
  /** Prior applications for the duplicate guard; empty unless a test needs one. */
  applicationRecords?: { id: string; row_data: unknown }[];
  profile?: { manager_id?: string | null } | null;
}) {
  const profileUpdateEq = vi.fn().mockResolvedValue({ error: null });
  const profileUpdate = vi.fn().mockReturnValue({ eq: profileUpdateEq });
  const db = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "manager_property_records") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: options.propertyRecord ?? null, error: null }),
            }),
          }),
        };
      }
      if (table === "manager_application_records") {
        // The server-side duplicate guard (PRP-204) reads this table.
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: options.applicationRecords ?? [], error: null }),
            }),
          }),
        };
      }
      if (table === "profiles") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: options.profile ?? null, error: null }),
            }),
          }),
          update: profileUpdate,
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
    }),
    profileUpdate,
    profileUpdateEq,
  };
  return db;
}

describe("linkResidentOnApplicationSubmit", () => {
  it("resolves manager_user_id from property record and links profile on new submit", async () => {
    const db = makeDbMock({
      propertyRecord: { manager_user_id: "manager-1", status: "live" },
      profile: { manager_id: null },
    });
    const row: DemoApplicantRow = {
      id: "AXIS-ABC123",
      name: "Resident",
      property: "Test House",
      propertyId: "prop-1",
      stage: "Submitted",
      bucket: "pending",
      detail: "",
      email: "resident@example.com",
      application: { propertyId: "prop-1" } as DemoApplicantRow["application"],
    };

    const result = await linkResidentOnApplicationSubmit(db as never, {
      userId: "user-1",
      row,
      isNewSubmit: true,
    });

    expect(result.ok).toBe(true);
    const linked = result.ok ? result.row : null;
    expect(linked?.id).toBe("AXIS-ABC123");
    expect(linked?.managerUserId).toBe("manager-1");
    expect(linked?.propertyId).toBe("prop-1");
    expect(linked?.residentUserId).toBe("user-1");
    expect(linked?.axisId).toBe("AXIS-ABC123");
    expect(db.profileUpdate).toHaveBeenCalledWith({ manager_id: "AXIS-ABC123" });
    expect(db.profileUpdateEq).toHaveBeenCalledWith("id", "user-1");
  });

  it("keeps existing profile manager_id on edits", async () => {
    const db = makeDbMock({
      propertyRecord: { manager_user_id: "manager-1", status: "live" },
      profile: { manager_id: "AXIS-EXISTING" },
    });
    const row: DemoApplicantRow = {
      id: "AXIS-ABC123",
      name: "Resident",
      property: "Test House",
      propertyId: "prop-1",
      managerUserId: "manager-1",
      stage: "Submitted",
      bucket: "pending",
      detail: "",
      email: "resident@example.com",
    };

    await linkResidentOnApplicationSubmit(db as never, {
      userId: "user-1",
      row,
      isNewSubmit: false,
      existingManagerUserId: "manager-1",
    });

    expect(db.profileUpdate).not.toHaveBeenCalled();
  });

  it("rejects a new submit whose property resolves to no manager, ignoring a forged managerUserId", async () => {
    const db = makeDbMock({ propertyRecord: null, profile: { manager_id: null } });
    const row: DemoApplicantRow = {
      id: "AXIS-ABC123",
      name: "Resident",
      property: "Test House",
      propertyId: "prop-unknown",
      managerUserId: "victim-manager",
      stage: "Submitted",
      bucket: "pending",
      detail: "",
      email: "resident@example.com",
    };

    const result = await linkResidentOnApplicationSubmit(db as never, {
      userId: "user-1",
      row,
      isNewSubmit: true,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.status).toBe(400);
    expect(db.profileUpdate).not.toHaveBeenCalled();
  });

  it("does not trust a forged managerUserId on an edit, keeping the stored attribution", async () => {
    const db = makeDbMock({ propertyRecord: null, profile: { manager_id: "AXIS-EXISTING" } });
    const row: DemoApplicantRow = {
      id: "AXIS-ABC123",
      name: "Resident",
      property: "Test House",
      propertyId: "prop-unknown",
      managerUserId: "victim-manager",
      stage: "Submitted",
      bucket: "pending",
      detail: "",
      email: "resident@example.com",
    };

    const result = await linkResidentOnApplicationSubmit(db as never, {
      userId: "user-1",
      row,
      isNewSubmit: false,
      existingManagerUserId: "manager-1",
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.row.managerUserId : null).toBe("manager-1");
  });

  it("skips profile.manager_id when linkProfile is false", async () => {
    const db = makeDbMock({ propertyRecord: { manager_user_id: "manager-1", status: "live" }, profile: { manager_id: null } });
    const row: DemoApplicantRow = {
      id: "AXIS-ABC123",
      name: "Manager applicant",
      property: "Test House",
      propertyId: "prop-1",
      stage: "Submitted",
      bucket: "pending",
      detail: "",
      email: "manager@example.com",
    };

    const result = await linkResidentOnApplicationSubmit(db as never, {
      userId: "mgr-user",
      row,
      isNewSubmit: true,
      linkProfile: false,
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.row.residentUserId : null).toBe("mgr-user");
    expect(db.profileUpdate).not.toHaveBeenCalled();
  });
});
