/**
 * Co-manager module gate for the six workspace settings routes
 * (`manager-tour-settings`, `automation-settings`, `tour-reminders`,
 * `manager-manual-payment-settings`, `reminder-settings`,
 * `task-automation-settings`).
 *
 * IMPORTANT ARCHITECTURE NOTE — read before extending this file: every
 * table these six routes read/write is keyed ONE ROW PER MANAGER, primary
 * keyed on `manager_user_id` (e.g. `manager_automation_settings`,
 * `supabase/migrations/20260628120001_payment_automation_settings.sql`), and
 * every load/save call in the underlying libs is `.eq("manager_user_id",
 * ctx.userId)` with `ctx.userId` always the CALLING user's own id — none of
 * these six routes accept a parameter naming a different manager to act on
 * behalf of. So today a caller (owner or co-manager) can only ever reach
 * THEIR OWN row through these routes; there is no existing request shape
 * that reaches another manager's settings row, which means
 * `assertCoManagerModuleAccess` (called with no property/owner target, the
 * only shape these routes can produce) always resolves `{ ok: true }` for a
 * real, unmocked call — see `src/lib/auth/manager-settings-module-access.server.ts`.
 *
 * That is why "a co-manager with the module grant" and "the owner" are the
 * SAME case at the route level here: the real (unmocked)
 * `assertCoManagerModuleAccess` cannot tell them apart given what these
 * routes pass it, so the "allows / owner succeeds" test below exercises the
 * REAL production helper (not a stub) and doubles as both assertions. The
 * "refuses a co-manager without the grant" test overrides the mock to
 * return `{ ok: false }`, which proves the route is correctly WIRED to obey
 * a refusal — the wiring is real and verified even though no current
 * request can trigger a real refusal (this is the honest limit of what is
 * testable here; see the worker report for the full explanation).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const getUser = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));

function authDb() {
  return {
    from(table: string) {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { role: "manager", full_name: "Manager", email: "m@test.com" } }),
            }),
          }),
        };
      }
      if (table === "profile_roles") {
        return { select: () => ({ eq: async () => ({ data: [{ role: "manager" }] }) }) };
      }
      throw new Error(`authDb: unexpected table "${table}"`);
    },
  };
}
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => authDb() }));

// Wrap (never replace) the real assertCoManagerModuleAccess: by default every
// call exercises the REAL production logic (proving the owner/self path is
// genuinely unaffected), and individual tests override it with
// mockResolvedValueOnce to prove the refusal path is obeyed.
vi.mock("@/lib/auth/co-manager-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/co-manager-access")>();
  return { ...actual, assertCoManagerModuleAccess: vi.fn(actual.assertCoManagerModuleAccess) };
});

vi.mock("@/lib/manager-tour-settings", () => ({
  loadManagerTourSettings: vi.fn().mockResolvedValue({ tourNoticeDays: 0 }),
  saveManagerTourSettings: vi.fn().mockResolvedValue({ tourNoticeDays: 2 }),
  normalizeManagerTourSettings: vi.fn((s: unknown) => s ?? { tourNoticeDays: 0 }),
}));

vi.mock("@/lib/task-lifecycle-automation.server", () => ({
  loadLifecycleAutomation: vi.fn().mockResolvedValue({}),
  saveLifecycleAutomation: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/tour-reminder.server", () => ({
  reconcileDuplicateTourReminders: vi.fn().mockResolvedValue(undefined),
  findTourReminderForPlannedEvent: vi.fn().mockResolvedValue(null),
  listTourRemindersForPlannedEvent: vi.fn().mockResolvedValue([]),
  cancelTourReminderForPlannedEvent: vi.fn().mockResolvedValue(undefined),
  upsertTourReminderForPlannedEvent: vi.fn().mockResolvedValue({ id: "reminder_1" }),
}));

vi.mock("@/lib/manager-manual-payment-settings", () => ({
  loadManagerManualPaymentSettings: vi.fn().mockResolvedValue({}),
  managerManualPaymentSettingsPublic: vi.fn((s: unknown) => s),
  isValidZelleContact: vi.fn().mockReturnValue(true),
  normalizeManagerManualPaymentSettings: vi.fn((s: unknown) => s),
  resolveSavedServiceFeeSelection: vi.fn().mockReturnValue({ serviceFeePayer: null }),
  saveManagerManualPaymentSettings: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/manager-manual-payment-settings.server", () => ({
  applyManagerManualPaymentsToListings: vi.fn().mockResolvedValue({ listingsUpdated: 0, chargesUpdated: 0 }),
  applyPropertyServiceFeePayersToListings: vi.fn().mockResolvedValue({ listingsUpdated: 0 }),
  loadPropertyServiceFeePayers: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: vi.fn().mockResolvedValue({ readFailed: false, promoCode: null }),
}));
vi.mock("@/lib/workspace-payment-settings.server", () => ({
  loadWorkspacePaymentSettings: vi.fn().mockResolvedValue({}),
  saveWorkspacePaymentSettings: vi.fn().mockResolvedValue({ saved: true }),
  workspaceAutopayEnabled: vi.fn().mockReturnValue(true),
  workspaceAutopayRetryEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/payment-automation-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payment-automation-settings")>();
  return {
    ...actual,
    loadManagerAutomationSettings: vi.fn().mockResolvedValue({}),
    saveManagerAutomationSettings: vi.fn().mockResolvedValue({}),
    normalizeManagerAutomationSettings: vi.fn((s: unknown) => s),
  };
});
vi.mock("@/lib/payment-reminder-lifecycle.server", () => ({
  clearReminderOverridesForUnpaidCharges: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/vendor-dispatch-settings", () => ({
  loadVendorDispatchSettings: vi.fn().mockResolvedValue({}),
  saveVendorDispatchSettings: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/reminders/settings.server", () => ({
  loadReminderSettings: vi.fn().mockResolvedValue({ rules: {}, quietHours: { enabled: false } }),
  saveReminderSettings: vi.fn().mockResolvedValue({ rules: {}, quietHours: { enabled: false } }),
  // PLAN-0916-1040: `reminder-settings/route.ts` references this unconditionally
  // (it is `resolveOperationsOverride`'s `mergeOverride` option on every call,
  // property-scoped or not), so a mock that omits it throws on import access
  // even though the mocked `resolveOperationsOverride` below never calls it.
  mergeReminderSettingsOverride: vi.fn((workspace: unknown) => workspace),
}));

// PLAN-0916-1040: the per-property override store is exercised by the routes on
// every path but is not what this gating test asserts — stub it so the module
// gate (assertCoManagerModuleAccess) is the only thing under test. The workspace
// scope (propertyId null) still flows through the real loaders above.
vi.mock("@/lib/settings/property-overrides.server", () => ({
  resolveOperationsOverride: vi.fn(
    async (
      _db: unknown,
      _uid: unknown,
      _pid: unknown,
      _ns: unknown,
      ops: { loadWorkspace: () => Promise<unknown> },
    ) => ({ settings: await ops.loadWorkspace(), scope: "workspace", inherited: false }),
  ),
  listPropertyOverrides: vi.fn().mockResolvedValue([]),
  savePropertyOverride: vi.fn().mockResolvedValue(undefined),
  clearPropertyOverride: vi.fn().mockResolvedValue(undefined),
  loadPropertyOverride: vi.fn().mockResolvedValue(null),
  loadPropertyOverridesForManagers: vi.fn().mockResolvedValue(new Map()),
  ForeignPropertyError: class ForeignPropertyError extends Error {},
}));

import { assertCoManagerModuleAccess } from "@/lib/auth/co-manager-access";
import { GET as tourSettingsGet, PATCH as tourSettingsPatch } from "@/app/api/portal/manager-tour-settings/route";
import { GET as taskAutomationGet, PATCH as taskAutomationPatch } from "@/app/api/portal/task-automation-settings/route";
import { GET as tourRemindersGet, PUT as tourRemindersPut } from "@/app/api/portal/tour-reminders/route";
import { GET as manualPaymentGet, PATCH as manualPaymentPatch } from "@/app/api/portal/manager-manual-payment-settings/route";
import { GET as automationGet, PATCH as automationPatch } from "@/app/api/portal/automation-settings/route";
import { GET as reminderSettingsGet, PATCH as reminderSettingsPatch } from "@/app/api/portal/reminder-settings/route";

const USER_ID = "manager_1";
const DENIED = { ok: false as const, status: 403 as const, error: "You do not have access to this section for this property." };

type Handler = (req: Request) => Promise<Response>;

/** Runs the shared refuse/allow matrix for one route+method against `assertCoManagerModuleAccess`. */
async function expectGatedRoute(
  handler: Handler,
  makeReq: () => Request,
  expectedModule: string,
  expectedLevel: "read" | "edit",
) {
  // A co-manager without the module grant is refused with the reference
  // route's own status/error shape.
  vi.mocked(assertCoManagerModuleAccess).mockResolvedValueOnce(DENIED);
  const denied = await handler(makeReq());
  expect(denied.status).toBe(403);
  const deniedBody = await denied.json();
  expect(deniedBody.error).toBe(DENIED.error);

  // A co-manager WITH the grant (and, identically here, the owner — see file
  // doc comment) succeeds through the REAL assertCoManagerModuleAccess.
  const callsBefore = vi.mocked(assertCoManagerModuleAccess).mock.calls.length;
  const allowed = await handler(makeReq());
  expect(allowed.status).toBe(200);

  // Wiring: the FIRST module check this call made used the correct module
  // key and permission level (a multi-module route like reminder-settings'
  // full GET checks several in sequence; only the first is asserted here).
  const call = vi.mocked(assertCoManagerModuleAccess).mock.calls[callsBefore]!;
  expect(call[3]).toBe(expectedModule);
  expect(call[4]).toMatchObject({ level: expectedLevel });
}

