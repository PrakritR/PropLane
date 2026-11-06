/**
 * A manager's welcome / invite mail (and texts) to a resident, applicant or vendor is OUTBOUND
 * Communication, so a LIVE signup trial gets none until it pays - judged on the workspace OWNER.
 *
 *  - Send-only routes (resident welcome, vendor invite, booking invite) refuse with the helper's
 *    status and message before any side effect.
 *  - Routes that also write a record (existing-resident onboarding, portfolio import) keep the
 *    write, skip the message and answer `communicationBlocked`.
 *
 * Paid -> sent; trial -> 402; unreadable plan -> 503 (fail closed).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Access =
  | { allowed: true }
  | { allowed: false; reason: "trial"; status: 402; message: string }
  | { allowed: false; reason: "plan_unreadable"; status: 503; message: string };

const TRIAL: Access = { allowed: false, reason: "trial", status: 402, message: "Communication is available on a paid plan." };
const UNREADABLE: Access = {
  allowed: false,
  reason: "plan_unreadable",
  status: 503,
  message: "We could not verify your plan. Try again in a moment or contact support.",
};

const m = vi.hoisted(() => ({
  access: { allowed: true } as Access,
  roles: ["manager"] as string[],
  roleError: false,
  forActive: vi.fn(),
  deliverResidentWelcome: vi.fn(),
  sendVendorInvite: vi.fn(),
  sendBookingResidentInvite: vi.fn(),
  runExistingResidentOnboarding: vi.fn(),
  createPortfolioImportRecords: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "mgr-1", email: "mgr@example.com" } } }) },
  }),
}));
function fakeDb() {
  // `userHoldsManagerRole` asks for ONE row, filtered on `role`, so the stand-in has to honour that
  // filter instead of answering every single-row `profile_roles` read with null.
  const resolve = (table: string, many: boolean, filters: Array<[string, unknown]>) => {
    if (table === "profile_roles") {
      if (m.roleError) return { data: null, error: { message: "unavailable" } };
      const wanted = filters.find(([column]) => column === "role")?.[1];
      const rows = m.roles.filter((role) => wanted === undefined || role === wanted).map((role) => ({ role }));
      return { data: many ? rows : rows[0] ?? null, error: null };
    }
    if (table === "profiles") return { data: { role: "manager", full_name: "Alex", email: "mgr@example.com" }, error: null };
    if (table === "manager_application_records") {
      const rec = { id: "APP1", row_data: { id: "APP1", manuallyAdded: true, email: "res@example.com", name: "Res" } };
      return { data: many ? [rec] : rec, error: null };
    }
    return { data: many ? [] : null, error: null };
  };
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const chain: Record<string, unknown> = {};
      for (const k of ["select", "in", "update", "order"]) chain[k] = () => chain;
      chain.eq = (column: string, value: unknown) => {
        filters.push([column, value]);
        return chain;
      };
      chain.limit = async () => resolve(table, true, filters);
      chain.maybeSingle = async () => resolve(table, false, filters);
      chain.then = (fn: (value: unknown) => unknown) => Promise.resolve(resolve(table, true, filters)).then(fn);
      return chain;
    },
  };
}
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => fakeDb() }));
// send-vendor-invite authorizes through profile_roles (getPortalAccessContext / hasRole), not profiles.role.
vi.mock("@/lib/auth/portal-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/portal-access")>()),
  getPortalAccessContext: async () => ({
    user: { id: "mgr-1", email: "mgr@example.com" },
    roles: ["manager"],
    effectiveRole: "manager",
    profile: { role: "manager", full_name: "Alex", email: "mgr@example.com" },
  }),
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: async () => ({ kind: "normal" }),
}));
vi.mock("@/lib/manager-communication-access.server", () => ({
  assertManagerCommunicationAllowedForActiveWorkspace: async (...args: unknown[]) => {
    m.forActive(...args);
    return m.access;
  },
  communicationRefusalBody: (a: { message: string; reason: string }) => ({
    ok: false,
    error: a.message,
    code: `communication_${a.reason}`,
  }),
}));
vi.mock("@/lib/resident-welcome.server", () => ({
  RESIDENT_WELCOME_EMAIL_RE: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  canSendResidentWelcome: () => true,
  deliverResidentWelcome: m.deliverResidentWelcome,
}));
vi.mock("@/lib/vendor-invite.server", () => ({ sendVendorInvite: m.sendVendorInvite }));
vi.mock("@/lib/app-url", () => ({ resolveAppOrigin: () => "https://proplane.test" }));
vi.mock("@/lib/booking-resident-invite.server", () => ({ sendBookingResidentInvite: m.sendBookingResidentInvite }));
vi.mock("@/lib/portal-schedule-record-scope", () => ({
  managerScheduleRecordIdOwnedByUser: () => true,
  ROOM_DATE_BLOCK_RECORD_TYPE: "room_date_block",
}));
vi.mock("@/lib/existing-resident-onboarding.server", () => ({
  runExistingResidentOnboarding: m.runExistingResidentOnboarding,
}));
vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: async () => ({ userId: "mgr-1", email: "mgr@example.com", role: "manager", db: { tag: "db" } }),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/portfolio-import/create.server", () => ({
  createPortfolioImportRecords: m.createPortfolioImportRecords,
  PortfolioImportNotFoundError: class extends Error {},
}));

const { POST: postWelcome } = await import("@/app/api/portal/send-resident-welcome/route");
const { POST: postVendorInvite } = await import("@/app/api/portal/send-vendor-invite/route");
const { POST: postBookingInvite } = await import("@/app/api/portal-bookings/invite-resident/route");
const { POST: postOnboard } = await import("@/app/api/portal/onboard-existing-resident/route");
const { POST: postImport } = await import("@/app/api/portal/portfolio-import/[importId]/create/route");

const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  m.access = { allowed: true };
  m.roles = ["manager"]; m.roleError = false;
  for (const fn of Object.values(m)) if (typeof fn === "function" && "mockReset" in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  m.deliverResidentWelcome.mockResolvedValue({ ok: true, id: "e1", skipped: false });
  m.sendVendorInvite.mockResolvedValue({ ok: true, emailId: "e2", linkUrl: "https://proplane.test/i" });
  m.sendBookingResidentInvite.mockResolvedValue({ ok: true, channel: "email", message: "sent", axisId: "A", attachedExisting: false });
  m.runExistingResidentOnboarding.mockResolvedValue({
    ok: true,
    leaseId: "lease_1",
    axisId: "APP1",
    welcomeEmailSent: false,
    row: {},
  });
  m.createPortfolioImportRecords.mockResolvedValue({
    created: { properties: 1, rooms: 1, residents: 1, leases: 1, charges: 0, tasks: 0, invites: 0 },
    failures: [],
  });
});

const denied: Array<[string, Access]> = [
  ["a live trial", TRIAL],
  ["an unreadable plan", UNREADABLE],
];

describe("send-only routes refuse before any side effect", () => {
  const cases: Array<[string, () => Promise<Response>, () => ReturnType<typeof vi.fn>]> = [
    [
      "POST /api/portal/send-resident-welcome",
      () => postWelcome(post("https://x.test/api/portal/send-resident-welcome", { to: "res@example.com", axisId: "APP1" })),
      () => m.deliverResidentWelcome,
    ],
    [
      "POST /api/portal/send-vendor-invite",
      () =>
        postVendorInvite(
          post("https://x.test/api/portal/send-vendor-invite", { vendorId: "v1", vendorEmail: "v@example.com", vendorName: "V" }),
        ),
      () => m.sendVendorInvite,
    ],
    [
      "POST /api/portal-bookings/invite-resident",
      () =>
        postBookingInvite(
          post("https://x.test/api/portal-bookings/invite-resident", {
            blockId: "b1",
            propertyId: "p1",
            residentName: "Res",
            residentEmail: "res@example.com",
          }),
        ),
      () => m.sendBookingResidentInvite,
    ],
  ];

  for (const [name, call, sender] of cases) {
    describe(name, () => {
      it.each(denied)("refuses %s with the helper's status and message", async (_label, access) => {
        m.access = access;
        const res = await call();
        expect(res.status).toBe(access.allowed === false ? access.status : 0);
        expect(await res.json()).toMatchObject({
          error: access.allowed === false ? access.message : "",
          code: access.allowed === false ? `communication_${access.reason}` : "",
        });
        expect(sender()).not.toHaveBeenCalled();
      });

      it("sends for a paid owner, judged on the acting manager's active workspace", async () => {
        const res = await call();
        expect(res.status).toBe(200);
        expect(sender()).toHaveBeenCalledTimes(1);
        expect(m.forActive).toHaveBeenCalledWith(expect.anything(), "mgr-1");
      });
    });
  }
});

describe("POST /api/portal/onboard-existing-resident - record write kept, welcome skipped", () => {
  const call = (extra: Record<string, unknown> = {}) =>
    postOnboard(post("https://x.test/api/portal/onboard-existing-resident", { applicationId: "APP1", ...extra }));

  it.each(denied)("on %s still onboards but turns the welcome off and says why", async (_label, access) => {
    m.access = access;
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      leaseId: "lease_1",
      welcomeEmailSent: false,
      communicationBlocked: access.allowed === false ? access.reason : undefined,
    });
    expect(m.runExistingResidentOnboarding).toHaveBeenCalledTimes(1);
    expect(m.runExistingResidentOnboarding.mock.calls[0][3]).toMatchObject({ sendWelcomeEmail: false });
  });

  it("sends the welcome for a paid owner and reports no block", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("communicationBlocked");
    expect(m.runExistingResidentOnboarding.mock.calls[0][3]).toMatchObject({ sendWelcomeEmail: true });
  });

  it("does not consult the plan when the manager asked for no welcome", async () => {
    m.access = TRIAL;
    const res = await call({ sendWelcomeEmail: false });
    expect(await res.json()).not.toHaveProperty("communicationBlocked");
    expect(m.forActive).not.toHaveBeenCalled();
    expect(m.runExistingResidentOnboarding.mock.calls[0][3]).toMatchObject({ sendWelcomeEmail: false });
  });
});

describe("POST /api/portal/portfolio-import/[importId]/create - import kept, invites skipped", () => {
  const call = (sendInvites: boolean) =>
    postImport(post("https://x.test/api/portal/portfolio-import/imp-1/create", { sendInvites }), {
      params: Promise.resolve({ importId: "imp-1" }),
    });

  it.each(denied)("on %s imports without invites and says why", async (_label, access) => {
    m.access = access;
    const res = await call(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      communicationBlocked: access.allowed === false ? access.reason : undefined,
    });
    expect(m.createPortfolioImportRecords.mock.calls[0][3]).toMatchObject({ sendInvites: false });
  });

  it("sends invites for a paid owner", async () => {
    const res = await call(true);
    expect(await res.json()).not.toHaveProperty("communicationBlocked");
    expect(m.createPortfolioImportRecords.mock.calls[0][3]).toMatchObject({ sendInvites: true });
  });

  it("does not consult the plan when no invites were requested", async () => {
    m.access = TRIAL;
    const res = await call(false);
    expect(await res.json()).not.toHaveProperty("communicationBlocked");
    expect(m.forActive).not.toHaveBeenCalled();
  });
});

 it("vendor invite refuses legacy-only manager role and unreadable roles", async () => {
  const request = () => post("https://x.test/api/portal/send-vendor-invite", { vendorId: "v1", vendorEmail: "v@example.com", vendorName: "V" });
  m.roles = []; expect((await postVendorInvite(request())).status).toBe(403);
  m.roles = ["manager"]; m.roleError = true; expect((await postVendorInvite(request())).status).toBe(403);
  expect(m.sendVendorInvite).not.toHaveBeenCalled();
});
