// Provisioning for sign-up by text: the same functions the website calls, the phone bound by the same RPC, one account per phone.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const m = vi.hoisted(() => ({
  ensureManager: vi.fn(), vendor: vi.fn(), resident: vi.fn(), owners: vi.fn(), track: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/analytics/posthog", () => ({ track: m.track }));
vi.mock("@/lib/auth/manager-portal-provision", () => ({ ensureFreeManagerPortalAccess: m.ensureManager }));
vi.mock("@/lib/auth/provision-vendor-account", () => ({ provisionVendorAccountByEmail: m.vendor }));
vi.mock("@/lib/auth/provision-resident-account", () => ({ provisionResidentAccountByEmail: m.resident }));
vi.mock("@/lib/auth/phone-auth.server", () => ({ phoneOwners: m.owners, phoneBrowserHash: (b: string) => `h:${b}` }));

import { provisionSmsSignupAccount } from "@/lib/one-number/signup/provision.server";

const PHONE = "+12065550142";
const NEW_USER = { id: "new-user", email: "abc@phone.proplane.invalid", user_metadata: { full_name: "Jane Doe" } };

function stub(over: { bindOk?: boolean; claimOk?: boolean; createError?: boolean } = {}) {
  const calls: { rpc: [string, Record<string, unknown>][]; from: { table: string; op: string; value?: unknown }[]; created: unknown[]; deleted: string[] } = { rpc: [], from: [], created: [], deleted: [] };
  const table = (name: string) => {
    const q: Record<string, unknown> = {};
    const chain = (op: string) => (value?: unknown) => { calls.from.push({ table: name, op, value }); return q; };
    Object.assign(q, {
      insert: chain("insert"), update: chain("update"), upsert: chain("upsert"), delete: chain("delete"),
      eq: () => q, is: () => q, select: () => q,
      then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
    });
    return q;
  };
  const db = {
    from: table,
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.rpc.push([name, args]);
      if (name === "phone_auth_claim_operation") return { data: over.claimOk === false ? false : true, error: null };
      if (name === "phone_auth_bind") return { data: over.bindOk === false ? false : true, error: null };
      if (name === "ensure_default_portal_workspace") return { data: "ws-1", error: null };
      return { data: null, error: null };
    },
    auth: {
      admin: {
        createUser: async (args: unknown) => { calls.created.push(args); return over.createError ? { data: { user: null }, error: { message: "dup" } } : { data: { user: NEW_USER }, error: null }; },
        getUserById: async () => ({ data: { user: NEW_USER }, error: null }),
        updateUserById: async () => ({ data: { user: NEW_USER }, error: null }),
        deleteUser: async (id: string) => { calls.deleted.push(id); return { error: null }; },
      },
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.owners.mockResolvedValue([]);
  m.ensureManager.mockResolvedValue({ status: "portal_ready", managerId: "m1", provisioned: true });
  m.vendor.mockResolvedValue({ ok: true, axisId: "ax", linkedManagerId: null, unlinkedReason: null });
  m.resident.mockResolvedValue({ ok: true, axisId: "ax", linkedApplication: false });
});

const answers = { fullName: "Jane Doe", businessName: "Doe Rentals", homes: 12, email: "jane@doerentals.com" };

describe("manager: the website's own provisioning", () => {
  it("calls ensureFreeManagerPortalAccess (the create-account path) on the Free plan, binds the phone, renames the default workspace", async () => {
    const { db, calls } = stub();
    const result = await provisionSmsSignupAccount(db, { phoneE164: PHONE, role: "manager", answers });
    expect(result).toMatchObject({ ok: true, userId: "new-user" });
    expect(m.ensureManager).toHaveBeenCalledTimes(1);
    expect(m.ensureManager.mock.calls[0]![2]).toEqual({ trialForNewManager: false, allowResidentUpgrade: true });
    expect(m.ensureManager.mock.calls[0]![1]).toMatchObject({ id: "new-user" });
    // The phone is bound by the sign-in RPC under the phone lease, never written to the profile directly.
    const names = calls.rpc.map(([n]) => n);
    expect(names.indexOf("phone_auth_claim_operation")).toBeLessThan(names.indexOf("phone_auth_bind"));
    expect(names).toContain("phone_auth_release_operation");
    expect(calls.from.filter((c) => c.table === "profiles" && c.op === "update")).toHaveLength(0);
    // Default workspace renamed, and only the untouched default name.
    expect(calls.from).toContainEqual({ table: "portal_workspaces", op: "update", value: { name: "Doe Rentals" } });
    // A manager is not a resident.
    expect(calls.from).toContainEqual({ table: "profile_roles", op: "delete", value: undefined });
    expect(m.track).toHaveBeenCalledWith("manager_account_created", "new-user", { signup_method: "sms" });
  });

  it("the typed email is a claim: user metadata only, never the login", async () => {
    const { db, calls } = stub();
    await provisionSmsSignupAccount(db, { phoneE164: PHONE, role: "manager", answers });
    const created = calls.created[0] as { email: string; phone: string; phone_confirm: boolean; user_metadata: Record<string, unknown>; app_metadata: Record<string, unknown> };
    expect(created.email).toMatch(/^[0-9a-f-]{36}@phone\.proplane\.invalid$/);
    expect(created.email).not.toContain("jane");
    expect(created.phone).toBe(PHONE);
    expect(created.phone_confirm).toBe(true);
    expect(created.app_metadata).toEqual({ phone_only: true });
    expect(created.user_metadata).toMatchObject({ full_name: "Jane Doe", unverified_email: "jane@doerentals.com" });
    // Provisioning is handed the placeholder login, so nothing is keyed on the typed address.
    expect(m.ensureManager.mock.calls[0]![1].email).toBe(NEW_USER.email);
  });

  it("a manager provisioning that does not reach portal_ready leaves no account behind", async () => {
    m.ensureManager.mockResolvedValue({ status: "skipped", reason: "no_email" });
    const { db, calls } = stub();
    expect(await provisionSmsSignupAccount(db, { phoneE164: PHONE, role: "manager", answers })).toEqual({ ok: false, reason: "unavailable" });
    expect(calls.deleted).toEqual(["new-user"]);
  });
});

