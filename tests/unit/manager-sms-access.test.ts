/**
 * Manager SMS identity and row scope: To pins the work-number owner; From must
 * be that owner's verified cell or a verified invitee of THAT owner. Combined
 * (own number + assigned co-managed houses) vs delegated (owner's number,
 * assigned houses only). A Twilio From is never a global phone search.
 */
import { describe, expect, it } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import {
  DELEGATED_SMS_UNSCOPED_TOOLS,
  filterSmsInboxOwnerIds,
  propertyIdFromToolRow,
  smsAccessAllowsProperty,
  smsAccessAllowsRow,
  smsDataOwnerIds,
  type ManagerSmsAccess,
} from "@/lib/sms/manager-sms-access";
import {
  resolveManagerSmsAccess,
  resolveManagerSmsInboundIdentity,
  smsInboxOwnerIds,
} from "@/lib/sms/manager-sms-access.server";

const OWNER = "owner-1";
const CO = "co-1";
const CO_B = "co-2";
const STRANGER = "stranger-1";
const OWNER_PHONE = "+12065550100";
const CO_PHONE = "+12065550200";
const CO_B_PHONE = "+12065550200";
const STRANGER_PHONE = "+13105550999";
const WORK = "+12065559000";
const ASSIGNED = "prop-assigned";
const OTHER_PROP = "prop-other";
const OWNED_PROP = "prop-owned";

function seed(extra: Record<string, Record<string, unknown>[]> = {}) {
  return createMemoryDb({
    profiles: [
      {
        id: OWNER,
        email: "owner@axis.test",
        phone: OWNER_PHONE,
        phone_verified_at: "2026-01-01T00:00:00Z",
      },
      {
        id: CO,
        email: "co@axis.test",
        phone: CO_PHONE,
        phone_verified_at: "2026-01-01T00:00:00Z",
      },
      {
        id: STRANGER,
        email: "stranger@axis.test",
        phone: STRANGER_PHONE,
        phone_verified_at: "2026-01-01T00:00:00Z",
      },
    ],
    account_link_invites: [
      {
        id: "link-1",
        status: "accepted",
        inviter_user_id: OWNER,
        invitee_user_id: CO,
        assigned_property_ids: [ASSIGNED],
      },
    ],
    ...extra,
  }) as never;
}

const delegated: ManagerSmsAccess = {
  mode: "delegated",
  workNumberOwnerId: OWNER,
  actorUserId: CO,
  dataOwnerIds: [OWNER],
  assignedPropertyIds: [ASSIGNED],
};

const combined: ManagerSmsAccess = {
  mode: "combined",
  workNumberOwnerId: CO,
  actorUserId: CO,
  dataOwnerIds: [CO, OWNER],
  assignedPropertyIds: [ASSIGNED],
};

const ownerOnly: ManagerSmsAccess = {
  mode: "owner",
  workNumberOwnerId: OWNER,
  actorUserId: OWNER,
  dataOwnerIds: [OWNER],
  assignedPropertyIds: [],
};

describe("resolveManagerSmsAccess", () => {
  it("returns owner when the texter owns the number and has no incoming assignments", async () => {
    const db = createMemoryDb({
      profiles: [{ id: OWNER, email: "owner@axis.test" }],
      account_link_invites: [],
    }) as never;
    const access = await resolveManagerSmsAccess(db, {
      actorUserId: OWNER,
      workNumberOwnerId: OWNER,
    });
    expect(access).toMatchObject({ mode: "owner", dataOwnerIds: [OWNER], assignedPropertyIds: [] });
  });

  it("returns combined when the texter owns the number and co-manages other houses", async () => {
    const access = await resolveManagerSmsAccess(seed(), {
      actorUserId: CO,
      workNumberOwnerId: CO,
    });
    expect(access?.mode).toBe("combined");
    expect(access?.dataOwnerIds).toEqual([CO, OWNER]);
    expect(access?.assignedPropertyIds).toEqual([ASSIGNED]);
  });

  it("returns delegated only for an accepted assignment from THIS work-number owner", async () => {
    const access = await resolveManagerSmsAccess(seed(), {
      actorUserId: CO,
      workNumberOwnerId: OWNER,
    });
    expect(access).toMatchObject({
      mode: "delegated",
      workNumberOwnerId: OWNER,
      actorUserId: CO,
      dataOwnerIds: [OWNER],
      assignedPropertyIds: [ASSIGNED],
    });
  });

  it("returns null when the actor has no assignment from this owner", async () => {
    const access = await resolveManagerSmsAccess(seed(), {
      actorUserId: STRANGER,
      workNumberOwnerId: OWNER,
    });
    expect(access).toBeNull();
  });
});

