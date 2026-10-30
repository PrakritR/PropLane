// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MANAGER = "mgr-assistant-email";

const { MY_WS, SHARED_WS } = vi.hoisted(() => ({
  MY_WS: { id: "ws-mine", name: "My workspace", ownerUserId: "mgr-assistant-email", owned: true, isDefault: true, propertyIds: [] as string[] },
  SHARED_WS: { id: "ws-owner-1", name: "Jane's workspace", ownerUserId: "owner-1", owned: false, isDefault: true, propertyIds: ["house-1"] },
}));

const mocks = vi.hoisted(() => ({
  /** The switcher's active workspace, as the route resolves it from the request. */
  activeWorkspace: null as null | Record<string, unknown>,
  requireManagerRouteUser: vi.fn(),
  getManagerPortalNavSubscriptionTier: vi.fn(),
  getEffectiveManagerSmsEntitlement: vi.fn(),
  reconcileManagerSmsEntitlement: vi.fn(),
  loadManagerAssistantEmail: vi.fn(),
  ensureManagerAssistantEmail: vi.fn(),
  ensureOwnedWorkspaceAssistantEmails: vi.fn(),
  isAssistantEmailProvisioningEnabled: vi.fn(),
  isPureCoManagerWorkspace: vi.fn(),
  probeAssistantEmailStorageReady: vi.fn(),
  resolveWorkspaceWorkEmails: vi.fn(),
  checkWorkspaceAssistantMailboxLocal: vi.fn(),
  setWorkspaceAssistantMailboxLocal: vi.fn(),
  authorizeServiceWorkEmailEdit: vi.fn(),
  setServiceWorkspaceWorkEmail: vi.fn(),
  rateLimit: vi.fn(),
  track: vi.fn(),
}));

// The route reaches the Service layer only through the one reviewed bridge (`tests/unit/admin-service-guards.test.ts`
// § never lets a manager route reach the Service layer), so the bridge is what this route test stands in for.
vi.mock("@/lib/service/service-mode.server", () => ({
  authorizeServiceWorkEmailEditForManagerRoute: mocks.authorizeServiceWorkEmailEdit,
  setServiceWorkspaceWorkEmailForManagerRoute: mocks.setServiceWorkspaceWorkEmail,
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));

vi.mock("@/lib/manager-route-guard.server", () => ({
  requireManagerRouteUser: mocks.requireManagerRouteUser,
}));

vi.mock("@/lib/manager-access-server", () => ({
  getManagerPortalNavSubscriptionTier: mocks.getManagerPortalNavSubscriptionTier,
}));

vi.mock("@/lib/sms/manager-sms-entitlement.server", () => ({
  getEffectiveManagerSmsEntitlement: mocks.getEffectiveManagerSmsEntitlement,
  reconcileManagerSmsEntitlement: mocks.reconcileManagerSmsEntitlement,
}));

const { WorkspaceEmailSharedError, WorkspaceNotOwnedError } = vi.hoisted(() => ({
  WorkspaceEmailSharedError: class WorkspaceEmailSharedError extends Error {
    readonly code = "workspace_email_shared";
  },
  WorkspaceNotOwnedError: class WorkspaceNotOwnedError extends Error {
    readonly code = "workspace_not_owned";
  },
}));

vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({
  loadWorkspaceAssistantEmail: mocks.loadManagerAssistantEmail,
  ensureManagerAssistantEmail: mocks.ensureManagerAssistantEmail,
  ensureOwnedWorkspaceAssistantEmails: mocks.ensureOwnedWorkspaceAssistantEmails,
  isAssistantEmailProvisioningEnabled: mocks.isAssistantEmailProvisioningEnabled,
  // Same env reads as the real module, so vi.stubEnv keeps driving the states.
  isAssistantEmailSendingEnabled: () => Boolean(process.env.RESEND_API_KEY?.trim()),
  isAssistantEmailReceivingEnabled: () =>
    process.env.VERCEL ? Boolean(process.env.RESEND_INBOUND_WEBHOOK_SECRET?.trim()) : true,
  isAssistantEmailStorageError: (error: { code?: string; message?: string }) =>
    error.code === "PGRST205" || /manager_assistant_emails/i.test(error.message ?? ""),
  probeAssistantEmailStorageReady: mocks.probeAssistantEmailStorageReady,
  resolveWorkspaceWorkEmails: mocks.resolveWorkspaceWorkEmails,
  checkWorkspaceAssistantMailboxLocal: mocks.checkWorkspaceAssistantMailboxLocal,
  setWorkspaceAssistantMailboxLocal: mocks.setWorkspaceAssistantMailboxLocal,
  WorkspaceEmailSharedError,
  WorkspaceNotOwnedError,
}));

