import { describe, it, expect } from "vitest";
import { listResidentsTool } from "@/lib/tools/domains/residents";
import { getApplicationDetailsTool, listApplicationsTool } from "@/lib/tools/domains/applications";
import { getPropertyDetailsTool, listPropertiesTool } from "@/lib/tools/domains/properties";
import { makeManagerRowsCtx, managerRow, type FakeRecord } from "./fake-agent-ctx";

const SENSITIVE_APP = {
  ssn: "123-45-6789",
  income: 90000,
  employer: "ACME",
};

describe("list_applications", () => {
  const ctx = makeManagerRowsCtx({
    manager_application_records: [
      managerRow("manager_a", {
        id: "a1",
        name: "Pat",
        email: "Pat@X.com",
        property: "12 Main",
        stage: "Screening",
        bucket: "pending",
        application: SENSITIVE_APP,
        backgroundCheckStatus: "flagged",
        screening: { report: "raw certn data" },
      }),
      managerRow("manager_a", { id: "a2", name: "Sam", bucket: "approved", application: SENSITIVE_APP, backgroundCheckStatus: "passed" }),
      managerRow("manager_b", { id: "a3", name: "Other", bucket: "pending" }),
    ],
  });

  it("scopes to the landlord and filters by bucket + screening status", async () => {
    const pending = (await listApplicationsTool.handler(ctx, { bucket: "pending" })) as {
      count: number;
      applications: { id: string; screeningStatus: string }[];
    };
    expect(pending.count).toBe(1);
    expect(pending.applications[0]!).toMatchObject({ id: "a1", screeningStatus: "flagged" });

    const flagged = (await listApplicationsTool.handler(ctx, { screeningStatus: "flagged" })) as {
      applications: { id: string }[];
    };
    expect(flagged.applications.map((a) => a.id)).toEqual(["a1"]);
  });

  it("never leaks the raw application form or screening report", async () => {
    const res = (await listApplicationsTool.handler(ctx, {})) as { applications: Record<string, unknown>[] };
    for (const app of res.applications) {
      expect(app).not.toHaveProperty("application");
      expect(app).not.toHaveProperty("screening");
      expect(JSON.stringify(app)).not.toContain("123-45-6789");
    }
  });
});

describe("get_application_details", () => {
  const ctx = makeManagerRowsCtx({
    manager_application_records: [
      managerRow("manager_a", {
        id: "a1",
        name: "Pat",
        email: "Pat@X.com",
        property: "12 Main",
        stage: "Screening",
        bucket: "pending",
        assignedRoomChoice: "Room 2::room-2",
        application: {
          ...SENSITIVE_APP,
          leaseStart: "2026-08-01",
          leaseEnd: "2027-07-31",
          leaseTerm: "12 months",
          roomChoice1: "Room 1::room-1",
        },
        backgroundCheckStatus: "flagged",
        screening: { report: "raw certn data" },
        backgroundCheck: { status: "complete", result: "clear", reportSnapshot: { secret: "raw checkr report" } },
      }),
      managerRow("manager_b", { id: "a3", name: "Other", bucket: "pending" }),
    ],
  });

  it("returns the safe projection with lease dates, room choice, and screening statuses", async () => {
    const res = (await getApplicationDetailsTool.handler(ctx, { applicationId: "a1" })) as {
      found: boolean;
      application: Record<string, unknown>;
    };
    expect(res.found).toBe(true);
    expect(res.application).toMatchObject({
      id: "a1",
      name: "Pat",
      email: "pat@x.com",
      desiredLeaseStart: "2026-08-01",
      desiredLeaseEnd: "2027-07-31",
      leaseTerm: "12 months",
      roomChoice: "Room 2::room-2",
      screeningStatus: "flagged",
      checkr: { status: "complete", result: "clear" },
    });
  });

  it("hard-excludes the raw form, screening bodies, and report snapshots", async () => {
    const res = (await getApplicationDetailsTool.handler(ctx, { applicationId: "a1" })) as {
      application: Record<string, unknown>;
    };
    const json = JSON.stringify(res);
    expect(res.application).not.toHaveProperty("application");
    expect(res.application).not.toHaveProperty("screening");
    expect(json).not.toContain("123-45-6789");
    expect(json).not.toContain("raw certn data");
    expect(json).not.toContain("raw checkr report");
  });

  it("does not return another landlord's application", async () => {
    const res = (await getApplicationDetailsTool.handler(ctx, { applicationId: "a3" })) as { found: boolean };
    expect(res.found).toBe(false);
  });
});