describe("resolveManagerSmsInboundIdentity", () => {
  it("treats the work-number owner's verified cell as owner or combined", async () => {
    const identity = await resolveManagerSmsInboundIdentity(seed(), {
      workNumberOwnerId: OWNER,
      fromPhone: OWNER_PHONE,
      toPhone: WORK,
    });
    expect(identity?.actorUserId).toBe(OWNER);
    expect(identity?.access.mode).toBe("owner");
  });

  it("treats a verified assigned co-manager as delegated on the owner's number", async () => {
    const identity = await resolveManagerSmsInboundIdentity(seed(), {
      workNumberOwnerId: OWNER,
      fromPhone: CO_PHONE,
      toPhone: WORK,
    });
    expect(identity).toMatchObject({
      workNumberOwnerId: OWNER,
      actorUserId: CO,
      access: { mode: "delegated" },
    });
  });

  it("on the co-manager's own work number, includes owned houses plus assigned co-managed houses", async () => {
    const identity = await resolveManagerSmsInboundIdentity(seed(), {
      workNumberOwnerId: CO,
      fromPhone: CO_PHONE,
      toPhone: "+12065559111",
    });
    expect(identity?.actorUserId).toBe(CO);
    expect(identity?.access.mode).toBe("combined");
    expect(identity?.access.assignedPropertyIds).toEqual([ASSIGNED]);
    expect(identity?.access.dataOwnerIds).toEqual([CO, OWNER]);
  });

  it("returns null for an unverified co-manager phone", async () => {
    const db = seed({
      profiles: [
        {
          id: OWNER,
          email: "owner@axis.test",
          phone: OWNER_PHONE,
          phone_verified_at: "2026-01-01T00:00:00Z",
        },
        {
          id: CO,
          email: "co@axis.test",
          phone: CO_PHONE,
          phone_verified_at: null,
        },
      ],
    });
    expect(
      await resolveManagerSmsInboundIdentity(db, {
        workNumberOwnerId: OWNER,
        fromPhone: CO_PHONE,
        toPhone: WORK,
      }),
    ).toBeNull();
  });

  it("returns null for a verified manager who is not an invitee of this owner", async () => {
    expect(
      await resolveManagerSmsInboundIdentity(seed(), {
        workNumberOwnerId: OWNER,
        fromPhone: STRANGER_PHONE,
        toPhone: WORK,
      }),
    ).toBeNull();
  });

  it("fails closed when two invitees share the same verified phone", async () => {
    const db = seed({
      profiles: [
        {
          id: OWNER,
          email: "owner@axis.test",
          phone: OWNER_PHONE,
          phone_verified_at: "2026-01-01T00:00:00Z",
        },
        {
          id: CO,
          email: "co@axis.test",
          phone: CO_PHONE,
          phone_verified_at: "2026-01-01T00:00:00Z",
        },
        {
          id: CO_B,
          email: "co-b@axis.test",
          phone: CO_B_PHONE,
          phone_verified_at: "2026-01-01T00:00:00Z",
        },
      ],
      account_link_invites: [
        {
          id: "link-1",
          status: "accepted",
          inviter_user_id: OWNER,
          invitee_user_id: CO,
          assigned_property_ids: [ASSIGNED],
        },
        {
          id: "link-2",
          status: "accepted",
          inviter_user_id: OWNER,
          invitee_user_id: CO_B,
          assigned_property_ids: [ASSIGNED],
        },
      ],
    });
    expect(
      await resolveManagerSmsInboundIdentity(db, {
        workNumberOwnerId: OWNER,
        fromPhone: CO_PHONE,
        toPhone: WORK,
      }),
    ).toBeNull();
  });
});

