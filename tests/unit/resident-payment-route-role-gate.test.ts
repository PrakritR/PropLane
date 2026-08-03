/**
 * The resident Payments and Add-on services write paths gated on the legacy
 * `profiles.role`, so the captain's manager+resident account could open the
 * sections this branch unlocks and then got 403 reporting a Zelle/Venmo rent
 * payment or nudging a work order. All three now authorize off `profile_roles`
 * through the shared predicate, keeping a legacy `profiles.role='resident'` as
 * an accepted signal.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "user-both";
const EMAIL = "both@example.com";

const getUser = vi.fn();
const isAdminUser = vi.fn(async () => false);
let PROFILE: { email: string; role: string | null; full_name?: string } | null = null;
let PROFILE_ROLES: string[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...(a as [])) }));
vi.mock("@/lib/auth/portal-access", () => ({
  ACTIVE_PORTAL_COOKIE: "axis_active_portal",
  getPortalAccessContext: async () => ({ user: null, profile: null, roles: [], effectiveRole: null }),
}));
vi.mock("@/lib/resident-manual-payment.server", () => ({
  reportResidentManualPayment: vi.fn(async () => ({ ok: true, charges: [] })),
}));
vi.mock("@/lib/resident-check-manual-payment.server", () => ({
  checkResidentManualPayments: vi.fn(async () => ({ ok: true, paid: true, charges: [] })),
}));
vi.mock("@/lib/resident-work-order-reminder.server", () => ({
  deliverResidentWorkOrderReminder: vi.fn(async () => ({ ok: true, recipientCount: 2 })),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

function makeDb() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle() {
          if (table === "profiles") return Promise.resolve({ data: PROFILE, error: null });
          if (table === "profile_roles") {
            return Promise.resolve({
              data: PROFILE_ROLES.includes("resident") ? { role: "resident" } : null,
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  };
}

function jsonRequest(url: string, body: unknown) {
  return new Request(url, { method: "POST", body: JSON.stringify(body) });
}

async function reportManualPayment() {
  const { POST } = await import("@/app/api/portal/resident-report-manual-payment/route");
  return POST(jsonRequest("http://localhost/api/portal/resident-report-manual-payment", {
    channel: "zelle",
    chargeIds: ["charge-1"],
  }));
}

async function checkManualPayment() {
  const { POST } = await import("@/app/api/portal/resident-check-manual-payment/route");
  return POST(jsonRequest("http://localhost/api/portal/resident-check-manual-payment", {
    channel: "zelle",
    chargeIds: ["charge-1"],
  }));
}

async function sendWorkOrderReminder() {
  const { POST } = await import("@/app/api/portal/work-orders/send-reminder/route");
  return POST(jsonRequest("http://localhost/api/portal/work-orders/send-reminder", { workOrderId: "wo-1" }));
}

const ROUTES = [
  { name: "resident-report-manual-payment", call: reportManualPayment, forbidden: "Residents only." },
  { name: "resident-check-manual-payment", call: checkManualPayment, forbidden: "Residents only." },
  { name: "work-orders/send-reminder", call: sendWorkOrderReminder, forbidden: "Forbidden." },
];

beforeEach(() => {
  vi.clearAllMocks();
  isAdminUser.mockResolvedValue(false);
  getUser.mockResolvedValue({ data: { user: { id: USER_ID, email: EMAIL } }, error: null });
});

for (const route of ROUTES) {
  describe(`${route.name} role gate`, () => {
    it("lets a manager+resident account through", async () => {
      PROFILE = { email: EMAIL, role: "manager", full_name: "Both Roles" };
      PROFILE_ROLES = ["manager", "resident"];
      const res = await route.call();
      expect(res.status).toBe(200);
    });

    it("still refuses an account holding no resident role", async () => {
      PROFILE = { email: EMAIL, role: "manager", full_name: "Manager Only" };
      PROFILE_ROLES = ["manager"];
      const res = await route.call();
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: route.forbidden });
    });

    it("still allows a legacy resident with no profile_roles row", async () => {
      PROFILE = { email: EMAIL, role: "resident", full_name: "Legacy Resident" };
      PROFILE_ROLES = [];
      const res = await route.call();
      expect(res.status).toBe(200);
    });

    it("still answers 401 when unauthenticated", async () => {
      PROFILE = null;
      PROFILE_ROLES = [];
      getUser.mockResolvedValue({ data: { user: null }, error: null });
      const res = await route.call();
      expect(res.status).toBe(401);
    });
  });
}