describe("list_residents", () => {
  const ctx = makeManagerRowsCtx({
    manager_application_records: [
      managerRow("manager_a", { id: "r1", name: "Pat", email: "p@x.com", property: "12 Main St", bucket: "approved", signedMonthlyRent: 1500, application: SENSITIVE_APP }),
      managerRow("manager_a", { id: "r2", name: "Pending Person", bucket: "pending", application: SENSITIVE_APP }),
      managerRow("manager_b", { id: "r3", name: "Other", bucket: "approved" }),
    ],
  });

  it("returns only approved residents for the landlord, no PII", async () => {
    const res = (await listResidentsTool.handler(ctx, {})) as { count: number; residents: Record<string, unknown>[] };
    expect(res.count).toBe(1);
    expect(res.residents[0]).toMatchObject({ id: "r1", monthlyRent: 1500 });
    expect(res.residents[0]).not.toHaveProperty("application");
    expect(JSON.stringify(res.residents)).not.toContain("123-45-6789");
  });

  it("filters by property substring", async () => {
    const res = (await listResidentsTool.handler(ctx, { property: "main" })) as { count: number };
    expect(res.count).toBe(1);
    const none = (await listResidentsTool.handler(ctx, { property: "nowhere" })) as { count: number };
    expect(none.count).toBe(0);
  });
});

describe("list_properties", () => {
  const rec = (managerUserId: string, id: string, status: string, data: Record<string, unknown>, key: "row_data" | "property_data" = "property_data"): FakeRecord =>
    ({ id, manager_user_id: managerUserId, status, row_data: key === "row_data" ? data : {}, property_data: key === "property_data" ? data : {} } as unknown as FakeRecord);

  const ctx = makeManagerRowsCtx({
    manager_property_records: [
      rec("manager_a", "p1", "live", { id: "p1", title: "Sunset Lofts", address: "1 A St", beds: 2, baths: 1, rentLabel: "$2,000/mo" }),
      rec("manager_a", "p2", "pending", { id: "p2", title: "Draft House", address: "2 B St" }, "row_data"),
      rec("manager_b", "p3", "live", { id: "p3", title: "Other" }),
    ],
  });

  it("returns only the landlord's properties and filters by status", async () => {
    const all = (await listPropertiesTool.handler(ctx, {})) as { count: number; properties: { id: string }[] };
    expect(all.count).toBe(2);
    expect(all.properties.map((p) => p.id).sort()).toEqual(["p1", "p2"]);

    const live = (await listPropertiesTool.handler(ctx, { status: "live" })) as {
      properties: { id: string; title: string; rent: string | null }[];
    };
    expect(live.properties).toHaveLength(1);
    expect(live.properties[0]!).toMatchObject({ id: "p1", title: "Sunset Lofts", rent: "$2,000/mo" });
  });
});

describe("get_property_details", () => {
  const rec = (managerUserId: string, id: string, status: string, data: Record<string, unknown>, key: "row_data" | "property_data" = "property_data"): FakeRecord =>
    ({ id, manager_user_id: managerUserId, status, row_data: key === "row_data" ? data : {}, property_data: key === "property_data" ? data : {} } as unknown as FakeRecord);

  const ctx = makeManagerRowsCtx({
    manager_property_records: [
      rec("manager_a", "p1", "live", {
        id: "p1",
        title: "Sunset Lofts",
        address: "1 A St",
        zip: "98101",
        neighborhood: "Fremont",
        beds: 2,
        baths: 1,
        rentLabel: "$2,000/mo",
        petFriendly: true,
        listingSubmission: {
          v: 1,
          acceptedPaymentMethods: ["ach"],
          zelleContact: "555-000-1111",
          venmoContact: "@secret-venmo",
          rooms: [
            {
              name: "Room 1",
              monthlyRent: 1000,
              availability: "Available now",
              moveInAvailableDate: "2026-08-01",
              photoDataUrls: ["data:image/png;base64,SECRETBLOB"],
              moveInInstructions: "lockbox code 4321",
            },
          ],
        },
      }),
      rec("manager_b", "p3", "live", { id: "p3", title: "Other" }),
    ],
  });

  it("projects safe listing details including rooms and accepted payment methods", async () => {
    const res = (await getPropertyDetailsTool.handler(ctx, { propertyId: "p1" })) as {
      found: boolean;
      property: { rooms: Record<string, unknown>[]; acceptedPaymentMethods: string[] };
    };
    expect(res.found).toBe(true);
    expect(res.property).toMatchObject({
      id: "p1",
      title: "Sunset Lofts",
      zip: "98101",
      rentLabel: "$2,000/mo",
      petFriendly: true,
      acceptedPaymentMethods: ["ach"],
    });
    expect(res.property.rooms).toEqual([
      { name: "Room 1", rent: 1000, availability: "Available now", moveInAvailableDate: "2026-08-01" },
    ]);
  });

  it("never emits photo blobs, payment contacts, or move-in access instructions", async () => {
    const res = await getPropertyDetailsTool.handler(ctx, { propertyId: "p1" });
    const json = JSON.stringify(res);
    expect(json).not.toContain("SECRETBLOB");
    expect(json).not.toContain("555-000-1111");
    expect(json).not.toContain("@secret-venmo");
    expect(json).not.toContain("lockbox code");
  });

  it("does not return another landlord's property", async () => {
    const res = (await getPropertyDetailsTool.handler(ctx, { propertyId: "p3" })) as { found: boolean };
    expect(res.found).toBe(false);
  });
});