vi.mock("@/lib/workspaces/active.server", () => ({
  resolveActiveWorkspaceFromRequest: async () => mocks.activeWorkspace ?? MY_WS,
  resolveWorkspaceFromSettingsRequest: async (
    _db: unknown,
    _userId: string,
    request?: Request,
    bodyWorkspaceId?: string | null,
  ) => {
    const fromBody = bodyWorkspaceId?.trim() || "";
    let fromQuery = "";
    if (request) {
      try {
        fromQuery = new URL(request.url).searchParams.get("workspaceId")?.trim() || "";
      } catch {
        fromQuery = "";
      }
    }
    const selected = fromBody || fromQuery;
    if (selected === SHARED_WS.id) return SHARED_WS;
    if (selected === MY_WS.id) return MY_WS;
    return mocks.activeWorkspace ?? MY_WS;
  },
}));

vi.mock("@/lib/analytics/posthog", () => ({
  track: mocks.track,
}));

import { GET, POST } from "@/app/api/manager/assistant-email/route";

function dbFor(options: { entitlementRow?: boolean } = {}) {
  const tables = {
    sms_manager_entitlements: options.entitlementRow
      ? [{ manager_user_id: MANAGER }]
      : [],
  };
  return {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: (_col: string, value: string) => ({
          maybeSingle: async () => {
            if (table === "sms_manager_entitlements") {
              const row = tables.sms_manager_entitlements.find(
                (entry) => entry.manager_user_id === value,
              );
              return { data: row ?? null, error: null };
            }
            return { data: null, error: null };
          },
        }),
      };
      return chain;
    },
  };
}

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireManagerRouteUser.mockResolvedValue({ db: dbFor(), userId: MANAGER });
  mocks.getManagerPortalNavSubscriptionTier.mockResolvedValue("paid");
  mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue({
    eligible: false,
    reason: "plan_unreadable",
  });
  mocks.reconcileManagerSmsEntitlement.mockResolvedValue({
    eligible: true,
    tier: "pro",
    source: "stripe",
  });
  mocks.loadManagerAssistantEmail.mockResolvedValue(null);
  mocks.ensureManagerAssistantEmail.mockResolvedValue({
    managerUserId: MANAGER,
    inboxToken: "tok123456789",
    address: "assistant+tok123456789@prop-lane.space",
    provisionState: "active",
  });
  mocks.ensureOwnedWorkspaceAssistantEmails.mockResolvedValue({ minted: 0 });
  mocks.isAssistantEmailProvisioningEnabled.mockReturnValue(true);
  mocks.probeAssistantEmailStorageReady.mockResolvedValue(true);
  mocks.activeWorkspace = null;
  mocks.resolveWorkspaceWorkEmails.mockResolvedValue({ role: "primary", emails: [] });
  mocks.rateLimit.mockResolvedValue({ ok: true });
  mocks.authorizeServiceWorkEmailEdit.mockResolvedValue({ ok: false, status: 404, error: "Service workspace not found." });
  mocks.checkWorkspaceAssistantMailboxLocal.mockResolvedValue({ ok: true, state: "available" });
  mocks.setWorkspaceAssistantMailboxLocal.mockResolvedValue({ ok: true, address: "frontdesk@proplane.ai" });
  mocks.setServiceWorkspaceWorkEmail.mockResolvedValue({ ok: true, address: "frontdesk@proplane.ai" });
});

