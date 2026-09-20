/**
 * `/api/portal/automated-messages` house-scope behavior (PLAN-0916-1040):
 *
 *  - `{ reset: true }` with no `propertyId` must 400, not fall into the
 *    workspace-save branch and silently overwrite the workspace's automated
 *    messages with garbage (the bug: the reset check used to run AFTER the
 *    "no property" branch, so it was never reached without a propertyId).
 *  - A co-manager with an accepted grant for a house may read/write that
 *    house's own override — landing on the OWNER's row, never a permission
 *    a wider check would have refused.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const getUser = vi.fn();
const resolveOwner = vi.fn();
const assertModuleAccess = vi.fn();
const loadAutomatedMessageSettings = vi.fn();
const saveAutomatedMessageSettings = vi.fn();
const resolveOperationsOverride = vi.fn();
const savePropertyOverride = vi.fn();
const clearPropertyOverride = vi.fn();
const listPropertyOverrides = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from(table: string) {
      if (table === "profiles") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "manager" } }) }) }) };
      }
      if (table === "profile_roles") {
        return { select: () => ({ eq: async () => ({ data: [{ role: "manager" }] }) }) };
      }
      throw new Error(`unexpected table "${table}"`);
    },
  }),
}));
vi.mock("@/lib/property-owner.server", () => ({
  resolvePropertyOwnerUserId: (...args: unknown[]) => resolveOwner(...args),
}));
vi.mock("@/lib/auth/co-manager-access", () => ({
  assertCoManagerModuleAccess: (...args: unknown[]) => assertModuleAccess(...args),
}));
vi.mock("@/lib/automated-messages-settings.server", () => ({
  loadAutomatedMessageSettings: (...args: unknown[]) => loadAutomatedMessageSettings(...args),
  saveAutomatedMessageSettings: (...args: unknown[]) => saveAutomatedMessageSettings(...args),
}));
vi.mock("@/lib/automated-messages-defaults.server", () => ({ automatedMessageDefaults: () => ({}) }));
vi.mock("@/lib/settings/property-overrides.server", () => ({
  ForeignPropertyError: class ForeignPropertyError extends Error {},
  resolveOperationsOverride: (...args: unknown[]) => resolveOperationsOverride(...args),
  savePropertyOverride: (...args: unknown[]) => savePropertyOverride(...args),
  clearPropertyOverride: (...args: unknown[]) => clearPropertyOverride(...args),
  listPropertyOverrides: (...args: unknown[]) => listPropertyOverrides(...args),
}));

import { PATCH as automatedMessagesPatch } from "@/app/api/portal/automated-messages/route";

const OWNER = "mgr-owner-1";
const CO_MANAGER = "mgr-co-1";
const HOUSE = "house-1";

function patch(body: Record<string, unknown>) {
  return automatedMessagesPatch(
    jsonRequest("http://localhost/api/portal/automated-messages", { method: "PATCH", body }) as unknown as Request,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: OWNER } } });
  loadAutomatedMessageSettings.mockResolvedValue({});
  saveAutomatedMessageSettings.mockResolvedValue({});
  resolveOperationsOverride.mockResolvedValue({ settings: {}, scope: "workspace", inherited: true });
  listPropertyOverrides.mockResolvedValue([]);
  savePropertyOverride.mockResolvedValue(undefined);
  clearPropertyOverride.mockResolvedValue(undefined);
  // Default: the module gate passes (workspace-scope tests never exercise the
  // co-manager path at all, since `resolveOwner`/`resolveOwner === callerId`
  // short-circuits before it; only the co-manager describe block below
  // overrides this).
  assertModuleAccess.mockResolvedValue({ ok: true });
});

describe("PATCH /api/portal/automated-messages — reset needs a property", () => {
  it("400s a reset with no propertyId, and never touches the workspace store", async () => {
    const res = await patch({ reset: true });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/property/i);
    expect(saveAutomatedMessageSettings).not.toHaveBeenCalled();
    expect(clearPropertyOverride).not.toHaveBeenCalled();
  });

  it("clears the house override when a propertyId is given", async () => {
    resolveOwner.mockResolvedValue(OWNER);
    const res = await patch({ reset: true, propertyId: HOUSE });
    expect(res.status).toBe(200);
    expect(clearPropertyOverride).toHaveBeenCalledWith(expect.anything(), OWNER, HOUSE, "automatedMessages");
  });
});

describe("PATCH /api/portal/automated-messages — co-manager house-scoped write", () => {
  it("a co-manager WITH an accepted grant writes to the OWNER's row, not their own", async () => {
    getUser.mockResolvedValue({ data: { user: { id: CO_MANAGER } } });
    resolveOwner.mockResolvedValue(OWNER);
    assertModuleAccess.mockResolvedValue({ ok: true });

    const res = await patch({ propertyId: HOUSE, settings: { "work_order:accepted:resident": { enabled: true } } });

    expect(res.status).toBe(200);
    // Every downstream call lands on the property OWNER's id, never the co-manager's own.
    expect(resolveOperationsOverride).toHaveBeenCalledWith(expect.anything(), OWNER, HOUSE, "automatedMessages", expect.anything());
    expect(savePropertyOverride.mock.calls[0]![1]).toBe(OWNER);
    expect(savePropertyOverride.mock.calls[0]![2]).toBe(HOUSE);
  });

  it("a co-manager WITHOUT the grant is refused (403), and nothing is ever written", async () => {
    getUser.mockResolvedValue({ data: { user: { id: CO_MANAGER } } });
    resolveOwner.mockResolvedValue(OWNER);
    assertModuleAccess.mockResolvedValue({ ok: false, status: 403, error: "You do not have access to this section for this property." });

    const res = await patch({ propertyId: HOUSE, settings: { "work_order:accepted:resident": { enabled: true } } });

    expect(res.status).toBe(403);
    expect(savePropertyOverride).not.toHaveBeenCalled();
    expect(resolveOperationsOverride).not.toHaveBeenCalled();
  });

  it("an unrelated propertyId (owner lookup fails) is a 403, never a workspace fallback", async () => {
    getUser.mockResolvedValue({ data: { user: { id: CO_MANAGER } } });
    resolveOwner.mockResolvedValue(null);

    const res = await patch({ propertyId: "unknown-house", settings: {} });

    expect(res.status).toBe(403);
    expect(savePropertyOverride).not.toHaveBeenCalled();
  });
});
