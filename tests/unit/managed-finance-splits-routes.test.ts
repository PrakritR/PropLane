import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const admin = vi.hoisted(() => ({ value: { ok: false, response: null } as unknown }));
vi.mock("@/lib/admin/admin-route-guard.server", () => ({ requireAdminRoute: async () => admin.value }));
const session = vi.hoisted(() => ({ value: { ok: false, status: 401, error: "Unauthorized." } as unknown }));
vi.mock("@/lib/auth/route-actor.server", () => ({ resolveRouteSessionUser: async () => session.value }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: async () => ({ kind: "allowed" }) }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => { throw new Error("no stripe in tests"); } }));
const load = vi.hoisted(() => vi.fn(async () => ({ workspaces: [] })));
vi.mock("@/lib/managed-finance/admin-payouts.server", () => ({ loadAdminPayouts: load }));
const createRule = vi.hoisted(() => vi.fn(async () => ({ id: "r1" })));
vi.mock("@/lib/managed-finance/splits.server", () => ({
  createSplitRule: createRule, endSplitRule: vi.fn(), listEligiblePayees: vi.fn(), placePayoutHold: vi.fn(), releasePayoutHold: vi.fn(),
  setBillApprovalThreshold: vi.fn(), writePayoutAudit: vi.fn(),
}));

import { NextResponse } from "next/server";
import { GET as adminGet, POST as adminPost } from "@/app/api/admin/payouts/route";
import { GET as earningsGet } from "@/app/api/earnings/route";
import { POST as withdrawPost } from "@/app/api/earnings/withdraw/route";
import { MANAGED_READ_ONLY_ALLOWED_PATHS } from "@/lib/auth/managed-read-only-policy";
import { buildOwnerStatement, buildVendorStatement, statementReconciles } from "@/lib/managed-finance/statement";

beforeEach(() => {
  admin.value = { ok: false, response: NextResponse.json({ error: "Forbidden." }, { status: 403 }) };
  session.value = { ok: false, status: 401, error: "Unauthorized." };
  load.mockClear();
  createRule.mockClear();
});

describe("/api/admin/payouts is platform-admin only", () => {
  it("refuses a non-admin on both verbs before reading or writing anything", async () => {
    expect((await adminGet(new Request("http://x.test/api/admin/payouts"))).status).toBe(403);
    expect((await adminPost(new Request("http://x.test/api/admin/payouts", { method: "POST", body: JSON.stringify({ action: "rule_create", workspaceId: "ws" }) }))).status).toBe(403);
    expect(load).not.toHaveBeenCalled();
    expect(createRule).not.toHaveBeenCalled();
  });
  it("passes the authenticated admin as the actor and treats body ids as names (the draft is rebuilt field by field)", async () => {
    admin.value = { ok: true, userId: "admin-1" };
    const res = await adminPost(new Request("http://x.test/api/admin/payouts", { method: "POST", body: JSON.stringify({ action: "rule_create", workspaceId: "ws", actorUserId: "someone-else", payeeUserId: "m1", payeeKind: "member", ruleKind: "percent", bps: 1500, appliesTo: ["rent"] }) }));
    expect(res.status).toBe(200);
    const call = createRule.mock.calls[0] as unknown as [unknown, { actorUserId: string; workspaceId: string; draft: Record<string, unknown> }];
    expect(call[1].actorUserId).toBe("admin-1");
    expect(call[1].draft).toMatchObject({ payeeUserId: "m1", bps: 1500, fixedCents: null, propertyId: null });
  });
  it("an unknown action is a 400", async () => {
    admin.value = { ok: true, userId: "admin-1" };
    expect((await adminPost(new Request("http://x.test/api/admin/payouts", { method: "POST", body: JSON.stringify({ action: "wire_money" }) }))).status).toBe(400);
  });
});

describe("/api/earnings is the session's own balance", () => {
  it("is 401 with no session, on the report, the CSV and the withdrawal", async () => {
    expect((await earningsGet(new Request("http://x.test/api/earnings"))).status).toBe(401);
    expect((await earningsGet(new Request("http://x.test/api/earnings?format=csv"))).status).toBe(401);
    expect((await withdrawPost(new Request("http://x.test/api/earnings/withdraw", { method: "POST", body: JSON.stringify({ scope: "vendor", amountCents: 500 }) }))).status).toBe(401);
  });
  it("is in the managed read-only allowlist, so a locked owner keeps their own money", () => {
    expect(MANAGED_READ_ONLY_ALLOWED_PATHS).toContain("/api/earnings");
  });
  it("a withdrawal that does not say what to withdraw is a 400", async () => {
    session.value = { ok: true, user: { id: "u1", email: "u@x.test" } };
    expect((await withdrawPost(new Request("http://x.test/api/earnings/withdraw", { method: "POST", body: JSON.stringify({ amountCents: 500 }) }))).status).toBe(400);
  });
});

describe("statements carry payout splits and still reconcile", () => {
  const line = (kind: string, amountCents: number, extra: Record<string, unknown> = {}) => ({
    journalId: `${kind}-${amountCents}`, amountCents, availableOn: null, postedAt: "2026-06-05T00:00:00Z", kind, detail: { owner_cents: 90_000, fee_cents: 10_000, ...extra }, sourceType: null, sourceId: null,
  });
  it("the owner's statement shows the share given away and net still equals ending", () => {
    const s = buildOwnerStatement([line("rent_capture", -90_000), line("split_allocation", 13_500, { property_id: "p1" })], "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z");
    expect(s.rows.find((r) => r.kind === "split")).toMatchObject({ amountCents: -13_500, label: "Shared with your team (payout split)" });
    expect(s.endingCents).toBe(76_500);
    expect(statementReconciles(s)).toBe(true);
  });
  it("a payee's statement shows their share and a refund reversal", () => {
    const s = buildOwnerStatement([line("split_allocation", -13_500), line("split_reversal", 6_750)], "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z");
    expect(s.rows.map((r) => [r.kind, r.amountCents])).toEqual([["split", 13_500], ["split", -6_750]]);
    expect(statementReconciles(s)).toBe(true);
  });
  it("a vendor payee's statement folds splits too", () => {
    const s = buildVendorStatement([line("split_allocation", -5_000)], "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z");
    expect(s.rows[0]).toMatchObject({ kind: "split", amountCents: 5_000 });
    expect(statementReconciles(s)).toBe(true);
  });
});
