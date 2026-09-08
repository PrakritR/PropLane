const recoveryRedirect = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("@/lib/auth/account-recovery.server", () => ({ recoverySetupRedirect: recoveryRedirect }));
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseJsonResponse } from "../../helpers/api-request";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));
vi.mock("@/lib/auth/profile-role-row", () => ({
  ensureProfileRoleRow: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/analytics/posthog", () => ({
  track: vi.fn(),
}));
vi.mock("@/lib/tour-resident-link.server", () => ({
  linkAllTourInquiriesForEmail: vi.fn().mockResolvedValue(undefined),
  reconcileProspectInboxThreadsForResident: vi.fn().mockResolvedValue(undefined),
}));

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { linkAllTourInquiriesForEmail, reconcileProspectInboxThreadsForResident } from "@/lib/tour-resident-link.server";
import { POST as createResidentAccount } from "@/app/api/auth/create-resident-account/route";

function postRequest(body?: Record<string, unknown>) {
  return new Request("http://localhost/api/auth/create-resident-account", {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Fake `profiles` + `profile_roles` query surface that records update/insert calls. */
function fakeService(existingProfile: { role?: string } | null, existingRoleRows: { role: string }[] = []) {
  const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
  const insert = vi.fn().mockResolvedValue({ error: null });
  const select = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: existingProfile }) }),
  });
  const rolesSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ data: existingRoleRows, error: null }),
  });
  const service = {
    from: vi.fn((table: string) => {
      if (table === "profiles") return { select, update, insert };
      if (table === "profile_roles") return { select: rolesSelect };
      return {};
    }),
  };
  return { service, update, insert };
}

function signedInAs(userId: string | null, email = "multi@axis.test") {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: userId ? { id: userId, email } : null } }) },
  } as never);
}

describe("POST /api/auth/create-resident-account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an unauthenticated caller with 401 and grants no role", async () => {
    signedInAs(null);
    const res = await createResidentAccount(postRequest());
    expect(res.status).toBe(401);
    expect(ensureProfileRoleRow).not.toHaveBeenCalled();
  });

  it("adds the resident role to a manager WITHOUT changing their primary role or profile", async () => {
    signedInAs("mgr-1");
    const { service, update, insert } = fakeService({ role: "manager" });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(service as never);

    const res = await createResidentAccount(postRequest());
    const { status, data } = await parseJsonResponse<{ ok: boolean; redirectTo: string }>(res);

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.redirectTo).toBe("/resident/applications/apply");
    // Resident role ADDED…
    expect(ensureProfileRoleRow).toHaveBeenCalledWith(service, "mgr-1", "resident");
    expect(linkAllTourInquiriesForEmail).toHaveBeenCalledWith(service, {
      userId: "mgr-1",
      email: "multi@axis.test",
    });
    expect(reconcileProspectInboxThreadsForResident).toHaveBeenCalledWith(service, {
      userId: "mgr-1",
      contactEmail: "multi@axis.test",
      authEmail: undefined,
      phone: undefined,
    });
    // …and the manager's profile is untouched: role unchanged, so no update, no insert.
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    // Lands them in the resident portal.
    expect(res.headers.get("set-cookie")).toContain("axis_active_portal=resident");
  });

  it("seeds a minimal profile when the authenticated user has none yet", async () => {
    signedInAs("new-1", "new@axis.test");
    const { service, insert } = fakeService(null);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(service as never);

    const res = await createResidentAccount(postRequest());
    expect(res.status).toBe(200);
    expect(insert).toHaveBeenCalledWith({ id: "new-1", email: "new@axis.test", role: "resident" });
    expect(ensureProfileRoleRow).toHaveBeenCalledWith(service, "new-1", "resident");
  });

  it("backfills a legacy-only manager role so adding resident never collapses it away", async () => {
    // profile_roles is EMPTY — the manager role resolves solely from the legacy
    // profiles.role column. normalizePortalRoles ignores that fallback once
    // profile_roles has ANY row, so the route must materialize the manager row
    // BEFORE inserting resident, or roles collapse to ["resident"] only.
    signedInAs("legacy-mgr-1");
    const { service } = fakeService({ role: "manager" }, []);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(service as never);

    const res = await createResidentAccount(postRequest());
    expect(res.status).toBe(200);
    expect(ensureProfileRoleRow).toHaveBeenCalledWith(service, "legacy-mgr-1", "manager");
    expect(ensureProfileRoleRow).toHaveBeenCalledWith(service, "legacy-mgr-1", "resident");
    const calls = vi.mocked(ensureProfileRoleRow).mock.calls.map((c) => c[2]);
    expect(calls.indexOf("manager")).toBeLessThan(calls.indexOf("resident"));
  });

  it("maps a legacy 'owner' profiles.role to a manager profile_roles row", async () => {
    signedInAs("legacy-owner-1");
    const { service } = fakeService({ role: "owner" }, []);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(service as never);

    const res = await createResidentAccount(postRequest());
    expect(res.status).toBe(200);
    expect(ensureProfileRoleRow).toHaveBeenCalledWith(service, "legacy-owner-1", "manager");
    expect(ensureProfileRoleRow).toHaveBeenCalledWith(service, "legacy-owner-1", "resident");
  });

  it("is idempotent — re-running for a user who already holds resident does not remove other roles", async () => {
    // The user already holds resident + manager; primary stays manager, resident
    // upsert is a no-op at the DB layer (composite PK), and nothing is removed.
    signedInAs("mgr-1");
    const { service, update } = fakeService({ role: "manager" });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(service as never);

    const res = await createResidentAccount(postRequest());
    expect(res.status).toBe(200);
    expect(update).not.toHaveBeenCalled();
    expect(ensureProfileRoleRow).toHaveBeenCalledWith(service, "mgr-1", "resident");
  });

  it("honors a safe resident redirect path in the request body", async () => {
    signedInAs("mgr-1");
    const { service } = fakeService({ role: "manager" });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(service as never);

    const res = await createResidentAccount(postRequest({ redirectTo: "/resident/communication/active" }));
    const { data } = await parseJsonResponse<{ redirectTo: string }>(res);
    expect(data.redirectTo).toBe("/resident/communication/active");
  });
});

it("returns recovery before granting resident access or linking records", async () => {
  vi.clearAllMocks();
  signedInAs("retained-user");
  const { service, update, insert } = fakeService(null);
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(service as never);
  recoveryRedirect.mockResolvedValueOnce("/auth/recover-account?portal=resident");
  const response = await createResidentAccount(postRequest());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ recoveryRequired: true, redirectTo: "/auth/recover-account?portal=resident" });
  expect(ensureProfileRoleRow).not.toHaveBeenCalled();
  expect(linkAllTourInquiriesForEmail).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(insert).not.toHaveBeenCalled();
});