/**
 * The work email answers eligibility EXACTLY as the work number does.
 *
 * This used to be the opposite: an eligible trial was demoted to
 * `{eligible:false, reason:"trialing"}` before the route ever saw it, and the
 * entitlement was read with `preferPaid`. So with trial onboarding open, the
 * same manager could set up a work number and then be refused the email — one
 * product, two answers. `decideManagerCommsRequest` is now the single authority
 * for both, and `reconcileTrialEntitlement` remains the only thing that decides
 * whether a trial is enrolled at all.
 */
describe("work-email eligibility matches the work number", () => {
  it.each([false, true])("accepts an enrolled trial grant with existing address=%s", async (existing) => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    const trial = { eligible: true, tier: "pro", source: "stripe", trial: true };
    mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue(trial);
    mocks.reconcileManagerSmsEntitlement.mockResolvedValue(trial);
    mocks.loadManagerAssistantEmail.mockResolvedValue(existing ? { address: "assistant@test.invalid", workspaceId: "ws-mine" } : null);
    expect(await (await GET(new Request("http://localhost"))).json()).toMatchObject({
      canRequest: !existing,
      canUse: existing,
      entitlement: { eligible: true },
    });
    const response = await POST(new Request("https://prop-lane.test/api/manager/assistant-email", {
      method: "POST", body: JSON.stringify({ action: "request_address" }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.ensureManagerAssistantEmail).toHaveBeenCalledTimes(existing ? 0 : 1);
  });

  it("still refuses a trial the billing source did not enrol", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    const notEnrolled = { eligible: false, reason: "trialing" };
    mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue(notEnrolled);
    mocks.reconcileManagerSmsEntitlement.mockResolvedValue(notEnrolled);
    mocks.loadManagerAssistantEmail.mockResolvedValue(null);
    expect(await (await GET(new Request("http://localhost"))).json()).toMatchObject({ canRequest: false, canUse: false });
    const response = await POST(new Request("https://prop-lane.test/api/manager/assistant-email", {
      method: "POST", body: JSON.stringify({ action: "request_address" }),
    }));
    expect(response.status).toBe(403);
    expect(mocks.ensureManagerAssistantEmail).not.toHaveBeenCalled();
  });

  it.each(["stripe", "apple"])("preserves use for active %s paid or comp grants", async (source) => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue({ eligible: true, tier: "business", source });
    mocks.loadManagerAssistantEmail.mockResolvedValue({ address: "assistant@test.invalid", workspaceId: "ws-mine" });
    expect(await (await GET(new Request("http://localhost"))).json()).toMatchObject({ canUse: true });
  });

  /**
   * An address that exists but cannot send is NOT "ready". It used to report
   * ready and was handed to residents and listings, where it silently swallowed
   * every message.
   */
  it("reports an address it cannot send from as assigned, not ready", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue({ eligible: true, tier: "pro", source: "stripe" });
    mocks.loadManagerAssistantEmail.mockResolvedValue({ address: "assistant@test.invalid", workspaceId: "ws-mine" });
    expect(await (await GET(new Request("http://localhost"))).json()).toMatchObject({
      state: "assigned_send_off",
      canUse: false,
    });
  });

  /**
   * The two ways the same address goes quiet must not read the same. Telling a
   * manager "this is a PropLane setting, not something to chase" when the truth
   * is their card expired sends them to support instead of to billing.
   */
  it("separates a deployment with mail off from a lapsed plan", async () => {
    mocks.loadManagerAssistantEmail.mockResolvedValue({ address: "assistant@test.invalid", workspaceId: "ws-mine" });

    vi.stubEnv("RESEND_API_KEY", "");
    mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue({ eligible: true, tier: "pro", source: "stripe" });
    expect(await (await GET(new Request("http://localhost"))).json()).toMatchObject({ state: "assigned_send_off", canUse: false });

    vi.stubEnv("RESEND_API_KEY", "test-key");
    mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue({ eligible: false, reason: "past_due" });
    expect(await (await GET(new Request("http://localhost"))).json()).toMatchObject({ state: "assigned_plan_hold", canUse: false });
  });
});

describe("GET /api/manager/assistant-email", () => {
  it("returns status for an authenticated manager", async () => {
    const response = await GET(new Request("http://localhost"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      canRequest: true,
      planTier: "paid",
      address: null,
    });
  });
});

