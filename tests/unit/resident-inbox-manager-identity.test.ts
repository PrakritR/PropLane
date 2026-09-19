import { describe, expect, it, vi } from "vitest";
import { enrichResidentManagerIdentities } from "@/lib/resident-inbox-manager-identity.server";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

function historical(overrides: Partial<PersistedInboxThread> = {}): PersistedInboxThread {
  return {
    id: "property_mgr_9j7pef",
    folder: "inbox",
    from: "Property manager (Ash Flats 6 · 2 rooms)",
    email: "",
    subject: "Tour request",
    preview: "Tour withdrawn",
    body: "Tour withdrawn",
    time: "Sep 18, 9:00 AM",
    unread: true,
    managerUserId: "manager-1",
    propertyId: "property-1",
    ...overrides,
  };
}

function identityDb() {
  return {
    from: vi.fn((table: string) => ({
      select: vi.fn(() => ({
        in: vi.fn(async () => table === "manager_property_records"
          ? { data: [{ id: "property-1", manager_user_id: "manager-1" }], error: null }
          : { data: [{ id: "manager-1", email: "manager@example.com", full_name: "Morgan Manager" }], error: null }),
      })),
    })),
  };
}

describe("resident inbox manager identity recovery", () => {
  it("repairs the reproduced empty-email historical row from verified property ownership", async () => {
    const db = identityDb();
    const [row] = await enrichResidentManagerIdentities(db as never, [historical()]);

    expect(db.from).toHaveBeenCalledWith("manager_property_records");
    expect(row).toMatchObject({
      id: "property_mgr_9j7pef",
      email: "manager@example.com",
      from: "Morgan Manager",
      managerUserId: "manager-1",
      propertyId: "property-1",
    });
  });

  it("leaves conflicting stored identity isolated", async () => {
    const [row] = await enrichResidentManagerIdentities(
      identityDb() as never,
      [historical({ email: "other-manager@example.com", from: "Other Manager" })],
    );

    expect(row).toMatchObject({ email: "other-manager@example.com", from: "Other Manager" });
  });
});
