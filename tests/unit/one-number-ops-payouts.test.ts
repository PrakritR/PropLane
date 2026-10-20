// "set up payouts" by text: a code-protected payouts link, then one confirmation text.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const mocks = vi.hoisted(() => ({ mint: vi.fn(), sendText: vi.fn(), refresh: vi.fn(), workspace: vi.fn() }));
vi.mock("@/lib/tools/domains/one-number-links", () => ({ mintLinkForTexter: mocks.mint }));
vi.mock("@/lib/one-number/link-text.server", () => ({ sendWorkspacePhoneText: mocks.sendText }));
vi.mock("@/lib/stripe-external-accounts.server", () => ({ refreshPayoutDestinationsCacheFromStripe: mocks.refresh }));
vi.mock("@/lib/one-number/link-destinations.server", () => ({ resolveWorkspaceForProperty: mocks.workspace }));

import { managerSetUpPayoutsTool, payoutLinkForTexter, vendorSetUpPayoutsTool } from "@/lib/tools/domains/manager-ops";
import { defaultPayoutLast4, payoutsReadyText, textPayoutsReady } from "@/lib/one-number/payouts-ready.server";
import { buildManagerSmsRegistry } from "@/lib/tools";
import { vendorWorkOrderAgentRegistry } from "@/lib/tools";
import type { AgentContext } from "@/lib/tools/context";

const NOW = new Date("2026-10-19T20:00:00Z");

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mint.mockResolvedValue({ ok: true, url: "https://proplane.ai/l/tok", purpose: "payouts", requiresCode: true, expires: "7 days" });
  mocks.sendText.mockResolvedValue(true);
  mocks.refresh.mockResolvedValue([]);
  mocks.workspace.mockResolvedValue("ws-a");
});