describe("smsAccessAllowsRow / smsAccessAllowsProperty", () => {
  it("lets an unrestricted owner turn see every row", () => {
    expect(
      smsAccessAllowsRow(ownerOnly, {
        dataOwnerId: OWNER,
        rowData: { propertyId: OTHER_PROP },
        table: "manager_application_records",
      }),
    ).toBe(true);
    expect(
      smsAccessAllowsProperty(ownerOnly, {
        propertyId: OTHER_PROP,
        recordOwnerId: OWNER,
        actorUserId: OWNER,
      }),
    ).toBe(true);
  });

  it("combined: keeps owned rows; other-owner rows only when the property is assigned", () => {
    expect(
      smsAccessAllowsRow(combined, {
        dataOwnerId: CO,
        rowData: { propertyId: OWNED_PROP },
        table: "manager_application_records",
      }),
    ).toBe(true);
    expect(
      smsAccessAllowsRow(combined, {
        dataOwnerId: OWNER,
        rowData: { propertyId: ASSIGNED },
        table: "manager_application_records",
      }),
    ).toBe(true);
    expect(
      smsAccessAllowsRow(combined, {
        dataOwnerId: OWNER,
        rowData: { propertyId: OTHER_PROP },
        table: "manager_application_records",
      }),
    ).toBe(false);
    expect(
      smsAccessAllowsRow(combined, {
        dataOwnerId: OWNER,
        rowData: { name: "unattributed" },
        table: "manager_application_records",
      }),
    ).toBe(false);
  });

  it("delegated: hides the actor's own houses and unattributed non-vendor rows", () => {
    expect(
      smsAccessAllowsRow(delegated, {
        dataOwnerId: CO,
        rowData: { propertyId: OWNED_PROP },
        table: "manager_application_records",
      }),
    ).toBe(false);
    expect(
      smsAccessAllowsRow(delegated, {
        dataOwnerId: OWNER,
        rowData: { propertyId: ASSIGNED },
        table: "manager_application_records",
      }),
    ).toBe(true);
    expect(
      smsAccessAllowsRow(delegated, {
        dataOwnerId: OWNER,
        rowData: { propertyId: OTHER_PROP },
        table: "manager_application_records",
      }),
    ).toBe(false);
    expect(
      smsAccessAllowsRow(delegated, {
        dataOwnerId: OWNER,
        rowData: { name: "unattributed" },
        table: "manager_application_records",
      }),
    ).toBe(false);
    expect(
      smsAccessAllowsRow(delegated, {
        dataOwnerId: OWNER,
        rowData: { name: "vendor" },
        table: "manager_vendor_records",
      }),
    ).toBe(true);
  });

  it("reads propertyId from nested application payloads", () => {
    expect(propertyIdFromToolRow({ application: { propertyId: ASSIGNED } })).toBe(ASSIGNED);
  });

  it("smsDataOwnerIds unions landlordId with extra owners", () => {
    expect(
      smsDataOwnerIds({
        landlordId: CO,
        managerSmsAccess: combined,
      }),
    ).toEqual([CO, OWNER]);
  });

  it("filterSmsInboxOwnerIds keeps Communication owners that are also data owners", () => {
    expect(
      filterSmsInboxOwnerIds(
        { landlordId: OWNER, userId: CO, managerSmsAccess: delegated },
        [CO, OWNER],
      ),
    ).toEqual([OWNER]);
    expect(
      filterSmsInboxOwnerIds(
        { landlordId: OWNER, userId: CO, managerSmsAccess: delegated },
        [CO],
      ),
    ).toEqual([]);
    expect(
      filterSmsInboxOwnerIds(
        { landlordId: CO, userId: CO, managerSmsAccess: undefined },
        [OWNER],
      ),
    ).toEqual([CO]);
  });
});

describe("DELEGATED_SMS_UNSCOPED_TOOLS", () => {
  it("names the landlord-wide tools that cannot be property-filtered", () => {
    expect(DELEGATED_SMS_UNSCOPED_TOOLS).toEqual(
      expect.arrayContaining([
        "run_financial_report",
        "get_dashboard_summary",
        "list_calendar_events",
        "list_co_managers",
      ]),
    );
  });
});

describe("smsInboxOwnerIds", () => {
  function ctxFor(db: ReturnType<typeof seed>, access: ManagerSmsAccess) {
    return {
      landlordId: access.workNumberOwnerId,
      userId: access.actorUserId,
      email: "co@axis.test",
      roles: ["manager"],
      isAdmin: false,
      db,
      managerSmsAccess: access,
    } as never;
  }

  it("includes the work-number owner when Communication is granted", async () => {
    const db = seed({
      account_link_invites: [
        {
          id: "link-1",
          status: "accepted",
          inviter_user_id: OWNER,
          invitee_user_id: CO,
          assigned_property_ids: [ASSIGNED],
          property_co_manager_permissions: { [ASSIGNED]: { inbox: true } },
        },
      ],
    });
    expect(await smsInboxOwnerIds(ctxFor(db, delegated), "edit")).toEqual([OWNER]);
  });

  it("drops the owner when the link grants no modules at all", async () => {
    // An empty permissions map is NO access, not the full grant it once was.
    // See tests/unit/co-manager-empty-permissions-deny.test.ts.
    expect(await smsInboxOwnerIds(ctxFor(seed(), delegated), "edit")).toEqual([]);
  });

  it("drops the owner when the assignment excludes Communication", async () => {
    const db = seed({
      account_link_invites: [
        {
          id: "link-1",
          status: "accepted",
          inviter_user_id: OWNER,
          invitee_user_id: CO,
          assigned_property_ids: [ASSIGNED],
          property_co_manager_permissions: { [ASSIGNED]: { applications: true } },
        },
      ],
    });
    expect(await smsInboxOwnerIds(ctxFor(db, delegated), "read")).toEqual([]);
    expect(await smsInboxOwnerIds(ctxFor(db, delegated), "edit")).toEqual([]);
  });

  it("read-only Communication cannot edit", async () => {
    const db = seed({
      account_link_invites: [
        {
          id: "link-1",
          status: "accepted",
          inviter_user_id: OWNER,
          invitee_user_id: CO,
          assigned_property_ids: [ASSIGNED],
          property_co_manager_permissions: { [ASSIGNED]: { inbox: { read: true } } },
        },
      ],
    });
    expect(await smsInboxOwnerIds(ctxFor(db, delegated), "read")).toEqual([OWNER]);
    expect(await smsInboxOwnerIds(ctxFor(db, delegated), "edit")).toEqual([]);
  });
});
