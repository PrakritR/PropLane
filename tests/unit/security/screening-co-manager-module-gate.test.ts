/**
 * Cross-account authorization fix for the screening routes.
 *
 * `collectLinkedPropertyIdsForUser` returns every `assigned_property_ids`
 * entry from an accepted co-manager link with NO permission check — assigning
 * a property is not a grant (docs/agents/co-manager-access.md "Empty used to
 * mean FULL"). These four routes used it as their whole authorization gate,
 * so a co-manager assigned a property with an EMPTY permission map could
 * still run a paid criminal background check, view the PII report, start a
 * paid checkout, and confirm payment — all attributed to the property owner.
 * They now require `applications` at the right level via
 * `managerHasCoManagerPermissionForProperty`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
const isAdminUser = vi.fn();

const OWNER = "owner-1";
const DELEGATE = "delegate-1";
const PROPERTY = "prop-1";

type LinkRow = {
  inviter_user_id: string;
  invitee_user_id: string;
  assigned_property_ids: string[];
  property_co_manager_permissions?: unknown;
};

let linkRows: LinkRow[] = [];
let applicationRecord: Record<string, unknown> = {};

function makeDb() {
  return {
    from(table: string) {
      const settle = () => {
        if (table === "manager_application_records") return { data: applicationRecord, error: null };
        if (table === "manager_property_records") return { data: { manager_user_id: OWNER }, error: null };
        if (table === "account_link_invites") return { data: linkRows, error: null };
        return { data: null, error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        // Also exercised by the OLD (pre-fix) `collectLinkedPropertyIdsForUser`
        // path's cross-sandbox profile lookup — kept so a manual pre-fix
        // regression check reflects the real vulnerability rather than an
        // unrelated `.in is not a function` throw swallowed by that
        // function's try/catch.
        in: () => builder,
        maybeSingle: async () => settle(),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
      };
      return builder;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: () => getUser() } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => makeDb(),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...a) }));
vi.mock("@/lib/analytics/posthog", () => ({ track: () => undefined }));

const refreshBackgroundCheck = vi.fn();
const runBackgroundCheck = vi.fn();
const precheckBackgroundCheckOrder = vi.fn();
vi.mock("@/lib/checkr/background-check", () => ({
  refreshBackgroundCheck: (...a: unknown[]) => refreshBackgroundCheck(...a),
  refreshCosignerBackgroundCheck: vi.fn(),
  runBackgroundCheck: (...a: unknown[]) => runBackgroundCheck(...a),
  runCosignerBackgroundCheck: vi.fn(),
  precheckBackgroundCheckOrder: (...a: unknown[]) => precheckBackgroundCheckOrder(...a),
  precheckCosignerBackgroundCheckOrder: vi.fn(),
}));

let checkrSkipsManagerCardCharge = false;
vi.mock("@/lib/checkr/config", () => ({
  checkrSkipsManagerCardCharge: () => checkrSkipsManagerCardCharge,
  backgroundCheckConfigured: () => true,
}));

vi.mock("@/lib/checkr/client", () => ({ checkrApiFetch: vi.fn() }));
vi.mock("@/lib/checkr/report-document", () => ({ fetchCheckrReportPdfBytes: vi.fn() }));
const loadCheckrSampleReportPdfBytes = vi.fn(async () => new ArrayBuffer(4));
vi.mock("@/lib/checkr/sample-report-pdf", () => ({
  loadCheckrSampleReportPdfBytes: () => loadCheckrSampleReportPdfBytes(),
}));

vi.mock("@/lib/app-url", () => ({ resolveAppOrigin: () => "http://localhost" }));
vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: vi.fn(async () => ({ stripeCustomerId: null })),
}));

let stripeSessionData: Record<string, unknown> = {};
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { retrieve: async () => stripeSessionData } } }),
}));
vi.mock("@/lib/stripe-screening", () => ({
  SCREENING_CHECKOUT_PURPOSE: "screening",
  isScreeningCheckoutSession: () => true,
}));
vi.mock("@/lib/test-workspaces/effects.server", () => ({
  assertTestWorkspaceProviderEffectAllowed: vi.fn().mockResolvedValue(undefined),
}));

const backgroundCheckRoute = await import("@/app/api/screening/background-check/route");
const documentRoute = await import("@/app/api/screening/background-check/document/route");
const checkoutRoute = await import("@/app/api/screening/checkout/route");
const checkoutVerifyRoute = await import("@/app/api/screening/checkout-verify/route");

function grant(permissions: unknown): LinkRow[] {
  return [
    {
      inviter_user_id: OWNER,
      invitee_user_id: DELEGATE,
      assigned_property_ids: [PROPERTY],
      property_co_manager_permissions: permissions,
    },
  ];
}

function postRequest(url: string, body: Record<string, unknown>) {
  return new Request(url, { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  linkRows = [];
  checkrSkipsManagerCardCharge = false;
  isAdminUser.mockResolvedValue(false);
  getUser.mockResolvedValue({ data: { user: { id: DELEGATE } } });
  applicationRecord = { manager_user_id: OWNER, property_id: PROPERTY, assigned_property_id: null, row_data: {} };
  refreshBackgroundCheck.mockResolvedValue({ ok: true, backgroundCheck: { provider: "checkr" }, row: {} });
  runBackgroundCheck.mockResolvedValue({ ok: true, backgroundCheck: { provider: "checkr" } });
  precheckBackgroundCheckOrder.mockResolvedValue({ ok: true });
  loadCheckrSampleReportPdfBytes.mockResolvedValue(new ArrayBuffer(4));
  stripeSessionData = {
    id: "cs_test_1",
    metadata: { application_id: "app-1", manager_user_id: OWNER },
    payment_status: "paid",
    status: "complete",
    payment_intent: null,
  };
});

describe("POST /api/screening/background-check — co-manager module gate", () => {
  const body = { applicationId: "app-1", action: "refresh" };
  const url = "http://localhost/api/screening/background-check";

  it("refuses a delegate with an EMPTY permission map", async () => {
    linkRows = grant({ [PROPERTY]: {} });
    const res = await backgroundCheckRoute.POST(postRequest(url, body));
    expect(res.status).toBe(403);
    expect(refreshBackgroundCheck).not.toHaveBeenCalled();
  });

  it("refuses a delegate granted `applications` at READ only", async () => {
    linkRows = grant({ [PROPERTY]: { applications: { read: true } } });
    const res = await backgroundCheckRoute.POST(postRequest(url, body));
    expect(res.status).toBe(403);
    expect(refreshBackgroundCheck).not.toHaveBeenCalled();
  });

  it("allows a delegate granted `applications` at EDIT", async () => {
    linkRows = grant({ [PROPERTY]: { applications: { read: true, edit: true } } });
    const res = await backgroundCheckRoute.POST(postRequest(url, body));
    expect(res.status).toBe(200);
    expect(refreshBackgroundCheck).toHaveBeenCalledTimes(1);
  });

  it("still works for the owner with no link rows at all", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER } } });
    const res = await backgroundCheckRoute.POST(postRequest(url, body));
    expect(res.status).toBe(200);
    expect(refreshBackgroundCheck).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/screening/background-check/document — co-manager module gate", () => {
  beforeEach(() => {
    applicationRecord = {
      manager_user_id: OWNER,
      property_id: PROPERTY,
      assigned_property_id: null,
      row_data: { backgroundCheck: { status: "complete", reportId: "r1", simulated: true } },
    };
    checkrSkipsManagerCardCharge = true;
  });

  function req() {
    return new Request("http://localhost/api/screening/background-check/document?applicationId=app-1");
  }

  it("refuses a delegate with an EMPTY permission map", async () => {
    linkRows = grant({ [PROPERTY]: {} });
    const res = await documentRoute.GET(req());
    expect(res.status).toBe(403);
    expect(loadCheckrSampleReportPdfBytes).not.toHaveBeenCalled();
  });

  it("allows a delegate granted `applications` at READ (viewing needs no edit)", async () => {
    linkRows = grant({ [PROPERTY]: { applications: { read: true } } });
    const res = await documentRoute.GET(req());
    expect(res.status).toBe(200);
    expect(loadCheckrSampleReportPdfBytes).toHaveBeenCalledTimes(1);
  });

  it("still works for the owner with no link rows at all", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER } } });
    const res = await documentRoute.GET(req());
    expect(res.status).toBe(200);
  });
});

describe("POST /api/screening/checkout — co-manager module gate", () => {
  beforeEach(() => {
    checkrSkipsManagerCardCharge = true; // simulate mode: shortcut past Stripe entirely.
  });

  const body = { applicationId: "app-1", packageSlug: "essential" };
  const url = "http://localhost/api/screening/checkout";

  it("refuses a delegate with an EMPTY permission map", async () => {
    linkRows = grant({ [PROPERTY]: {} });
    const res = await checkoutRoute.POST(postRequest(url, body));
    expect(res.status).toBe(403);
    expect(runBackgroundCheck).not.toHaveBeenCalled();
  });

  it("refuses a delegate granted `applications` at READ only", async () => {
    linkRows = grant({ [PROPERTY]: { applications: { read: true } } });
    const res = await checkoutRoute.POST(postRequest(url, body));
    expect(res.status).toBe(403);
    expect(runBackgroundCheck).not.toHaveBeenCalled();
  });

  it("allows a delegate granted `applications` at EDIT", async () => {
    linkRows = grant({ [PROPERTY]: { applications: { edit: true } } });
    const res = await checkoutRoute.POST(postRequest(url, body));
    expect(res.status).toBe(200);
    expect(runBackgroundCheck).toHaveBeenCalledTimes(1);
  });

  it("still works for the owner with no link rows at all", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER } } });
    const res = await checkoutRoute.POST(postRequest(url, body));
    expect(res.status).toBe(200);
    expect(runBackgroundCheck).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/screening/checkout-verify — co-manager module gate", () => {
  const body = { sessionId: "cs_test_1" };
  const url = "http://localhost/api/screening/checkout-verify";

  it("refuses a delegate with an EMPTY permission map", async () => {
    linkRows = grant({ [PROPERTY]: {} });
    const res = await checkoutVerifyRoute.POST(postRequest(url, body));
    expect(res.status).toBe(403);
    expect(runBackgroundCheck).not.toHaveBeenCalled();
  });

  it("allows a delegate granted `applications` at EDIT", async () => {
    linkRows = grant({ [PROPERTY]: { applications: { edit: true } } });
    const res = await checkoutVerifyRoute.POST(postRequest(url, body));
    expect(res.status).toBe(200);
    expect(runBackgroundCheck).toHaveBeenCalledTimes(1);
  });

  it("still works for the owner with no link rows at all", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER } } });
    const res = await checkoutVerifyRoute.POST(postRequest(url, body));
    expect(res.status).toBe(200);
    expect(runBackgroundCheck).toHaveBeenCalledTimes(1);
  });
});
