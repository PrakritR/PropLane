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
const saveApplicationAutomation = vi.fn();
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
vi.mock("@/lib/manager-application-settings.server", () => ({
  suggestedManagerApplicationFeeCents: (...a: unknown[]) => suggestedManagerApplicationFeeCents(...a),
}));
vi.mock("@/lib/application-automation-preferences", () => ({
  loadApplicationAutomation: (...a: unknown[]) => loadApplicationAutomation(...a),
  saveApplicationAutomation: (...a: unknown[]) => saveApplicationAutomation(...a),
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
  loadApplicationAutomation.mockResolvedValue(AUTOMATION);
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
    expect(await res.json()).toEqual({ automation: AUTOMATION });
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
      applicationFeeOtherEnabled: false,
      applicationFeeOtherInstructions: "",
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
    const res = await route.GET();
    expect(await res.json()).toMatchObject({ automation: AUTOMATION, taskAutomation: TASK_AUTOMATION });
  });
});
