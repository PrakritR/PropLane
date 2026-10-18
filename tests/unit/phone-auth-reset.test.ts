import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(), identity: vi.fn(), workspace: vi.fn(), residentBinding: vi.fn(), residentLinks: vi.fn(), vendorLinks: vi.fn(),
}));
vi.mock("@/lib/auth/phone-auth.server", () => ({
  PHONE_AUTH_ERROR: "Phone verification unavailable", phoneAuthEnabled: mocks.enabled, readPhoneIdentity: mocks.identity,
}));
vi.mock("@/lib/auth/resident-workspace-binding", () => ({ residentBoundToManager: mocks.residentBinding }));
vi.mock("@/lib/workspaces/active.server", () => ({ resolveActiveWorkspaceFromRequest: mocks.workspace }));
vi.mock("@/lib/communication/resident-conversations.server", () => ({ loadResidentLinkedWorkspaceIds: mocks.residentLinks }));
vi.mock("@/lib/communication/vendor-conversations.server", () => ({ loadVendorLinkedWorkspaceIds: mocks.vendorLinks }));

import { resetWorkspaceMemberPhone } from "@/lib/auth/phone-auth-reset.server";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORKSPACE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let roles: Record<string, string[]>;
let roleError = false;
const rpc = vi.fn();
const db = {
  from: vi.fn((table: string) => {
    if (table !== "profile_roles") throw new Error("Only canonical roles may be read here");
    return { select: () => ({ eq: (_column: string, user: string) => Promise.resolve({
      data: roles[user]?.map((role) => ({ role })), error: roleError ? { message: "unreadable" } : null,
    }) }) };
  }),
  rpc,
} as unknown as SupabaseClient;

beforeEach(() => {
  vi.clearAllMocks();
  roleError = false;
  roles = { [ACTOR]: ["manager"], [TARGET]: ["resident"] };
  mocks.enabled.mockResolvedValue(true);
  mocks.identity.mockResolvedValue({ verified: true, phone: "+14255550123" });
  mocks.workspace.mockResolvedValue({ id: WORKSPACE, ownerUserId: ACTOR, owned: true });
  mocks.residentBinding.mockResolvedValue(true);
  mocks.residentLinks.mockResolvedValue(new Set([WORKSPACE]));
  mocks.vendorLinks.mockResolvedValue(new Set([WORKSPACE]));
  rpc.mockResolvedValue({ data: true, error: null });
});

describe("workspace owner's phone reset", () => {
  it("uses server-resolved owner/workspace and a single leased database transition", async () => {
    await resetWorkspaceMemberPhone(db, ACTOR, TARGET);
    expect(mocks.workspace).toHaveBeenCalledWith(db, ACTOR);
    expect(mocks.residentBinding).toHaveBeenCalledWith(db, TARGET, ACTOR);
    expect(mocks.residentLinks).toHaveBeenCalledWith(db, TARGET, [WORKSPACE]);
    const [name, args] = rpc.mock.calls[1];
    expect(name).toBe("phone_auth_reset");
    expect(args).toEqual({ p_actor: ACTOR, p_target: TARGET, p_workspace: WORKSPACE, p_phone: "+14255550123", p_operation: expect.any(String) });
    expect(rpc.mock.calls[0]).toEqual(["phone_auth_claim_operation", { p_operation: args.p_operation, p_phone: "+14255550123", p_user: TARGET }]);
    expect(rpc.mock.calls[2]).toEqual(["phone_auth_release_operation", { p_operation: args.p_operation }]);
  });

  it("accepts an account-linked vendor for the SQL consent/scope check", async () => {
    roles[TARGET] = ["vendor"];
    await resetWorkspaceMemberPhone(db, ACTOR, TARGET);
    expect(mocks.vendorLinks).toHaveBeenCalledWith(db, TARGET, [WORKSPACE]);
    expect(mocks.residentBinding).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("phone_auth_reset", expect.any(Object));
  });

  it.each(["per_workspace", "shadow"])("does nothing when phone authentication is disabled (%s)", async () => {
    mocks.enabled.mockResolvedValue(false);
    await expect(resetWorkspaceMemberPhone(db, ACTOR, TARGET)).rejects.toThrow();
    expect(mocks.workspace).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a co-manager who can see but does not own the active workspace", async () => {
    mocks.workspace.mockResolvedValue({ id: WORKSPACE, ownerUserId: "someone-else", owned: false });
    await expect(resetWorkspaceMemberPhone(db, ACTOR, TARGET)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a manager without a verified phone", async () => {
    mocks.identity.mockImplementation((_db, user) => Promise.resolve({ verified: user !== ACTOR, phone: "+14255550123" }));
    await expect(resetWorkspaceMemberPhone(db, ACTOR, TARGET)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([["resident", "admin"], ["vendor", "manager"], []])("refuses protected or missing target roles %j", async (...targetRoles) => {
    roles[TARGET] = targetRoles as string[];
    await expect(resetWorkspaceMemberPhone(db, ACTOR, TARGET)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses manager-created resident records without the resident's own binding", async () => {
    mocks.residentBinding.mockResolvedValue(false);
    await expect(resetWorkspaceMemberPhone(db, ACTOR, TARGET)).rejects.toThrow();
    expect(mocks.residentLinks).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a resident linked only to another workspace", async () => {
    mocks.residentLinks.mockResolvedValue(new Set(["another-workspace"]));
    await expect(resetWorkspaceMemberPhone(db, ACTOR, TARGET)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed on unreadable roles and self reset", async () => {
    roleError = true;
    await expect(resetWorkspaceMemberPhone(db, ACTOR, TARGET)).rejects.toThrow();
    await expect(resetWorkspaceMemberPhone(db, ACTOR, ACTOR)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not steal an active verification lease", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(resetWorkspaceMemberPhone(db, ACTOR, TARGET)).rejects.toThrow();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("releases its lease when the transactional relationship recheck refuses the reset", async () => {
    rpc.mockImplementation((name) => Promise.resolve({ data: name !== "phone_auth_reset", error: null }));
    await expect(resetWorkspaceMemberPhone(db, ACTOR, TARGET)).rejects.toThrow();
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["phone_auth_claim_operation", "phone_auth_reset", "phone_auth_release_operation"]);
  });
});