describe("POST /api/manager/assistant-email", () => {
  it("provisions an address after entitlement reconciliation", async () => {
    const response = await POST(
      new Request("https://prop-lane.test/api/manager/assistant-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "request_address" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.reconcileManagerSmsEntitlement).toHaveBeenCalled();
    expect(mocks.ensureManagerAssistantEmail).toHaveBeenCalled();
    expect(mocks.track).toHaveBeenCalledWith("assistant_email_requested", MANAGER, {});
  });

  it("returns a readable error when the plan is still free after reconciliation", async () => {
    mocks.reconcileManagerSmsEntitlement.mockResolvedValue({
      eligible: false,
      reason: "free",
    });
    mocks.getManagerPortalNavSubscriptionTier.mockResolvedValue("free");

    const response = await POST(
      new Request("https://prop-lane.test/api/manager/assistant-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "request_address" }),
      }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain("paid Pro or Business plan");
    expect(mocks.ensureManagerAssistantEmail).not.toHaveBeenCalled();
  });

  it("refreshes eligibility before an address exists", async () => {
    const response = await POST(
      new Request("https://prop-lane.test/api/manager/assistant-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "refresh_eligibility" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.reconcileManagerSmsEntitlement).toHaveBeenCalled();
    expect(mocks.ensureManagerAssistantEmail).not.toHaveBeenCalled();
  });
});

/**
 * One work email per WORKSPACE, exactly like the work number. A co-manager who
 * owns no houses reads the owner's address, never sees a Request button, and a
 * POST is refused before billing or storage is touched.
 */
describe("one work email per workspace", () => {
  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    // The switcher is on the workspace Jane shares with this manager.
    mocks.activeWorkspace = SHARED_WS;
    mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue({
      eligible: true,
      tier: "pro",
      source: "stripe",
    });
    mocks.resolveWorkspaceWorkEmails.mockResolvedValue({
      role: "co_manager",
      emails: [
        { workspaceId: "ws-mine", workspaceName: "My workspace", owned: true, isDefault: true, ownerUserId: MANAGER, ownerName: "Me", address: null },
        { workspaceId: "ws-owner-1", workspaceName: "Jane's workspace", owned: false, isDefault: true, ownerUserId: "owner-1", ownerName: "Jane Smith", address: "assist-jane-smith@prop-lane.space" },
      ],
    });
  });

  it("the co-manager's OWN workspace shows no address and may request one — never Jane's", async () => {
    mocks.activeWorkspace = MY_WS;
    mocks.isAssistantEmailProvisioningEnabled.mockReturnValue(true);
    mocks.probeAssistantEmailStorageReady.mockResolvedValue(true);
    const body = await (await GET(new Request("http://localhost"))).json();
    expect(body.workspaceRole).toBe("primary");
    expect(body.workspace).toMatchObject({ id: "ws-mine", owned: true });
    expect(body.workspaceEmail).toBeNull();
    expect(body.address).toBeNull();
    expect(body.canRequest).toBe(true);
    expect(body.workspaces.map((w: { workspaceId: string; address: string | null }) => [w.workspaceId, w.address])).toEqual([
      ["ws-mine", null],
      ["ws-owner-1", "assist-jane-smith@prop-lane.space"],
    ]);
  });

  it("GET hands a co-manager the owner's address and no Request button", async () => {
    const res = await GET(new Request("http://localhost"));
    const body = await res.json();
    expect(body.workspaceRole).toBe("co_manager");
    expect(body.workspaceEmail).toEqual({
      address: "assist-jane-smith@prop-lane.space",
      ownerUserId: "owner-1",
      ownerName: "Jane Smith",
    });
    expect(body.canRequest).toBe(false);
    expect(body.address).toBeNull();
  });

  it("GET hides the workspace address while the deployment cannot receive", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("RESEND_INBOUND_WEBHOOK_SECRET", "");
    const res = await GET(new Request("http://localhost"));
    const body = await res.json();
    expect(body.receivingAvailable).toBe(false);
    expect(body.workspaceEmail?.address).toBeNull();
    expect(body.workspaceEmail?.ownerName).toBe("Jane Smith");
  });

  it("POST refuses a workspace the viewer does not own before any billing work", async () => {
    const res = await POST(
      new Request("http://localhost/api/manager/assistant-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request_address" }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("workspace_not_owned");
    expect(mocks.reconcileManagerSmsEntitlement).not.toHaveBeenCalled();
    expect(mocks.ensureManagerAssistantEmail).not.toHaveBeenCalled();
  });

  it("POST surfaces a refusal the write itself makes as the same 409", async () => {
    mocks.activeWorkspace = MY_WS;
    mocks.ensureManagerAssistantEmail.mockRejectedValue(new WorkspaceEmailSharedError("shared"));
    const res = await POST(
      new Request("http://localhost/api/manager/assistant-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request_address" }),
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("workspace_email_shared");
  });
});

/**
 * "Working" is both directions. Production advertised addresses that could send
 * and never hear a reply; the card must say "replies off", not "ready".
 */
describe("an address the deployment cannot receive at is assigned, not ready", () => {
  it("reports assigned_send_off on Vercel without the inbound webhook secret", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("RESEND_INBOUND_WEBHOOK_SECRET", "");
    mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue({ eligible: true, tier: "pro", source: "stripe" });
    mocks.loadManagerAssistantEmail.mockResolvedValue({
      managerUserId: MANAGER,
      inboxToken: "tok123456789",
      address: "assist-jane@prop-lane.space",
      provisionState: "active",
    });
    const body = await (await GET(new Request("http://localhost"))).json();
    expect(body.sendingAvailable).toBe(true);
    expect(body.receivingAvailable).toBe(false);
    expect(body.state).toBe("assigned_send_off");
    expect(body.canUse).toBe(false);
  });
});

// A live signup trial has no Communication (the real helper is covered by
// manager-communication-access.test.ts); here the owner's plan is controllable per test.
const communication = vi.hoisted(() => ({
  access: { allowed: true } as
    | { allowed: true }
    | { allowed: false; reason: "trial"; status: 402; message: string },
}));
vi.mock("@/lib/manager-communication-access.server", () => ({
  assertManagerCommunicationAllowed: vi.fn(async () => communication.access),
  assertManagerCommunicationAllowedForWorkspace: vi.fn(async () => communication.access),
}));

describe("a live signup trial gets no work email", () => {
  beforeEach(() => {
    communication.access = { allowed: true };
  });

  it("POST refuses with 402 before any entitlement work or enrolment", async () => {
    communication.access = {
      allowed: false,
      reason: "trial",
      status: 402,
      message: "Communication is available on a paid plan.",
    };
    const response = await POST(
      new Request("https://prop-lane.test/api/manager/assistant-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "request_address" }),
      }),
    );
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      error: "Communication is available on a paid plan.",
      code: "communication_trial",
    });
    expect(mocks.reconcileManagerSmsEntitlement).not.toHaveBeenCalled();
    expect(mocks.ensureManagerAssistantEmail).not.toHaveBeenCalled();
  });

  it("GET neither offers nor allows use, even with an eligible entitlement and an address", async () => {
    mocks.getManagerPortalNavSubscriptionTier.mockResolvedValue("trial");
    mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue({ eligible: true, tier: "pro", source: "stripe", trial: true });
    mocks.loadManagerAssistantEmail.mockResolvedValue({
      workspaceId: "ws-mine",
      managerUserId: MANAGER,
      inboxToken: "tok123456789",
      address: "assistant+tok123456789@prop-lane.space",
      provisionState: "active",
    });
    const response = await GET(new Request("https://prop-lane.test/api/manager/assistant-email"));
    const body = await response.json();
    expect(body.canUse).toBe(false);
    expect(body.canRequest).toBe(false);
  });
});

