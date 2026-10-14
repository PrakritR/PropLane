import { describe, expect, it } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { memberReceivesNotice, resolveWorkspaceNoticeRecipients } from "@/lib/workspace-team-recipients.server";
import { stampTeamRolePermissions } from "@/lib/co-manager-team-roles";

const HOUSE_A = "house-a";
const HOUSE_B = "house-b";

function invite(userId: string, role: string | null, over: Record<string, unknown> = {}) {
  const stamp = role && role !== "custom" ? stampTeamRolePermissions(role as never) : null;
  return {
    inviter_user_id: "owner",
    invitee_user_id: userId,
    status: "accepted",
    workspace_id: "ws-1",
    team_role: role,
    house_scope: "selected",
    assigned_property_ids: [HOUSE_A],
    co_manager_permissions: stamp ?? {},
    property_co_manager_permissions: stamp ? { [HOUSE_A]: stamp } : { [HOUSE_A]: { inbox: { read: true, notification: true } } },
    ...over,
  };
}

function seed(invites: Record<string, unknown>[]) {
  return createMemoryDb({
    portal_workspaces: [{ id: "ws-1", owner_user_id: "owner", name: "Seattle Homes", is_default: true }],
    profiles: [
      { id: "owner", email: "o@x.com", phone: "+12065550100" },
      { id: "admin", email: "a@x.com", phone: "" },
      { id: "pm", email: "pm@x.com", phone: "+12065550101", sms_forward_inbound: false },
      { id: "book", email: "b@x.com" },
      { id: "maint", email: "m@x.com" },
      { id: "view", email: "v@x.com" },
      { id: "inv", email: "i@x.com" },
      { id: "pm-all", email: "pa@x.com" },
    ],
    account_link_invites: invites,
  });
}

const roster = () => [
  invite("admin", "admin", { house_scope: "all", assigned_property_ids: [HOUSE_A, HOUSE_B] }),
  invite("pm", "property_manager"),
  invite("book", "bookkeeper", { house_scope: "all", assigned_property_ids: [HOUSE_A, HOUSE_B] }),
  invite("maint", "maintenance", { house_scope: "all", assigned_property_ids: [HOUSE_A, HOUSE_B] }),
  invite("view", "viewer"),
  invite("inv", "property_owner"),
];

async function ids(module: string, propertyId?: string | null) {
  const out = await resolveWorkspaceNoticeRecipients(seed(roster()) as never, {
    ownerUserId: "owner",
    workspaceId: "ws-1",
    module: module as never,
    propertyId,
  });
  return out.map((r) => r.userId).sort();
}

describe("resolveWorkspaceNoticeRecipients — the role matrix", () => {
  it("always includes the owner, and never a property owner", async () => {
    for (const moduleKey of ["inbox", "payments", "services"]) {
      const got = await ids(moduleKey, HOUSE_A);
      expect(got).toContain("owner");
      expect(got).not.toContain("inv");
    }
  });
  it("an admin hears every event on every house", async () => {
    expect(await ids("inbox", HOUSE_A)).toContain("admin");
    expect(await ids("leases", HOUSE_B)).toContain("admin");
    expect(await ids("inbox", null)).toContain("admin");
  });
  it("a property manager and a viewer hear events on their houses only", async () => {
    const a = await ids("inbox", HOUSE_A);
    expect(a).toEqual(expect.arrayContaining(["pm", "view"]));
    const b = await ids("inbox", HOUSE_B);
    expect(b).not.toContain("pm");
    expect(b).not.toContain("view");
  });
  it("a no-house event (prospect text, work email) reaches property managers, leasing and viewers", async () => {
    const got = await ids("inbox", null);
    expect(got).toEqual(expect.arrayContaining(["owner", "admin", "pm", "view"]));
  });
  it("a bookkeeper hears payments and financials only", async () => {
    expect(await ids("payments", HOUSE_A)).toContain("book");
    expect(await ids("financials", null)).toContain("book");
    expect(await ids("inbox", null)).not.toContain("book");
    expect(await ids("services", HOUSE_A)).not.toContain("book");
  });
  it("maintenance hears services only", async () => {
    expect(await ids("services", HOUSE_A)).toContain("maint");
    expect(await ids("payments", HOUSE_A)).not.toContain("maint");
    expect(await ids("inbox", null)).not.toContain("maint");
  });
  it("a teammate whose notification is switched off for the module hears nothing", () => {
    const member = {
      teamRole: "property_manager",
      isOwner: false,
      grantRow: {
        house_scope: "selected",
        assigned_property_ids: [HOUSE_A],
        co_manager_permissions: {},
        property_co_manager_permissions: { [HOUSE_A]: { inbox: { read: true, notification: false } } },
        team_role: "property_manager",
      },
    };
    expect(memberReceivesNotice(member, { module: "inbox", propertyId: HOUSE_A })).toBe(false);
  });
  it("a teammate from another workspace is not in the roster", async () => {
    const other = invite("pm", "property_manager", { workspace_id: "ws-elsewhere" });
    const out = await resolveWorkspaceNoticeRecipients(seed([other]) as never, {
      ownerUserId: "owner", workspaceId: "ws-1", module: "inbox", propertyId: HOUSE_A,
    });
    expect(out.map((r) => r.userId)).toEqual(["owner"]);
  });
  it("reports each person's channels from their own settings", async () => {
    const out = await resolveWorkspaceNoticeRecipients(seed(roster()) as never, {
      ownerUserId: "owner", workspaceId: "ws-1", module: "inbox", propertyId: HOUSE_A,
    });
    const by = Object.fromEntries(out.map((r) => [r.userId, r.channels]));
    expect(by.owner).toEqual({ assistant: true, email: true, sms: true });
    expect(by.pm.sms).toBe(false); // forwarding switched off
    expect(by.admin.sms).toBe(false); // no phone
    expect(by.admin.email).toBe(true);
  });
});