describe("vendor and resident", () => {
  it("vendor: the vendor-register provisioning, the vendor business record, the lead linked, no resident role", async () => {
    const { db, calls } = stub();
    const result = await provisionSmsSignupAccount(db, {
      phoneE164: PHONE, role: "vendor", vendorLeadPhoneKey: "2065550142",
      answers: { fullName: "Sam Roe", trade: "plumbing", area: "Ballard 98107" },
    });
    expect(result.ok).toBe(true);
    expect(m.vendor).toHaveBeenCalledTimes(1);
    expect(m.vendor.mock.calls[0]![1]).toMatchObject({ userId: "new-user", email: NEW_USER.email, invite: null, confirmEmail: true });
    expect(calls.from).toContainEqual({ table: "profiles", op: "update", value: { role: "vendor" } });
    const business = calls.from.find((c) => c.table === "vendor_business_profiles");
    expect(business?.value).toMatchObject({ user_id: "new-user", trades: ["Plumbing"], service_area_zips: ["98107"] });
    expect(calls.from.some((c) => c.table === "sms_vendor_leads" && c.op === "update")).toBe(true);
    expect(calls.from).toContainEqual({ table: "profile_roles", op: "delete", value: undefined });
    expect(m.ensureManager).not.toHaveBeenCalled();
  });

  it("resident: the resident provisioning with the email NOT proven, no inheritance, no workspace binding", async () => {
    const { db } = stub();
    const result = await provisionSmsSignupAccount(db, { phoneE164: PHONE, role: "resident", answers: { fullName: "Rae Lin", home: "61 Elm Street", email: "rae@example.com" } });
    expect(result.ok).toBe(true);
    expect(m.resident.mock.calls[0]![1]).toMatchObject({ userId: "new-user", email: NEW_USER.email, phone: PHONE, inheritFromApplication: false, emailProven: false });
    expect(m.ensureManager).not.toHaveBeenCalled();
    expect(m.vendor).not.toHaveBeenCalled();
  });
});

describe("one account per phone", () => {
  it("a phone with an owner anywhere creates nothing", async () => {
    m.owners.mockResolvedValue(["someone"]);
    const { db, calls } = stub();
    expect(await provisionSmsSignupAccount(db, { phoneE164: PHONE, role: "manager", answers })).toEqual({ ok: false, reason: "exists", existingUserId: "someone" });
    expect(calls.created).toHaveLength(0);
    expect(m.ensureManager).not.toHaveBeenCalled();
    // The lease is still released.
    expect(calls.rpc.map(([n]) => n)).toContain("phone_auth_release_operation");
  });

  it("two owners: exists, with no single account to link", async () => {
    m.owners.mockResolvedValue(["a", "b"]);
    const { db } = stub();
    expect(await provisionSmsSignupAccount(db, { phoneE164: PHONE, role: "manager", answers })).toEqual({ ok: false, reason: "exists", existingUserId: null });
  });

  it("losing the create race to another account for the same phone reports exists", async () => {
    m.owners.mockResolvedValueOnce([]).mockResolvedValueOnce(["winner"]);
    const { db } = stub({ createError: true });
    expect(await provisionSmsSignupAccount(db, { phoneE164: PHONE, role: "manager", answers })).toEqual({ ok: false, reason: "exists", existingUserId: "winner" });
  });

  it("a phone lease that is held elsewhere creates nothing", async () => {
    const { db, calls } = stub({ claimOk: false });
    expect(await provisionSmsSignupAccount(db, { phoneE164: PHONE, role: "manager", answers })).toEqual({ ok: false, reason: "unavailable" });
    expect(calls.created).toHaveLength(0);
  });

  it("a bind that fails removes the half-made login", async () => {
    const { db, calls } = stub({ bindOk: false });
    expect(await provisionSmsSignupAccount(db, { phoneE164: PHONE, role: "manager", answers })).toEqual({ ok: false, reason: "unavailable" });
    expect(calls.deleted).toEqual(["new-user"]);
    expect(m.ensureManager).not.toHaveBeenCalled();
  });

  it("no name, no account", async () => {
    const { db, calls } = stub();
    expect(await provisionSmsSignupAccount(db, { phoneE164: PHONE, role: "manager", answers: {} })).toEqual({ ok: false, reason: "unavailable" });
    expect(calls.created).toHaveLength(0);
  });
});