describe("the work email is judged by the workspace owner's plan", () => {
  const request = () =>
    new Request("https://prop-lane.test/api/manager/assistant-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "request_address" }),
    });
  const trial = {
    allowed: false,
    reason: "trial",
    status: 402,
    message: "Communication is available on a paid plan.",
  } as const;

  afterEach(async () => {
    mocks.activeWorkspace = null;
    const assertAllowed = await gate();
    assertAllowed.mockImplementation(async () => communication.access);
  });

  async function gate() {
    const mod = await import("@/lib/manager-communication-access.server");
    return vi.mocked(mod.assertManagerCommunicationAllowed);
  }

  it("asks about the owner, so a trial teammate in a paid owner's workspace is allowed", async () => {
    const assertAllowed = await gate();
    assertAllowed.mockImplementation(async (owner: string) => (owner === "paid-owner" ? { allowed: true } : trial));
    // The acting user (MANAGER) is on a trial of their own; the workspace belongs to a paid owner.
    mocks.activeWorkspace = { ...MY_WS, ownerUserId: "paid-owner" };
    const response = await POST(request());
    expect(assertAllowed).toHaveBeenCalledWith("paid-owner");
    expect(assertAllowed).not.toHaveBeenCalledWith(MANAGER);
    expect(response.status).not.toBe(402);
    expect(mocks.reconcileManagerSmsEntitlement).toHaveBeenCalled();
  });

  it("refuses with 402 when the owner is on a trial, whatever the acting user's own plan", async () => {
    const assertAllowed = await gate();
    assertAllowed.mockImplementation(async (owner: string) => (owner === "trial-owner" ? trial : { allowed: true }));
    mocks.activeWorkspace = { ...MY_WS, ownerUserId: "trial-owner" };
    const response = await POST(request());
    expect(assertAllowed).toHaveBeenCalledWith("trial-owner");
    expect(response.status).toBe(402);
    expect(mocks.reconcileManagerSmsEntitlement).not.toHaveBeenCalled();
    expect(mocks.ensureManagerAssistantEmail).not.toHaveBeenCalled();
  });
});