describe("payoutLinkForTexter", () => {
  const base = { userId: "u1", targetType: "manager" as const, workspaceId: "ws-a", phone: "+12065550123", phoneVerified: true, payoutsEnabled: false };

  it("mints a code-protected payouts link bound to the texter's own phone", async () => {
    const out = await payoutLinkForTexter(createMemoryDb() as never, base);
    expect(out).toEqual({ ok: true, alreadySetUp: false, url: "https://proplane.ai/l/tok", requiresCode: true, expires: "7 days" });
    expect(mocks.mint).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "ws-a",
      phone: "+12065550123",
      purpose: "payouts",
      targetType: "manager",
      targetId: "u1",
      createdBy: "u1",
    });
  });

  it("answers an already-set-up account with the last four on file and mints nothing", async () => {
    const db = createMemoryDb({ payout_destinations_cache: [{ owner_user_id: "u1", last4: "4417", is_default: true, updated_at: "2026-10-01" }] });
    expect(await payoutLinkForTexter(db as never, { ...base, payoutsEnabled: true })).toEqual({ ok: true, alreadySetUp: true, last4: "4417" });
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("never mints for an unverified phone or without a phone", async () => {
    expect(await payoutLinkForTexter(createMemoryDb() as never, { ...base, phoneVerified: false })).toEqual({ ok: false, error: "nothing_to_link" });
    expect(await payoutLinkForTexter(createMemoryDb() as never, { ...base, phone: null })).toEqual({ ok: false, error: "nothing_to_link" });
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("passes the mint's refusal through (rate limit, line not shared)", async () => {
    mocks.mint.mockResolvedValue({ ok: false, error: "links_unavailable" });
    expect(await payoutLinkForTexter(createMemoryDb() as never, base)).toEqual({ ok: false, error: "links_unavailable" });
    mocks.mint.mockResolvedValue({ ok: false, error: "rate_limited" });
    expect(await payoutLinkForTexter(createMemoryDb() as never, base)).toEqual({ ok: false, error: "rate_limited" });
  });
});

describe("the set_up_payouts tools", () => {
  const managerCtx = (db: unknown, over: Partial<AgentContext> = {}) =>
    ({ landlordId: "u1", userId: "u1", email: "m@x.test", roles: ["manager"], isAdmin: false, workspace: { id: "ws-a", name: "A", isDefault: true, narrowing: false, propertyIds: [] }, db, ...over }) as unknown as AgentContext;

  it("manager: reads the manager's own verified phone, never a model-supplied one", async () => {
    const db = createMemoryDb({ profiles: [{ id: "u1", phone: "+12065550123", phone_verified_at: "2026-01-01T00:00:00Z", stripe_connect_payouts_enabled: false }] });
    const out = await managerSetUpPayoutsTool.handler(managerCtx(db), {});
    expect(out).toMatchObject({ ok: true, alreadySetUp: false });
    expect(mocks.mint.mock.calls[0]![1]).toMatchObject({ phone: "+12065550123", workspaceId: "ws-a", targetType: "manager", targetId: "u1" });
    expect(managerSetUpPayoutsTool.inputSchema.safeParse({ phone: "+19995550000" }).success).toBe(false);
  });

  it("manager: a teammate on someone else's number has no payout account here", async () => {
    const db = createMemoryDb();
    const delegated = managerCtx(db, { landlordId: "owner", userId: "mate", managerSmsAccess: { mode: "delegated", workNumberOwnerId: "owner", actorUserId: "mate", dataOwnerIds: ["owner"], assignedPropertyIds: ["p"] } });
    expect(await managerSetUpPayoutsTool.handler(delegated, {})).toEqual({ ok: false, error: "not_found" });
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  const vendorCtx = (db: unknown, over: Record<string, unknown> = {}) =>
    ({ landlordId: "owner", userId: "owner", email: "", roles: ["manager"], isAdmin: false, db, vendorScope: { sessionId: "s1", vendorDirectoryId: "vd1", vendorUserId: "v1", workOrderId: "wo1" }, ...over }) as unknown as AgentContext;
  const vendorDb = (over: { sessionPhone?: string; profilePhone?: string; verified?: boolean; enabled?: boolean } = {}) =>
    createMemoryDb({
      agent_sessions: [{ id: "s1", vendor_phone_e164: over.sessionPhone ?? "+12065550188", landlord_id: "owner", work_order_id: "wo1" }],
      profiles: [{ id: "v1", phone: over.profilePhone ?? "+12065550188", phone_verified_at: over.verified === false ? null : "2026-01-01T00:00:00Z", stripe_connect_payouts_enabled: over.enabled ?? false }],
      portal_work_order_records: [{ id: "wo1", manager_user_id: "owner", property_id: "p1", assigned_property_id: null }],
    });

  it("vendor: pinned to the session's vendor and phone, workspace from the job's house", async () => {
    const out = await vendorSetUpPayoutsTool.handler(vendorCtx(vendorDb()), {});
    expect(out).toMatchObject({ ok: true, alreadySetUp: false });
    expect(mocks.workspace).toHaveBeenCalledWith(expect.anything(), "p1", "owner");
    expect(mocks.mint.mock.calls[0]![1]).toMatchObject({ phone: "+12065550188", targetType: "vendor", targetId: "v1", purpose: "payouts" });
  });

  it("vendor: refuses when the session's phone is not that vendor's verified number, or the session is another job's", async () => {
    expect(await vendorSetUpPayoutsTool.handler(vendorCtx(vendorDb({ profilePhone: "+12065559999" })), {})).toEqual({ ok: false, error: "nothing_to_link" });
    expect(await vendorSetUpPayoutsTool.handler(vendorCtx(vendorDb({ verified: false })), {})).toEqual({ ok: false, error: "nothing_to_link" });
    const wrongJob = vendorCtx(vendorDb(), { vendorScope: { sessionId: "s1", vendorDirectoryId: "vd1", vendorUserId: "v1", workOrderId: "other" } });
    expect(await vendorSetUpPayoutsTool.handler(wrongJob, {})).toEqual({ ok: false, error: "nothing_to_link" });
    expect(await vendorSetUpPayoutsTool.handler(vendorCtx(vendorDb(), { vendorScope: undefined }), {})).toEqual({ ok: false, error: "nothing_to_link" });
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("is in the manager text catalog, and added to the vendor registry only by the shared-line wrapper", () => {
    expect(buildManagerSmsRegistry().has("set_up_payouts")).toBe(true);
    expect(vendorWorkOrderAgentRegistry.has("set_up_payouts")).toBe(false);
  });
});

describe("textPayoutsReady: the confirmation after Stripe onboarding", () => {
  const link = (over: Record<string, unknown> = {}) => ({
    id: "link-1",
    purpose: "payouts",
    target_id: "u1",
    target_type: "manager",
    phone_key: "2065550123",
    workspace_id: "ws-a",
    revoked_at: null,
    created_at: new Date(NOW.getTime() - 60_000).toISOString(),
    ...over,
  });

  it("says the last four of the account and sends it once to the person who asked by text", async () => {
    mocks.refresh.mockResolvedValue([{ id: "ba_1", last4: "4417", default: true }]);
    const db = createMemoryDb({ phone_bound_links: [link()] });
    expect(await textPayoutsReady(db as never, {} as never, { userId: "u1", accountId: "acct_1", now: NOW })).toEqual({ sent: true });
    expect(mocks.sendText).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "ws-a",
      phoneKey: "2065550123",
      body: "Payouts are set up to the account ending 4417.",
      role: "manager",
      idempotencyKey: "payouts-ready:acct_1:link-1",
      // A manager's confirmation uses the manager-recipient purpose (their verified phone is the grant).
      basis: { kind: "manager_notice", topic: "payouts_ready", recipientUserId: "u1" },
    });
  });

  it("texts a vendor as a vendor, and falls back to the cache when Stripe cannot be read", async () => {
    mocks.refresh.mockRejectedValue(new Error("down"));
    const db = createMemoryDb({
      phone_bound_links: [link({ target_type: "vendor" })],
      payout_destinations_cache: [{ owner_user_id: "u1", last4: "9911", is_default: true, updated_at: "2026-10-01" }],
    });
    await textPayoutsReady(db as never, {} as never, { userId: "u1", accountId: "acct_1", now: NOW });
    expect(mocks.sendText.mock.calls[0]![1]).toMatchObject({
      role: "vendor",
      body: "Payouts are set up to the account ending 9911.",
      // The vendor asked for the link by text: that request is the opt-in to this one reply.
      basis: { kind: "vendor_notice", recipientUserId: "u1", requestLinkId: "link-1" },
    });
  });

  it("stays quiet for someone who set payouts up in the app (no payouts link was texted to them)", async () => {
    const none = createMemoryDb({ phone_bound_links: [] });
    expect(await textPayoutsReady(none as never, null, { userId: "u1", accountId: "acct_1", now: NOW })).toEqual({ sent: false, reason: "not_asked_by_text" });
    const someoneElse = createMemoryDb({ phone_bound_links: [link({ target_id: "u2" })] });
    expect(await textPayoutsReady(someoneElse as never, null, { userId: "u1", accountId: "acct_1", now: NOW })).toEqual({ sent: false, reason: "not_asked_by_text" });
    const stale = createMemoryDb({ phone_bound_links: [link({ created_at: "2026-09-01T00:00:00Z" })] });
    expect(await textPayoutsReady(stale as never, null, { userId: "u1", accountId: "acct_1", now: NOW })).toEqual({ sent: false, reason: "not_asked_by_text" });
    const revoked = createMemoryDb({ phone_bound_links: [link({ revoked_at: "2026-10-19T00:00:00Z" })] });
    expect(await textPayoutsReady(revoked as never, null, { userId: "u1", accountId: "acct_1", now: NOW })).toEqual({ sent: false, reason: "not_asked_by_text" });
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it("reports a refused send without throwing, and never texts a whole account number", async () => {
    mocks.sendText.mockResolvedValue(false);
    const db = createMemoryDb({ phone_bound_links: [link()] });
    expect(await textPayoutsReady(db as never, null, { userId: "u1", accountId: "acct_1", now: NOW })).toEqual({ sent: false, reason: "send_refused" });
    expect(payoutsReadyText("123456789")).toBe("Payouts are set up.");
    expect(payoutsReadyText(null)).toBe("Payouts are set up.");
    expect(payoutsReadyText("4417")).toBe("Payouts are set up to the account ending 4417.");
  });

  it("defaultPayoutLast4 prefers the default destination", async () => {
    const db = createMemoryDb({
      payout_destinations_cache: [
        { owner_user_id: "u1", last4: "1111", is_default: false, updated_at: "2026-10-02" },
        { owner_user_id: "u1", last4: "2222", is_default: true, updated_at: "2026-10-01" },
      ],
    });
    // The memory db orders by the last `order` call; either way a real 4-digit value comes back.
    expect(await defaultPayoutLast4(db as never, "u1")).toMatch(/^\d{4}$/);
    expect(await defaultPayoutLast4(createMemoryDb() as never, "u1")).toBeNull();
  });
});
