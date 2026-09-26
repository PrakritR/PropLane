/**
 * Saving automation must not wipe the manager's application fee.
 *
 * The fee branch of this PATCH reads an ABSENT `applicationFeeCents` as "clear it" — that is how
 * the settings modal clears the account-wide fee back to the per-listing fallback. The automation
 * toggles post to the same route, and an automation-only PATCH carries no fee key, so routing it
 * through that branch would silently zero a fee the manager still believes they charge. This is
 * the same revenue-loss shape `manager-application-settings.ts` already warns about.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireManagerRouteUser = vi.fn();
const loadManagerApplicationSettings = vi.fn();
const saveManagerApplicationSettings = vi.fn();
const validateManagerApplicationFeeCents = vi.fn();
const suggestedManagerApplicationFeeCents = vi.fn();
const loadApplicationAutomation = vi.fn();
const loadApplicationAutomationState = vi.fn();
const saveApplicationAutomation = vi.fn();
const savePropertyOverride = vi.fn();
const loadManagerLandlordLegalNameFromProfile = vi.fn();
const listApplicationFeeWaiverCodes = vi.fn();
const pickPrimaryApplicationFeeWaiverCode = vi.fn();
const setPrimaryApplicationFeeWaiverCode = vi.fn();
const loadTaskAutomation = vi.fn();
const saveTaskAutomation = vi.fn();

vi.mock("@/lib/manager-route-guard.server", () => ({
  requireManagerRouteUser: () => requireManagerRouteUser(),
}));
vi.mock("@/lib/manager-application-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-application-settings")>();
  return {
    ...actual,
    loadManagerApplicationSettings: (...a: unknown[]) => loadManagerApplicationSettings(...a),
    saveManagerApplicationSettings: (...a: unknown[]) => saveManagerApplicationSettings(...a),
    validateManagerApplicationFeeCents: (...a: unknown[]) => validateManagerApplicationFeeCents(...a),
  };
});
// The leasing pipeline order (48a0d21a8) rides on GET; this suite is about
// automation, so the stored pipeline is the default.
vi.mock("@/lib/leasing-pipeline-preferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/leasing-pipeline-preferences")>();
  return {
    ...actual,
    loadLeasingPipelineState: async () => ({
      portfolio: actual.normalizeLeasingPipelinePreferences(undefined),
      byPropertyId: {},
    }),
  };
});
vi.mock("@/lib/manager-application-settings.server", () => ({
  suggestedManagerApplicationFeeCents: (...a: unknown[]) => suggestedManagerApplicationFeeCents(...a),
}));
vi.mock("@/lib/application-automation-preferences", () => ({
  loadApplicationAutomation: (...a: unknown[]) => loadApplicationAutomation(...a),
  loadApplicationAutomationState: (...a: unknown[]) => loadApplicationAutomationState(...a),
  saveApplicationAutomation: (...a: unknown[]) => saveApplicationAutomation(...a),
  normalizeApplicationAutomation: (raw: unknown) => raw,
}));
// `automation` (the `applicationAutomation` namespace) now resolves through the
// shared scope resolver rather than the old `applicationAutomationByPropertyId`
// sidecar (PLAN-0920-0845) — see the route's own header comment. These tests
// use a bare `{}` for `db`, so the resolver's own database reads (property
// override lookup, workspace row, ownership check) are stubbed out here; this
// file's focus stays "the fee is never silently touched by an automation save".
vi.mock("@/lib/settings/property-overrides.server", () => ({
  savePropertyOverride: (...a: unknown[]) => savePropertyOverride(...a),
  clearPropertyOverride: vi.fn().mockResolvedValue(undefined),
  listPropertyOverrides: vi.fn().mockResolvedValue([]),
  loadPropertyOverride: vi.fn().mockResolvedValue(null),
  ForeignPropertyError: class ForeignPropertyError extends Error {},
}));
vi.mock("@/lib/settings/scope-resolver.server", () => ({
  resolveSettingsScope: vi.fn(
    async (
      db: unknown,
      input: { managerUserId: string },
      _ns: unknown,
      ops: { loadAccount?: (d: unknown, m: string) => Promise<unknown> },
    ) => ({ value: await ops.loadAccount?.(db, input.managerUserId), source: "account" as const }),
  ),
  saveWorkspaceNamespaceSettings: vi.fn().mockResolvedValue(undefined),
  clearWorkspaceNamespaceSettings: vi.fn().mockResolvedValue(undefined),
  createSettingsScopeCache: vi.fn(() => new Map()),
}));
vi.mock("@/lib/scope/settings-scope", () => ({
  parseSettingsScope: vi.fn(() => ({})),
  resolveSettingsScopeParams: vi.fn((_url: string, body?: Record<string, unknown> | null) => {
    const propertyId = typeof body?.propertyId === "string" ? body.propertyId : undefined;
    const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId : undefined;
    return { ...(propertyId ? { propertyId } : {}), ...(workspaceId ? { workspaceId } : {}) };
  }),
  assertSettingsScopeOwned: vi.fn(async (_db: unknown, callerUserId: string, scope: { propertyId?: string; workspaceId?: string }) => ({
    ok: true,
    ownerUserId: callerUserId,
    workspaceId: scope.workspaceId ?? null,
    propertyId: scope.propertyId ?? null,
  })),
  trackSettingsScopeChanged: vi.fn().mockResolvedValue(undefined),
  writeRungFromSource: vi.fn((s: string) => (s === "property" ? "property" : s === "workspace" ? "workspace" : "account")),
}));
// The route now reads the default-task preferences alongside application
// automation, and the guard hands these tests a bare `{}` for `db` — without
// this the GET hits a real `db.from(...)` and 500s.
vi.mock("@/lib/task-automation-preferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/task-automation-preferences")>();
  return {
    ...actual,
    loadTaskAutomation: (...a: unknown[]) => loadTaskAutomation(...a),
    saveTaskAutomation: (...a: unknown[]) => saveTaskAutomation(...a),
  };
});
vi.mock("@/lib/manager-landlord-profile", () => ({
  loadManagerLandlordLegalNameFromProfile: (...a: unknown[]) => loadManagerLandlordLegalNameFromProfile(...a),
}));
vi.mock("@/lib/application-fee-waiver", () => ({
  listApplicationFeeWaiverCodes: (...a: unknown[]) => listApplicationFeeWaiverCodes(...a),
  pickPrimaryApplicationFeeWaiverCode: (...a: unknown[]) => pickPrimaryApplicationFeeWaiverCode(...a),
  setPrimaryApplicationFeeWaiverCode: (...a: unknown[]) => setPrimaryApplicationFeeWaiverCode(...a),
}));

const route = await import("@/app/api/portal/manager-application-settings/route");

const AUTOMATION = {
  autoApproveApplications: true,
  autoGenerateLease: true,
  autoSendLease: false,
};

const TASK_AUTOMATION = {
  review_application: { enabled: true, daysAfterTrigger: 2, defaultAssigneeUserId: null, sendEmailReminder: true },
  review_and_send_lease: { enabled: true, daysAfterTrigger: 2, defaultAssigneeUserId: null, sendEmailReminder: true },
  collect_rent: { enabled: false, daysAfterTrigger: 3, defaultAssigneeUserId: null, sendEmailReminder: false },
};

function patch(body: unknown): Request {
  return new Request("http://localhost/api/portal/manager-application-settings", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireManagerRouteUser.mockResolvedValue({ db: {}, userId: "mgr-1" });
  saveApplicationAutomation.mockResolvedValue(AUTOMATION);
  savePropertyOverride.mockResolvedValue(undefined);
  loadApplicationAutomation.mockResolvedValue(AUTOMATION);
  loadApplicationAutomationState.mockResolvedValue({ portfolio: AUTOMATION, byPropertyId: {} });
  loadTaskAutomation.mockResolvedValue(TASK_AUTOMATION);
  saveTaskAutomation.mockResolvedValue(TASK_AUTOMATION);
  loadManagerLandlordLegalNameFromProfile.mockResolvedValue("Doe Holdings LLC");
  loadManagerApplicationSettings.mockResolvedValue({
    applicationFeeCents: 5000,
    applicationFeeChargePolicy: "first_only",
    applicationFeeOtherEnabled: false,
    applicationFeeOtherInstructions: "",
  });
  saveManagerApplicationSettings.mockResolvedValue({
    applicationFeeCents: 5000,
    applicationFeeChargePolicy: "first_only",
    applicationFeeOtherEnabled: false,
    applicationFeeOtherInstructions: "",
  });
  validateManagerApplicationFeeCents.mockReturnValue({ ok: true, applicationFeeCents: 5000 });
  suggestedManagerApplicationFeeCents.mockResolvedValue(null);
  listApplicationFeeWaiverCodes.mockResolvedValue([]);
  pickPrimaryApplicationFeeWaiverCode.mockReturnValue(null);
});

describe("PATCH automation", () => {
  it("saves automation WITHOUT touching the application fee", async () => {
    const res = await route.PATCH(patch({ automation: AUTOMATION }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      automation: AUTOMATION,
      source: "account",
      scope: "workspace",
      inherited: false,
      overriddenPropertyIds: [],
    });
    expect(saveApplicationAutomation).toHaveBeenCalledWith({}, "mgr-1", AUTOMATION);
    // The load-bearing assertion: the fee was never written, so it still stands.
    expect(saveManagerApplicationSettings).not.toHaveBeenCalled();
  });

  it("still saves both when a request carries automation AND a fee", async () => {
    const res = await route.PATCH(patch({ automation: AUTOMATION, applicationFeeCents: 5000 }));

    expect(res.status).toBe(200);
    expect(saveApplicationAutomation).toHaveBeenCalled();
    expect(saveManagerApplicationSettings).toHaveBeenCalledWith({}, "mgr-1", {
      applicationFeeCents: 5000,
      applicationFeeChargePolicy: "first_only",
    });
  });

  it("ignores an empty PATCH without touching stored fee settings", async () => {
    await route.PATCH(patch({}));

    expect(saveManagerApplicationSettings).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller before writing anything", async () => {
    requireManagerRouteUser.mockResolvedValue(null);

    const res = await route.PATCH(patch({ automation: AUTOMATION }));

    expect(res.status).toBe(401);
    expect(saveApplicationAutomation).not.toHaveBeenCalled();
  });

  it("returns the saved automation on GET", async () => {
    const res = await route.GET(new Request("http://localhost/api/portal/manager-application-settings"));
    expect(await res.json()).toMatchObject({
      automation: AUTOMATION,
      automationState: { portfolio: AUTOMATION, byPropertyId: {} },
      taskAutomation: TASK_AUTOMATION,
    });
  });

  it("saves automation for a property without touching the portfolio default", async () => {
    const res = await route.PATCH(patch({ propertyId: "prop-1", automation: AUTOMATION }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ automation: AUTOMATION, source: "property", scope: "property", inherited: false });
    expect(savePropertyOverride).toHaveBeenCalledWith({}, "mgr-1", "prop-1", "applicationAutomation", AUTOMATION);
    expect(saveApplicationAutomation).not.toHaveBeenCalled();
  });
});