describe("manager settings routes are gated by co-manager module access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: { id: USER_ID, email: "m@test.com" } } });
  });

  describe("manager-tour-settings — calendar module", () => {
    it("GET: refuses without the grant, allows with it / as owner", async () => {
      await expectGatedRoute(
        tourSettingsGet as Handler,
        () => jsonRequest("http://localhost/api/portal/manager-tour-settings"),
        "calendar",
        "read",
      );
    });
    it("PATCH: refuses without the grant, allows with it / as owner", async () => {
      await expectGatedRoute(
        tourSettingsPatch as Handler,
        () => jsonRequest("http://localhost/api/portal/manager-tour-settings", { method: "PATCH", body: { tourNoticeDays: 1 } }),
        "calendar",
        "edit",
      );
    });
  });

  describe("task-automation-settings — calendar module (REMINDER_SUBJECT_CO_MANAGER_MODULE.task)", () => {
    it("GET: refuses without the grant, allows with it / as owner", async () => {
      await expectGatedRoute(
        taskAutomationGet as Handler,
        () => jsonRequest("http://localhost/api/portal/task-automation-settings"),
        "calendar",
        "read",
      );
    });
    it("PATCH: refuses without the grant, allows with it / as owner", async () => {
      await expectGatedRoute(
        taskAutomationPatch as Handler,
        () => jsonRequest("http://localhost/api/portal/task-automation-settings", { method: "PATCH", body: { automation: {} } }),
        "calendar",
        "edit",
      );
    });
  });

  describe("tour-reminders — calendar module", () => {
    it("GET: refuses without the grant, allows with it / as owner", async () => {
      await expectGatedRoute(
        tourRemindersGet as Handler,
        () => jsonRequest("http://localhost/api/portal/tour-reminders?plannedEventId=evt_1"),
        "calendar",
        "read",
      );
    });
    it("PUT: refuses without the grant, allows with it / as owner", async () => {
      await expectGatedRoute(
        tourRemindersPut as Handler,
        () =>
          jsonRequest("http://localhost/api/portal/tour-reminders", {
            method: "PUT",
            body: {
              plannedEventId: "evt_1",
              tourStartIso: "2026-09-20T17:00:00.000Z",
              tourEndIso: "2026-09-20T17:30:00.000Z",
              recipientEmail: "prospect@test.com",
            },
          }),
        "calendar",
        "edit",
      );
    });
  });

  describe("manager-manual-payment-settings — payments module", () => {
    it("GET: refuses without the grant, allows with it / as owner", async () => {
      await expectGatedRoute(
        manualPaymentGet as Handler,
        () => jsonRequest("http://localhost/api/portal/manager-manual-payment-settings"),
        "payments",
        "read",
      );
    });
    it("PATCH: refuses without the grant, allows with it / as owner", async () => {
      await expectGatedRoute(
        manualPaymentPatch as Handler,
        () => jsonRequest("http://localhost/api/portal/manager-manual-payment-settings", { method: "PATCH", body: {} }),
        "payments",
        "edit",
      );
    });
  });

  describe("automation-settings — whole-surface fallback on payments (mixes payments/calendar/services/inbox with no per-field kind tag)", () => {
    it("GET: refuses without the grant, allows with it / as owner", async () => {
      await expectGatedRoute(
        automationGet as Handler,
        () => jsonRequest("http://localhost/api/portal/automation-settings"),
        "payments",
        "read",
      );
    });
    it("PATCH: refuses without the grant, allows with it / as owner", async () => {
      await expectGatedRoute(
        automationPatch as Handler,
        () => jsonRequest("http://localhost/api/portal/automation-settings", { method: "PATCH", body: {} }),
        "payments",
        "edit",
      );
    });
  });

  describe("reminder-settings — per reminder kind, via REMINDER_SUBJECT_CO_MANAGER_MODULE", () => {
    it("GET: refuses without read on every subject's module, allows with it / as owner", async () => {
      await expectGatedRoute(
        reminderSettingsGet as Handler,
        () => jsonRequest("http://localhost/api/portal/reminder-settings"),
        // GET always returns every subject's rule, so the first module the
        // (order-preserving, deduped) set checks is REMINDER_SUBJECT_KINDS[0]
        // = "tour" -> "calendar".
        "calendar",
        "read",
      );
    });
    it("PATCH (single kind): authorizes exactly the named kind's module", async () => {
      await expectGatedRoute(
        reminderSettingsPatch as Handler,
        () =>
          jsonRequest("http://localhost/api/portal/reminder-settings", {
            method: "PATCH",
            body: { kind: "payment_manager", rule: { enabled: true, leadMinutes: [60] } },
          }),
        "payments",
        "edit",
      );
    });
    it("PATCH (bulk rules merge): rejects the whole request if ANY named kind's module is refused", async () => {
      vi.mocked(assertCoManagerModuleAccess).mockResolvedValueOnce(DENIED);
      const res = await reminderSettingsPatch(
        jsonRequest("http://localhost/api/portal/reminder-settings", {
          method: "PATCH",
          body: {
            settings: {
              rules: {
                tour: { enabled: true, leadMinutes: [30] },
                payment_manager: { enabled: true, leadMinutes: [60] },
              },
            },
          },
        }) as unknown as Request,
      );
      expect(res.status).toBe(403);
      // Refused on the first touched kind's module ("tour" -> "calendar");
      // the second kind is never even checked, let alone saved.
      expect(vi.mocked(assertCoManagerModuleAccess)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(assertCoManagerModuleAccess).mock.calls[0]![3]).toBe("calendar");
    });
  });
});
