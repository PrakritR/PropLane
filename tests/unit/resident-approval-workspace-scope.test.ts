import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

/**
 * W006: `setResidentApprovalForManager` used to authorize strictly by the
 * portfolio relationship (`managerOwnsResident`), never checking the caller's
 * active workspace. A manager with 2+ workspaces could approve/deny a
 * resident tied to them only through a property outside the one currently
 * active — active-workspace narrowing now runs BESIDE that portfolio check,
 * never instead of it.
 */

const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => (state.cookieValue !== undefined ? { value: state.cookieValue } : undefined) })),
}));

const mocks = vi.hoisted(() => ({ loadWorkspaces: vi.fn() }));
vi.mock("@/lib/workspaces/server", () => ({ loadWorkspaces: mocks.loadWorkspaces }));

import { setResidentApprovalForManager } from "@/lib/resident-approval.server";

const MANAGER = "mgr-1";
const RESIDENT_EMAIL = "resident@example.com";
const WS_A = { id: "ws-a", name: "A", ownerUserId: MANAGER, owned: true, isDefault: true, propertyIds: ["p1"] };
const WS_B = { id: "ws-b", name: "B", ownerUserId: MANAGER, owned: true, isDefault: false, propertyIds: ["p2"] };

function setup(rows: {
  manager_application_records?: Row[];
  portal_household_charge_records?: Row[];
  portal_lease_pipeline_records?: Row[];
  profiles?: Row[];
  account_link_invites?: Row[];
}) {
  return fakeSupabaseClient({
    manager_application_records: rows.manager_application_records ?? [],
    portal_household_charge_records: rows.portal_household_charge_records ?? [],
    portal_lease_pipeline_records: rows.portal_lease_pipeline_records ?? [],
    profiles: rows.profiles ?? [{ id: RESIDENT_EMAIL, role: "resident", email: RESIDENT_EMAIL }],
    account_link_invites: rows.account_link_invites ?? [],
  });
}

beforeEach(() => {
  state.cookieValue = undefined;
  mocks.loadWorkspaces.mockReset();
});

describe("setResidentApprovalForManager — active-workspace guard", () => {
  it("refuses to approve a resident tied to the manager only through a property outside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id; // active = p1 only
    const db = setup({
      manager_application_records: [
        { id: "app-1", manager_user_id: MANAGER, resident_email: RESIDENT_EMAIL, property_id: "p2", assigned_property_id: null },
      ],
    });
    const result = await setResidentApprovalForManager(db as never, { userId: MANAGER, isAdmin: false }, { email: RESIDENT_EMAIL, approved: true });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("approves a resident tied to the manager through a property INSIDE the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    const db = setup({
      manager_application_records: [
        { id: "app-1", manager_user_id: MANAGER, resident_email: RESIDENT_EMAIL, property_id: "p1", assigned_property_id: null },
      ],
    });
    const result = await setResidentApprovalForManager(db as never, { userId: MANAGER, isAdmin: false }, { email: RESIDENT_EMAIL, approved: true });
    expect(result).toEqual({ ok: true });
  });

  it("switching the active workspace to B allows p2 and now refuses p1", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_B.id;
    const db = setup({
      manager_application_records: [
        { id: "app-1", manager_user_id: MANAGER, resident_email: RESIDENT_EMAIL, property_id: "p1", assigned_property_id: null },
      ],
    });
    const result = await setResidentApprovalForManager(db as never, { userId: MANAGER, isAdmin: false }, { email: RESIDENT_EMAIL, approved: true });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("a single-workspace manager is unaffected (workspace load resolves but narrows to their own houses only)", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A]);
    const db = setup({
      manager_application_records: [
        { id: "app-1", manager_user_id: MANAGER, resident_email: RESIDENT_EMAIL, property_id: "p1", assigned_property_id: null },
      ],
    });
    const result = await setResidentApprovalForManager(db as never, { userId: MANAGER, isAdmin: false }, { email: RESIDENT_EMAIL, approved: true });
    expect(result).toEqual({ ok: true });
  });

  it("never narrows a relationship with no discoverable property (nothing to check against)", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    // Uses the application table's plain `.eq()` lookup rather than the
    // charge/lease tables' `.or()` lookup — the fake Supabase helper only
    // implements the `.in.()`/`.is.null` `or()` shapes the workspace-scope
    // primitives themselves generate, not an arbitrary `.eq.` clause.
    const db = setup({
      manager_application_records: [
        { id: "app-1", manager_user_id: MANAGER, resident_email: RESIDENT_EMAIL, property_id: null, assigned_property_id: null },
      ],
    });
    const result = await setResidentApprovalForManager(db as never, { userId: MANAGER, isAdmin: false }, { email: RESIDENT_EMAIL, approved: true });
    expect(result).toEqual({ ok: true });
  });

  it("an admin bypasses both the portfolio and workspace checks", async () => {
    const db = setup({});
    const result = await setResidentApprovalForManager(db as never, { userId: "admin-1", isAdmin: true }, { email: RESIDENT_EMAIL, approved: true });
    expect(result).toEqual({ ok: true });
    expect(mocks.loadWorkspaces).not.toHaveBeenCalled();
  });
});
