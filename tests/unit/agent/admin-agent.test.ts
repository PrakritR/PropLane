/**
 * The admin (PropLane operator) assistant: its own resolver, registry and route.
 *
 * Pins the contract in AGENTS.md "AI Agent & Tool Layer": admin-only context
 * with no manager scope, a registry of READ tools that each answer from the
 * server function the admin UI uses, and a route that can never reach the
 * manager registry.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  isAdminUser: vi.fn(),
  getUser: vi.fn(),
  scanNewestProfiles: vi.fn(),
  resolveAccountKinds: vi.fn(),
  listAccountIdsForEveryKind: vi.fn(),
  listSandboxAccountIds: vi.fn(),
  loadRealAccountProfiles: vi.fn(),
  loadAdminAccountDetail: vi.fn(),
  readAllPages: vi.fn(),
  loadOverrides: vi.fn(),
  loadAdminHealth: vi.fn(),
  balanceList: vi.fn(),
  promoList: vi.fn(),
  resolveAdminAgentContext: vi.fn(),
}));

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => m.isAdminUser(...a) }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: m.getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ marker: "service-role" }) }));
vi.mock("@/lib/admin/admin-accounts.server", () => ({
  profileSearchFilter: (q: string) => `email.ilike.%${q}%`,
  scanNewestProfiles: (...a: unknown[]) => m.scanNewestProfiles(...a),
  resolveAccountKinds: (...a: unknown[]) => m.resolveAccountKinds(...a),
  listAccountIdsForEveryKind: (...a: unknown[]) => m.listAccountIdsForEveryKind(...a),
  listSandboxAccountIds: (...a: unknown[]) => m.listSandboxAccountIds(...a),
  loadRealAccountProfiles: (...a: unknown[]) => m.loadRealAccountProfiles(...a),
}));
vi.mock("@/lib/admin/admin-account-detail.server", () => ({
  isAdminAccountId: (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim()),
  loadAdminAccountDetail: (...a: unknown[]) => m.loadAdminAccountDetail(...a),
}));
vi.mock("@/lib/auth/admin-portal-manager-ids.server", () => ({
  readAllPages: (...a: unknown[]) => m.readAllPages(...a),
}));
vi.mock("@/lib/manager-billing-overrides", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-billing-overrides")>()),
  loadManagerBillingOverridesForIds: (...a: unknown[]) => m.loadOverrides(...a),
}));
vi.mock("@/lib/admin/admin-health.server", () => ({ loadAdminHealth: (...a: unknown[]) => m.loadAdminHealth(...a) }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ balanceTransactions: { list: m.balanceList }, promotionCodes: { list: m.promoList } }),
}));
vi.mock("@/lib/tools/admin/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tools/admin/context")>()),
  resolveAdminAgentContext: (...a: unknown[]) => m.resolveAdminAgentContext(...a),
}));

const { resolveAdminAgentContext: realResolve } = await vi.importActual<typeof import("@/lib/tools/admin/context")>(
  "@/lib/tools/admin/context",
);
const { adminAgentRegistry } = await import("@/lib/tools/admin");
const { subscriberBucketOf } = await import("@/lib/tools/admin/subscribers");
const { monthWindow, summarizeBalanceTransactions } = await import("@/lib/tools/admin/stripe-reads");
const { runReadTool } = await import("@/lib/tools/registry");

const repoRoot = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const ctx = {
  kind: "admin" as const,
  userId: ADMIN_ID,
  email: "ops@proplane.test",
  isAdmin: true as const,
  db: { marker: "service-role" } as never,
};
const run = (name: string, input: unknown = {}) => runReadTool(adminAgentRegistry, ctx, name, input);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveAdminAgentContext", () => {
  it("refuses a signed-out caller", async () => {
    m.getUser.mockResolvedValue({ data: { user: null } });
    expect(await realResolve()).toBeNull();
    expect(m.isAdminUser).not.toHaveBeenCalled();
  });

  it("refuses a signed-in non-admin (a manager, resident or vendor)", async () => {
    m.getUser.mockResolvedValue({ data: { user: { id: "mgr-1", email: "m@x.test" } } });
    m.isAdminUser.mockResolvedValue(false);
    expect(await realResolve()).toBeNull();
    expect(m.isAdminUser).toHaveBeenCalledWith("mgr-1");
  });

  it("admits an admin with NO manager scope", async () => {
    m.getUser.mockResolvedValue({ data: { user: { id: ADMIN_ID, email: "Ops@Proplane.test" } } });
    m.isAdminUser.mockResolvedValue(true);
    const resolved = await realResolve();
    expect(resolved).toMatchObject({ kind: "admin", userId: ADMIN_ID, email: "ops@proplane.test", isAdmin: true });
    expect(resolved).not.toHaveProperty("landlordId");
    expect(resolved).not.toHaveProperty("workspace");
  });
});

describe("adminAgentRegistry", () => {
  it("holds exactly the planned read tools", () => {
    expect([...adminAgentRegistry.keys()].sort()).toEqual(
      [
        "account_summary",
        "earnings_summary",
        "find_account",
        "health_summary",
        "open_feedback",
        "promo_codes_summary",
        "subscriber_counts",
        "trials_ending",
      ].sort(),
    );
  });

  it("contains no write tools", () => {
    for (const tool of adminAgentRegistry.values()) expect(tool.kind, tool.name).toBe("read");
    const folder = join(repoRoot, "src/lib/tools/admin");
    for (const file of readdirSync(folder)) {
      const source = readFileSync(join(folder, file), "utf8");
      expect(source, file).not.toContain("defineWriteTool");
      expect(source, file).not.toMatch(/kind:\s*"write"/);
    }
  });

  it("shares no tool with the manager registry", async () => {
    const { agentRegistry } = await import("@/lib/tools");
    for (const name of adminAgentRegistry.keys()) expect(agentRegistry.has(name), name).toBe(false);
  }, 120_000);

  it("find_account returns matches from the accounts search", async () => {
    m.scanNewestProfiles.mockImplementation(async (_db, _opts, keep) =>
      keep([
        { id: "a1", email: "jacko@x.test", full_name: "Jack O", manager_id: "AXIS-1", application_approved: true, created_at: "2026-09-12T00:00:00Z" },
        { id: "a2", email: "ghost@x.test", full_name: "No Kind", manager_id: "", application_approved: true, created_at: null },
      ]),
    );
    m.resolveAccountKinds.mockResolvedValue(new Map([["a1", ["manager"]]]));
    const result = await run("find_account", { query: "jack" });
    expect(result).toEqual({
      ok: true,
      data: {
        count: 1,
        accounts: [
          { id: "a1", name: "Jack O", email: "jacko@x.test", propLaneId: "AXIS-1", kinds: ["manager"], active: true, joinedAt: "2026-09-12T00:00:00Z" },
        ],
      },
    });
    expect(m.scanNewestProfiles.mock.calls[0]![1]).toMatchObject({ match: "email.ilike.%jack%", limit: 10 });
  });

  it("account_summary projects the record without secrets and rejects a bad id", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    m.loadAdminAccountDetail.mockResolvedValue({
      id,
      fullName: "Seattle Homes",
      email: "jacko@x.test",
      phone: "+12065550142",
      propLaneId: "AXIS-1",
      roles: ["manager"],
      status: "active",
      createdAt: "2026-09-12T00:00:00Z",
      lastSignInAt: "2026-10-07T00:00:00Z",
      manager: { tier: "pro", billing: "monthly" },
      workspaces: { owned: [{ id: "w1", name: "Seattle Homes", isDefault: true, createdAt: null, payoutsEnabled: true }], links: [] },
      payments: { connectLinked: true, payouts: [], disputes: [{ id: "d", status: "needs_response", amountCents: 100, reason: null, createdAt: null }] },
      support: { feedback: [{ id: "f1", reportType: "bug", title: "Broken", status: "open", createdAt: null }] },
    });
    const ok = await run("account_summary", { accountId: id });
    expect(ok).toMatchObject({ ok: true, data: { name: "Seattle Homes", plan: { tier: "pro", billing: "monthly" }, payoutsConnected: true, openDisputes: 1 } });
    expect(JSON.stringify(ok)).not.toContain("2065550142");

    expect(await run("account_summary", { accountId: "nope" })).toMatchObject({ ok: false });
    m.loadAdminAccountDetail.mockResolvedValue(null);
    expect(await run("account_summary", { accountId: id })).toMatchObject({ ok: false });
  });

  describe("subscribers", () => {
    const NOW = Date.now();
    const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
    const profile = (id: string, name: string) => ({
      id,
      email: `${id}@x.test`,
      fullName: name,
      phone: "",
      propLaneId: id,
      active: true,
      joinedAt: daysAgo(40),
      stripeConnectAccountId: "",
    });
    const purchase = (user_id: string, over: Record<string, unknown>) => ({
      id: `p-${user_id}`,
      user_id,
      email: `${user_id}@x.test`,
      tier: "pro",
      billing: "monthly",
      paid_at: daysAgo(40),
      promo_code: null,
      stripe_promotion_code: null,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      stripe_checkout_session_id: `cs_${user_id}`,
      apple_original_transaction_id: null,
      ...over,
    });

    beforeEach(() => {
      m.listAccountIdsForEveryKind.mockResolvedValue({
        manager: ["paid", "trialSoon", "trialLater", "promo", "free", "comp", "lapsed", "demo"],
        resident: [],
        vendor: [],
      });
      m.listSandboxAccountIds.mockResolvedValue(new Set(["demo"]));
      m.loadRealAccountProfiles.mockResolvedValue(
        ["paid", "trialSoon", "trialLater", "promo", "free", "comp", "lapsed"].map((id) => profile(id, id)),
      );
      m.readAllPages.mockResolvedValue([
        purchase("paid", { stripe_subscription_id: "sub_1" }),
        purchase("trialSoon", { billing: "trial", paid_at: daysAgo(10) }),
        purchase("trialLater", { billing: "trial", paid_at: daysAgo(3) }),
        purchase("promo", { stripe_subscription_id: "sub_2", stripe_promotion_code: "FREEFIRST" }),
        purchase("comp", { stripe_subscription_id: "sub_3" }),
        purchase("lapsed", { billing: "trial", paid_at: daysAgo(40) }),
      ]);
      m.loadOverrides.mockResolvedValue(
        new Map([["comp", { propertyCap: null, trialEndsAt: null, complimentary: true }]]),
      );
    });

    it("subscriber_counts buckets Paid, Trial, Promo, Free and Comp by the enforced plan", async () => {
      expect(await run("subscriber_counts")).toEqual({
        ok: true,
        data: { paid: 1, trial: 2, promo: 1, free: 2, comp: 1, total: 7 },
      });
    });

    it("trials_ending lists trials ending inside the window, soonest first", async () => {
      const week = await run("trials_ending", { days: 7 });
      expect(week).toMatchObject({ ok: true, data: { windowDays: 7, count: 1 } });
      const data = (week as { data: { trials: { id: string; daysLeft: number }[] } }).data;
      expect(data.trials.map((t) => t.id)).toEqual(["trialSoon"]);
      expect(data.trials[0]!.daysLeft).toBeLessThanOrEqual(4);

      const fortnight = await run("trials_ending", { days: 14 });
      expect((fortnight as { data: { trials: { id: string }[] } }).data.trials.map((t) => t.id)).toEqual([
        "trialSoon",
        "trialLater",
      ]);
    });

    it("never files an unreadable plan into a bucket", () => {
      expect(subscriberBucketOf({ planUnknown: true } as never, null)).toBeNull();
    });
  });

  describe("stripe reads", () => {
    it("earnings_summary rolls the month's balance transactions up and skips payouts", async () => {
      m.balanceList.mockResolvedValue({
        has_more: false,
        data: [
          { id: "t1", currency: "usd", amount: 10_000, fee: 320, net: 9_680, reporting_category: "charge" },
          { id: "t2", currency: "usd", amount: 500, fee: 0, net: 500, reporting_category: "application_fee" },
          { id: "t3", currency: "usd", amount: -2_000, fee: 0, net: -2_000, reporting_category: "refund" },
          { id: "t4", currency: "usd", amount: -5_000, fee: 0, net: -5_000, reporting_category: "payout" },
          { id: "t5", currency: "usd", amount: -100, fee: 0, net: -100, reporting_category: "fee" },
          { id: "t6", currency: "eur", amount: 9_999, fee: 0, net: 9_999, reporting_category: "charge" },
        ],
      });
      const result = await run("earnings_summary", { month: "2026-10" });
      expect(result).toEqual({
        ok: true,
        data: {
          month: "2026-10",
          currency: "usd",
          transactionsRead: 6,
          complete: true,
          revenueCents: 10_500,
          refundsCents: -2_000,
          disputesCents: 0,
          stripeFeesCents: 420,
          netCents: 8_080,
          other: {},
        },
      });
      expect(m.balanceList.mock.calls[0]![0].created).toEqual({
        gte: Math.floor(Date.UTC(2026, 9, 1) / 1000),
        lt: Math.floor(Date.UTC(2026, 10, 1) / 1000),
      });
    });

    it("earnings_summary rejects a malformed month and the pure helpers agree", async () => {
      expect(await run("earnings_summary", { month: "October" })).toMatchObject({ ok: false });
      expect(monthWindow("2026-13")).toBeNull();
      expect(monthWindow("2026-12")!.endUnix).toBe(Math.floor(Date.UTC(2027, 0, 1) / 1000));
      expect(summarizeBalanceTransactions([]).netCents).toBe(0);
    });

    it("promo_codes_summary lists Stripe promotion codes, most redeemed first", async () => {
      m.promoList.mockResolvedValue({
        has_more: false,
        data: [
          { id: "p1", code: "SPRING", active: true, times_redeemed: 2, max_redemptions: 50, expires_at: null, promotion: { coupon: { percent_off: 20, amount_off: null, duration: "once", duration_in_months: null } } },
          { id: "p2", code: "FREEFIRST", active: true, times_redeemed: 9, max_redemptions: null, expires_at: 1_791_000_000, promotion: { coupon: { percent_off: 100, amount_off: null, duration: "repeating", duration_in_months: 1 } } },
          { id: "p3", code: "FIVEOFF", active: false, times_redeemed: 0, max_redemptions: null, expires_at: null, promotion: { coupon: { percent_off: null, amount_off: 500, duration: "once", duration_in_months: null } } },
        ],
      });
      const result = await run("promo_codes_summary", {});
      const data = (result as { data: { codes: { code: string; discount: string; duration: string | null }[] } }).data;
      expect(data.codes.map((c) => c.code)).toEqual(["FREEFIRST", "SPRING", "FIVEOFF"]);
      expect(data.codes[0]).toMatchObject({ discount: "100% off", duration: "1 months", timesRedeemed: 9 });
      expect(data.codes[2]!.discount).toBe("$5.00 off");
      expect(m.promoList.mock.calls[0]![0].expand).toEqual(["data.promotion.coupon"]);
    });
  });

  describe("health and feedback", () => {
    it("health_summary reuses the Health page and can keep only the last day", async () => {
      const now = Date.now();
      m.loadAdminHealth.mockResolvedValue({
        groups: [
          {
            id: "sms",
            label: "Failed text messages",
            rows: [
              { id: "1", title: "Text to •••• 0142", fact: "Error 30003", at: new Date(now - 3_600_000).toISOString(), accountId: "m1" },
              { id: "2", title: "Text to •••• 0143", fact: "Error 30005", at: new Date(now - 3 * 86_400_000).toISOString(), accountId: "m2" },
            ],
          },
          { id: "webhooks", label: "Failed webhooks", rows: [] },
        ],
      });
      const all = await run("health_summary", {});
      expect((all as { data: { groups: { total: number }[] } }).data.groups[0]!.total).toBe(2);
      const today = await run("health_summary", { sinceHours: 24 });
      const groups = (today as { data: { groups: { id: string; total: number; rows: { fact: string }[] }[] } }).data.groups;
      expect(groups[0]).toMatchObject({ id: "sms", total: 1 });
      expect(groups[0]!.rows[0]!.fact).toBe("Error 30003");
    });

    it("open_feedback lists unresolved reports from the feedback table", async () => {
      const rows = [
        { id: "f1", report_type: "bug", created_at: "2026-10-07T00:00:00Z", title: "Save fails", status: "open" },
        { id: "f2", report_type: "feedback", created_at: "2026-10-06T00:00:00Z", title: "Nice", status: "completed" },
        { id: "f3", report_type: "bug", created_at: "2026-10-05T00:00:00Z", title: "Slow", status: "reviewing" },
      ];
      const chain = {
        select: () => chain,
        order: () => chain,
        limit: async () => ({ data: rows, error: null }),
      };
      const db = { from: (table: string) => (table === "portal_bug_feedback_records" ? chain : null) };
      const result = await runReadTool(adminAgentRegistry, { ...ctx, db: db as never }, "open_feedback", {});
      expect(result).toMatchObject({ ok: true, data: { unresolved: 2 } });
      const data = (result as { data: { feedback: { title: string; status: string }[] } }).data;
      expect(data.feedback.map((f) => [f.title, f.status])).toEqual([
        ["Save fails", "open"],
        ["Slow", "in_progress"],
      ]);
    });
  });
});

describe("/api/agent/admin-chat", () => {
  const route = read("src/app/api/agent/admin-chat/route.ts");

  it("resolves with the admin resolver and runs only the admin registry", () => {
    expect(route).toContain("resolveAdminAgentContext");
    expect(route).toContain("registry: adminAgentRegistry");
    expect(route).toContain("ADMIN_PORTAL_SYSTEM_PROMPT");
    expect(route).toContain('"admin"');
    expect(route).toContain("traceAgentTurn");
    expect(route).toContain("isAdmin: true");
  });

  it("never reaches the manager resolver, registry or confirm gate", () => {
    expect(route).not.toMatch(/(^|[^A-Za-z])agentRegistry/);
    expect(route).not.toContain("resolveAgentContext");
    expect(route).not.toContain("@/lib/tools/context");
    expect(route).not.toContain("MANAGER_SYSTEM_PROMPT");
    expect(route).not.toContain("withManagerWorkspacePrompt");
    expect(route).not.toContain("allowWriteTools");
    expect(route).not.toContain("createPendingAction");
  });

  it("answers 401 to a non-admin on every verb", async () => {
    m.resolveAdminAgentContext.mockResolvedValue(null);
    const { GET, POST, DELETE } = await import("@/app/api/agent/admin-chat/route");
    const post = await POST(new Request("http://localhost/api/agent/admin-chat", { method: "POST", body: "{}" }));
    expect(post.status).toBe(401);
    expect((await GET(new Request("http://localhost/api/agent/admin-chat"))).status).toBe(401);
    expect((await DELETE(new Request("http://localhost/api/agent/admin-chat?sessionId=x", { method: "DELETE" }))).status).toBe(401);
  }, 120_000);
});

describe("admin layout", () => {
  it("passes the admin endpoint to the assistant provider and the rail", () => {
    const layout = read("src/app/admin/layout.tsx");
    expect(layout).toMatch(/<AxisAssistant[^>]*endpoint="\/api\/agent\/admin-chat"/);
    expect(layout).toMatch(/<PortalAssistantRail[^>]*endpoint="\/api\/agent\/admin-chat"/s);
    expect(layout).not.toContain('"/api/agent/chat"');
  });
});
