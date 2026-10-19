/**
 * An owner-only account uses the normal Property portal, so the manager report
 * routes (rent roll, profitability, documents…) hand it a manager context.
 */
import { describe, expect, it, vi } from "vitest";

let serviceDb: unknown;
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "owner-user", user_metadata: {} } } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => serviceDb }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: async () => ({ kind: "normal" }) }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/manager-access-server", () => ({ getManagerSubscriptionTier: async () => "pro" }));

import { getReportsAuthContext } from "@/lib/reports/auth";
import { makeFakeDb } from "./property-owner-fake-db";

const OWNER = "owner-user";
const ownerRow = {
  id: "l1",
  inviter_user_id: "manager-1",
  invitee_user_id: OWNER,
  status: "accepted",
  team_role: "property_owner",
  assigned_property_ids: ["house-a"],
};
const common = {
  profiles: [{ id: OWNER, email: "dana@example.com", role: "manager" }],
  profile_roles: [{ user_id: OWNER, role: "manager" }],
  manager_property_records: [],
  manager_purchases: [],
};

describe("getReportsAuthContext", () => {
  it("returns a manager context for an owner-only account, since it uses the Property portal", async () => {
    serviceDb = makeFakeDb({ ...common, account_link_invites: [ownerRow] });
    expect(await getReportsAuthContext({ preferRole: "manager" })).toMatchObject({ role: "manager", userId: OWNER });
    expect(await getReportsAuthContext()).toMatchObject({ role: "manager", userId: OWNER });
  });

  it("still returns the manager context for a manager, including one who is also an owner elsewhere", async () => {
    serviceDb = makeFakeDb({ ...common, account_link_invites: [] });
    expect(await getReportsAuthContext({ preferRole: "manager" })).toMatchObject({ role: "manager", userId: OWNER });
    serviceDb = makeFakeDb({ ...common, manager_property_records: [{ id: "mine", manager_user_id: OWNER }], account_link_invites: [ownerRow] });
    expect(await getReportsAuthContext({ preferRole: "manager" })).toMatchObject({ role: "manager", userId: OWNER });
  });
});