/**
 * Who may change a workspace's address: its owner, or staff with member rights on a PropLane-managed
 * (service) workspace. Everyone else keeps today's owner-only refusal.
 */
describe("changing the address: owner, or staff on a service workspace", () => {
  const SERVICE_WS = { id: "ws-service", name: "1. Ambika", ownerUserId: "service-owner", owned: false, isDefault: false, propertyIds: [] as string[] };
  const post = (action: "check_address" | "set_address", workspaceId?: string) =>
    POST(
      new Request("https://prop-lane.test/api/manager/assistant-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, local: "frontdesk", ...(workspaceId ? { workspaceId } : {}) }),
      }),
    );
  const staffAllowed = { ok: true, workspace: { id: "ws-service", ownerUserId: "service-owner" } };

  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    mocks.activeWorkspace = SERVICE_WS;
    mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue({ eligible: true, tier: "pro", source: "stripe" });
    mocks.resolveWorkspaceWorkEmails.mockResolvedValue({
      role: "co_manager",
      emails: [{ workspaceId: "ws-service", workspaceName: "1. Ambika", owned: false, isDefault: false, ownerUserId: "service-owner", ownerName: "PropLane", address: "ambikahomes@proplane.ai" }],
    });
  });

  it("staff with rights check availability against the workspace's owner and set through the audited service path", async () => {
    mocks.authorizeServiceWorkEmailEdit.mockResolvedValue(staffAllowed);
    const check = await post("check_address", "ws-service");
    expect(check.status).toBe(200);
    expect(mocks.checkWorkspaceAssistantMailboxLocal).toHaveBeenCalledWith(expect.anything(), "ws-service", "frontdesk", "service-owner");

    const set = await post("set_address", "ws-service");
    expect(set.status).toBe(200);
    expect(mocks.setServiceWorkspaceWorkEmail).toHaveBeenCalledWith(expect.anything(), MANAGER, { workspaceId: "ws-service", local: "frontdesk" });
    expect(mocks.setWorkspaceAssistantMailboxLocal).not.toHaveBeenCalled();
    expect(mocks.track).toHaveBeenCalledWith("assistant_email_local_changed", MANAGER, {});
  });

  it("maps a taken address from the service path to 409 with its state", async () => {
    mocks.authorizeServiceWorkEmailEdit.mockResolvedValue(staffAllowed);
    mocks.setServiceWorkspaceWorkEmail.mockResolvedValue({ ok: false, status: 409, error: "That address is already in use.", state: "taken" });
    const res = await post("set_address", "ws-service");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ state: "taken" });
  });

  it("refuses 403 for a workspace that is not a service workspace, or staff without rights", async () => {
    for (const refusal of [
      { ok: false, status: 404, error: "Service workspace not found." },
      { ok: false, status: 403, error: "Only the owner or an admin of this workspace can change its work email." },
    ]) {
      // The service path re-authorizes inside the write; both reads refuse the same way.
      mocks.authorizeServiceWorkEmailEdit.mockResolvedValue(refusal);
      mocks.setServiceWorkspaceWorkEmail.mockResolvedValue(refusal);
      for (const action of ["check_address", "set_address"] as const) {
        const res = await post(action, "ws-service");
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe("workspace_not_owned");
      }
    }
    expect(mocks.checkWorkspaceAssistantMailboxLocal).not.toHaveBeenCalled();
    expect(mocks.setWorkspaceAssistantMailboxLocal).not.toHaveBeenCalled();
  });

  it("a shared (non-service) workspace stays owner-only for a non-staff co-manager", async () => {
    mocks.activeWorkspace = SHARED_WS;
    mocks.setServiceWorkspaceWorkEmail.mockResolvedValue({ ok: false, status: 404, error: "Service workspace not found." });
    for (const action of ["check_address", "set_address"] as const) {
      const res = await post(action, SHARED_WS.id);
      expect(res.status).toBe(403);
    }
    expect(mocks.setWorkspaceAssistantMailboxLocal).not.toHaveBeenCalled();
    expect(mocks.checkWorkspaceAssistantMailboxLocal).not.toHaveBeenCalled();
  });

  it("an address check whose reads fail is 503 unavailable, never an availability answer", async () => {
    mocks.activeWorkspace = MY_WS;
    mocks.checkWorkspaceAssistantMailboxLocal.mockRejectedValueOnce(new Error("alias read failed"));
    const res = await post("check_address", MY_WS.id);
    expect(res.status).toBe(503);
    expect(await res.json()).not.toHaveProperty("state");
  });

  it("the owner is unchanged: checks and sets through the owner path, never the service one", async () => {
    mocks.activeWorkspace = MY_WS;
    expect((await post("check_address", MY_WS.id)).status).toBe(200);
    expect(mocks.checkWorkspaceAssistantMailboxLocal).toHaveBeenCalledWith(expect.anything(), "ws-mine", "frontdesk", MANAGER);
    expect((await post("set_address", MY_WS.id)).status).toBe(200);
    expect(mocks.setWorkspaceAssistantMailboxLocal).toHaveBeenCalled();
    expect(mocks.setServiceWorkspaceWorkEmail).not.toHaveBeenCalled();
    expect(mocks.authorizeServiceWorkEmailEdit).not.toHaveBeenCalled();
  });

  it("GET exposes canEditAddress to the owner with an address and to authorized staff, never otherwise", async () => {
    mocks.loadManagerAssistantEmail.mockResolvedValue({ address: "assistant@test.invalid", workspaceId: "ws-mine" });
    mocks.activeWorkspace = MY_WS;
    expect((await (await GET(new Request("http://localhost"))).json()).canEditAddress).toBe(true);

    mocks.activeWorkspace = SERVICE_WS;
    mocks.authorizeServiceWorkEmailEdit.mockResolvedValue(staffAllowed);
    expect((await (await GET(new Request("http://localhost"))).json()).canEditAddress).toBe(true);

    mocks.authorizeServiceWorkEmailEdit.mockResolvedValue({ ok: false, status: 403, error: "no" });
    expect((await (await GET(new Request("http://localhost"))).json()).canEditAddress).toBe(false);

    // The owner with no address yet has nothing to edit.
    mocks.loadManagerAssistantEmail.mockResolvedValue(null);
    mocks.activeWorkspace = MY_WS;
    expect((await (await GET(new Request("http://localhost"))).json()).canEditAddress).toBe(false);
  });
});