describe("manager SMS property scope", () => {
  const rec = (
    managerUserId: string,
    id: string,
    status: string,
    data: Record<string, unknown>,
  ): FakeRecord =>
    ({
      id,
      manager_user_id: managerUserId,
      status,
      row_data: {},
      property_data: data,
    }) as unknown as FakeRecord;

  it("delegated: lists only assigned houses of the work-number owner", async () => {
    const ctx = makeManagerRowsCtx(
      {
        manager_property_records: [
          rec("owner_1", "p_assigned", "live", { id: "p_assigned", title: "Assigned" }),
          rec("owner_1", "p_other", "live", { id: "p_other", title: "Owner other" }),
          rec("co_mgr", "p_own", "live", { id: "p_own", title: "Co own" }),
        ],
      },
      {
        landlordId: "owner_1",
        userId: "co_mgr",
        managerSmsAccess: {
          mode: "delegated",
          workNumberOwnerId: "owner_1",
          actorUserId: "co_mgr",
          dataOwnerIds: ["owner_1"],
          assignedPropertyIds: ["p_assigned"],
        },
      },
    );
    const all = (await listPropertiesTool.handler(ctx, {})) as { properties: { id: string }[] };
    expect(all.properties.map((p) => p.id)).toEqual(["p_assigned"]);
    expect((await getPropertyDetailsTool.handler(ctx, { propertyId: "p_assigned" }))).toMatchObject({
      found: true,
    });
    expect((await getPropertyDetailsTool.handler(ctx, { propertyId: "p_own" }))).toMatchObject({
      found: false,
    });
    expect((await getPropertyDetailsTool.handler(ctx, { propertyId: "p_other" }))).toMatchObject({
      found: false,
    });
  });

  it("combined: lists owned houses plus assigned co-managed houses", async () => {
    const ctx = makeManagerRowsCtx(
      {
        manager_property_records: [
          rec("co_mgr", "p_own", "live", { id: "p_own", title: "Co own" }),
          rec("owner_1", "p_assigned", "live", { id: "p_assigned", title: "Assigned" }),
          rec("owner_1", "p_other", "live", { id: "p_other", title: "Owner other" }),
        ],
      },
      {
        landlordId: "co_mgr",
        userId: "co_mgr",
        managerSmsAccess: {
          mode: "combined",
          workNumberOwnerId: "co_mgr",
          actorUserId: "co_mgr",
          dataOwnerIds: ["co_mgr", "owner_1"],
          assignedPropertyIds: ["p_assigned"],
        },
      },
    );
    const all = (await listPropertiesTool.handler(ctx, {})) as { properties: { id: string }[] };
    expect(all.properties.map((p) => p.id).sort()).toEqual(["p_assigned", "p_own"]);
  });
});

describe("manager SMS application row scope", () => {
  it("delegated: hides unassigned owner applications and the actor's own houses", async () => {
    const ctx = makeManagerRowsCtx(
      {
        manager_application_records: [
          managerRow("owner_1", {
            id: "a_assigned",
            name: "Pat",
            bucket: "approved",
            propertyId: "p_assigned",
          }),
          managerRow("owner_1", {
            id: "a_other",
            name: "Sam",
            bucket: "approved",
            propertyId: "p_other",
          }),
          managerRow("co_mgr", {
            id: "a_own",
            name: "Own",
            bucket: "approved",
            propertyId: "p_own",
          }),
        ],
      },
      {
        landlordId: "owner_1",
        userId: "co_mgr",
        managerSmsAccess: {
          mode: "delegated",
          workNumberOwnerId: "owner_1",
          actorUserId: "co_mgr",
          dataOwnerIds: ["owner_1"],
          assignedPropertyIds: ["p_assigned"],
        },
      },
    );
    const res = (await listResidentsTool.handler(ctx, {})) as { residents: { id: string }[] };
    expect(res.residents.map((r) => r.id)).toEqual(["a_assigned"]);
    expect(
      await getApplicationDetailsTool.handler(ctx, { applicationId: "a_other" }),
    ).toMatchObject({ found: false });
  });
});
