import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

import {
  hasSelfPaidPlan,
  isManagedReadOnly,
  managedReadOnlyOwnerLocked,
  managedReadOnlyWorkspaceIds,
} from "@/lib/auth/managed-read-only.server";
import {
  MANAGED_READ_ONLY_ALLOWED_PATHS,
  managedReadOnlyBlocks,
  managedReadOnlyCandidate,
  managedReadOnlyInboxLockApplies,
  managedReadOnlyInboxThreadAllowed,
  managedReadOnlyInboxWrites,
  normalizeApiPath,
} from "@/lib/auth/managed-read-only-policy";

type Row = Record<string, unknown>;
const PAID = "2026-10-01T00:00:00Z";

/** A tiny PostgREST-shaped fake: select / eq / in / ilike / maybeSingle over in-memory tables. */
function fakeDb(tables: Record<string, Row[]>, failTable?: string): SupabaseClient {
  const from = (name: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    const run = () => {
      if (name === failTable) return { data: null, error: { message: "boom" } };
      return { data: (tables[name] ?? []).filter((r) => filters.every((f) => f(r))), error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
      ilike: (c: string, v: string) => (filters.push((r) => String(r[c] ?? "").toLowerCase() === v.toLowerCase()), b),
      maybeSingle: async () => {
        const res = run();
        return { data: (res.data as Row[] | null)?.[0] ?? null, error: res.error };
      },
      then: (resolve: (v: unknown) => unknown) => resolve(run()),
    };
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

const WS = "11111111-1111-1111-1111-111111111111";
const WS2 = "22222222-2222-2222-2222-222222222222";
const SERVICE_ADMIN = "svc-admin";

function world(over: { purchases?: Row[]; profile?: Row; roles?: Row[]; settings?: Row[]; workspaces?: Row[]; invites?: Row[] }) {
  return fakeDb({
    profiles: [over.profile ?? { id: "client", email: "ambika@example.com", role: "manager" }],
    profile_roles: over.roles ?? [],
    platform_service_settings: over.settings ?? [],
    portal_workspaces: over.workspaces ?? [{ id: WS, owner_user_id: "client", is_service: true }],
    account_link_invites: over.invites ?? [],
    manager_purchases: over.purchases ?? [],
  });
}

describe("hasSelfPaidPlan", () => {
  it("admin grant, trial, waiver, promo and an abandoned free checkout row are not self-paid", () => {
    expect(hasSelfPaidPlan([{ tier: "business", billing: "admin" } as never])).toBe(false);
    expect(hasSelfPaidPlan([{ tier: "pro", billing: "trial" } as never])).toBe(false);
    expect(hasSelfPaidPlan([{ tier: "pro", stripe_subscription_id: "  " }])).toBe(false);
    expect(hasSelfPaidPlan([{ tier: null }])).toBe(false);
    expect(hasSelfPaidPlan([{ tier: "free", billing: "monthly" } as never])).toBe(false);
    expect(hasSelfPaidPlan([])).toBe(false);
    expect(hasSelfPaidPlan(null)).toBe(false);
  });
  it("a free-tier row never counts, even with a subscription id or an apple anchor", () => {
    expect(hasSelfPaidPlan([{ tier: "free", stripe_subscription_id: "sub_1", subscription_status: "active", first_paid_at: PAID }])).toBe(false);
    expect(hasSelfPaidPlan([{ tier: "free", apple_original_transaction_id: "2000001" }])).toBe(false);
    expect(hasSelfPaidPlan([{ tier: null, stripe_subscription_id: "sub_1", subscription_status: "active", first_paid_at: PAID }])).toBe(false);
  });
  it("a pro or business row with an ACTIVE stripe subscription or an apple anchor is self-paid", () => {
    expect(hasSelfPaidPlan([{ tier: "pro", stripe_subscription_id: "sub_1", subscription_status: "active", first_paid_at: PAID }])).toBe(true);
    expect(hasSelfPaidPlan([{ tier: "Business", apple_original_transaction_id: "2000001" }])).toBe(true);
    expect(hasSelfPaidPlan([{ tier: "free" }, { tier: "pro", stripe_subscription_id: "sub_2", subscription_status: "ACTIVE", first_paid_at: PAID }])).toBe(true);
  });
  it("a card-on-file TRIAL is not self-paid: manager checkout carries trial_period_days", () => {
    // `trialing` is what fulfillment records for a Pro/Business checkout that has paid nothing. Treating the
    // subscription id alone as payment unlocked a managed workspace for the whole 14-day trial.
    expect(hasSelfPaidPlan([{ tier: "pro", stripe_subscription_id: "sub_1", subscription_status: "trialing" }])).toBe(false);
    expect(hasSelfPaidPlan([{ tier: "business", stripe_subscription_id: "sub_1", subscription_status: "incomplete" }])).toBe(false);
    expect(hasSelfPaidPlan([{ tier: "pro", stripe_subscription_id: "sub_1", subscription_status: "unpaid" }])).toBe(false);
    expect(hasSelfPaidPlan([{ tier: "pro", stripe_subscription_id: "sub_1", subscription_status: "paused" }])).toBe(false);
    expect(hasSelfPaidPlan([{ tier: "pro", stripe_subscription_id: "sub_1", subscription_status: "canceled" }])).toBe(false);
  });
  it("an unwritten status is not self-paid (fail closed), and past_due still is", () => {
    expect(hasSelfPaidPlan([{ tier: "pro", stripe_subscription_id: "sub_1" }])).toBe(false);
    expect(hasSelfPaidPlan([{ tier: "pro", stripe_subscription_id: "sub_1", subscription_status: null }])).toBe(false);
    expect(hasSelfPaidPlan([{ tier: "pro", stripe_subscription_id: "sub_1", subscription_status: "  " }])).toBe(false);
    // Money has been paid and Stripe is retrying the card: a billing problem, not a revoked plan.
    expect(hasSelfPaidPlan([{ tier: "pro", stripe_subscription_id: "sub_1", subscription_status: "past_due", first_paid_at: PAID }])).toBe(true);
    // An Apple anchor needs no Stripe status at all.
    expect(hasSelfPaidPlan([{ tier: "pro", apple_original_transaction_id: "2000001", subscription_status: null }])).toBe(true);
  });
});

describe("managedReadOnlyWorkspaceIds (mirror of the SQL rule)", () => {
  const purchasesFor = (row: Row) => [{ user_id: "client", email: "ambika@example.com", ...row }];

  it("locks the client whose plan is admin-granted (Ambika) or a trial (Vinod)", async () => {
    expect(await managedReadOnlyWorkspaceIds(world({ purchases: purchasesFor({ tier: "business", billing: "admin" }) }), "client")).toEqual([WS]);
    expect(await managedReadOnlyWorkspaceIds(world({ purchases: purchasesFor({ tier: "pro", billing: "trial" }) }), "client")).toEqual([WS]);
    expect(await managedReadOnlyWorkspaceIds(world({}), "client")).toEqual([WS]);
  });
  it("an abandoned checkout row (tier free, billing monthly, no payment) stays locked", async () => {
    expect(await managedReadOnlyWorkspaceIds(world({ purchases: purchasesFor({ tier: "free", billing: "monthly" }) }), "client")).toEqual([WS]);
    expect(await managedReadOnlyWorkspaceIds(world({ purchases: purchasesFor({ tier: "pro", billing: "annual" }) }), "client")).toEqual([WS]);
  });
  it("never matches a purchase by email: an unauthenticated insert cannot unlock", async () => {
    const db = world({ purchases: [{ user_id: null, email: "AMBIKA@example.com", tier: "pro", stripe_subscription_id: "sub_x", subscription_status: "active", first_paid_at: PAID }] });
    expect(await managedReadOnlyWorkspaceIds(db, "client")).toEqual([WS]);
    const wild = world({ profile: { id: "client", email: "%@example.com", role: "manager" }, purchases: [{ user_id: "other", email: "x@example.com", tier: "pro", stripe_subscription_id: "sub_x", subscription_status: "active", first_paid_at: PAID }] });
    expect(await managedReadOnlyWorkspaceIds(wild, "client")).toEqual([WS]);
  });
  it("an active stripe subscription on a pro row, or an apple anchor on a business row, unlocks", async () => {
    expect(await managedReadOnlyWorkspaceIds(world({ purchases: purchasesFor({ tier: "pro", stripe_subscription_id: "sub_9", subscription_status: "active", first_paid_at: PAID }) }), "client")).toEqual([]);
    expect(await managedReadOnlyWorkspaceIds(world({ purchases: purchasesFor({ tier: "business", apple_original_transaction_id: "2000009" }) }), "client")).toEqual([]);
  });
  it("the Stripe TRIAL stays locked: a card on file that has paid nothing is not a self-paid plan", async () => {
    expect(await managedReadOnlyWorkspaceIds(world({ purchases: purchasesFor({ tier: "pro", stripe_subscription_id: "sub_9", subscription_status: "trialing" }) }), "client")).toEqual([WS]);
    // The status has not been written yet (a row from before the column, or a webhook still in flight).
    expect(await managedReadOnlyWorkspaceIds(world({ purchases: purchasesFor({ tier: "pro", stripe_subscription_id: "sub_9" }) }), "client")).toEqual([WS]);
  });
  it("platform admin and the platform service owner are never locked", async () => {
    expect(await managedReadOnlyWorkspaceIds(world({ roles: [{ user_id: "client", role: "admin" }] }), "client")).toEqual([]);
    expect(await managedReadOnlyWorkspaceIds(world({ settings: [{ owner_user_id: "client" }] }), "client")).toEqual([]);
    expect(await managedReadOnlyWorkspaceIds(world({ profile: { id: "client", email: "founders@axis-seattle-housing.com" } }), "client")).toEqual([WS]);
  });

  it("the LEGACY profiles.role column never escapes the lock: only profile_roles does", async () => {
    // `profiles.role` is the role the account was created as and is kept forever, so an owner first created as
    // admin - or one whose admin row was revoked - must not keep full write.
    const legacy = world({ profile: { id: "client", email: "ambika@example.com", role: "admin" }, roles: [] });
    expect(await managedReadOnlyWorkspaceIds(legacy, "client")).toEqual([WS]);
    const real = world({ profile: { id: "client", email: "ambika@example.com", role: "manager" }, roles: [{ user_id: "client", role: "admin" }] });
    expect(await managedReadOnlyWorkspaceIds(real, "client")).toEqual([]);
  });

  it("a plan that was cancelled is no longer self-paid: the tier must be pro|business NOW", async () => {
    // Every cancellation path writes tier free and clears the id, so the row below is what a cancelled Stripe
    // subscription (or an expired Apple one) leaves behind.
    expect(hasSelfPaidPlan([{ tier: "free", stripe_subscription_id: null }])).toBe(false);
    expect(await managedReadOnlyWorkspaceIds(world({ purchases: [{ user_id: "client", tier: "free", billing: "free", stripe_subscription_id: null }] }), "client")).toEqual([WS]);
    expect(await managedReadOnlyWorkspaceIds(world({ purchases: [{ user_id: "client", tier: "free", apple_original_transaction_id: null }] }), "client")).toEqual([WS]);
  });
  it("the seated service admin member is not the owner, so is never locked", async () => {
    const db = world({
      profile: { id: SERVICE_ADMIN, email: "svc@proplane.ai", role: "manager" },
      invites: [{ invitee_user_id: SERVICE_ADMIN, inviter_user_id: "client", workspace_id: WS, status: "accepted", team_role: "admin" }],
    });
    expect(await managedReadOnlyWorkspaceIds(db, SERVICE_ADMIN)).toEqual([]);
  });
  it("a non-service workspace is never locked", async () => {
    const db = world({ workspaces: [{ id: WS, owner_user_id: "client", is_service: false }] });
    expect(await managedReadOnlyWorkspaceIds(db, "client")).toEqual([]);
  });
  it("only the service workspace of several owned is locked", async () => {
    const db = world({ workspaces: [{ id: WS, owner_user_id: "client", is_service: true }, { id: WS2, owner_user_id: "client", is_service: false }] });
    expect(await managedReadOnlyWorkspaceIds(db, "client")).toEqual([WS]);
  });
  it("an accepted property_owner seat is view-only on its workspace; a pending one is not", async () => {
    const seat = { invitee_user_id: "owner-1", inviter_user_id: "mgr", workspace_id: WS2, team_role: "property_owner" };
    expect(await managedReadOnlyWorkspaceIds(world({ invites: [{ ...seat, status: "accepted" }] }), "owner-1")).toEqual([WS2]);
    expect(await managedReadOnlyWorkspaceIds(world({ invites: [{ ...seat, status: "pending" }] }), "owner-1")).toEqual([]);
  });
  it("fails closed: a read error throws from the list and counts as locked for one workspace", async () => {
    const db = world({});
    const broken = fakeDb({ portal_workspaces: [{ id: WS, owner_user_id: "client", is_service: true }] }, "account_link_invites");
    await expect(managedReadOnlyWorkspaceIds(broken, "client")).rejects.toThrow();
    expect(await isManagedReadOnly(broken, "client", WS2)).toBe(true);
    expect(await isManagedReadOnly(db, "client", WS)).toBe(true);
    expect(await isManagedReadOnly(db, "client", WS2)).toBe(false);
  });
});

describe("managed read-only policy", () => {
  it("the allowlist is exactly this set", () => {
    expect([...MANAGED_READ_ONLY_ALLOWED_PATHS].sort()).toEqual([
      "/api/agent",
      "/api/auth",
      "/api/bug-feedback-attachments",
      "/api/cron",
      "/api/internal",
      "/api/manager/payment-methods",
      "/api/manager/plan-addons",
      "/api/manager/pricing-oauth-continue",
      "/api/manager/signup-intent",
      "/api/manager/subscription",
      "/api/native/register-push-token",
      "/api/number-subscription",
      "/api/owner/finances",
      "/api/owner/messages",
      "/api/portal-bug-feedback",
      "/api/portal-inbox-threads",
      "/api/portal/proplane-balance/withdraw",
      "/api/profile",
      "/api/public",
      "/api/resident",
      "/api/revenuecat",
      "/api/stripe",
      "/api/twilio",
      "/api/vendor",
      "/api/webhooks",
      "/api/workspaces",
    ]);
  });
  it("blocks workspace writes but allows her own account, plan purchase, money and other portals", () => {
    for (const p of ["/api/property-records", "/api/portal-work-orders", "/api/manager-documents/x", "/api/portal/lease-template", "/api/work-orders", "/api/owner/properties/p1"]) {
      expect(managedReadOnlyCandidate("POST", p), p).toBe(true);
    }
    for (const p of [
      "/api/auth/sign-out", "/api/auth/delete-my-account", "/api/profile", "/api/stripe/checkout", "/api/stripe/billing-portal",
      "/api/manager/subscription", "/api/owner/finances/withdraw", "/api/owner/finances/policy", "/api/portal/proplane-balance/withdraw",
      "/api/resident/anything", "/api/vendor/invoices", "/api/agent/chat", "/api/agent/resident-chat", "/api/agent/pending-actions",
      "/api/workspaces", "/api/native/register-push-token", "/api/portal-inbox-threads", "/api/revenuecat/webhook",
    ]) {
      expect(managedReadOnlyCandidate("POST", p), p).toBe(false);
    }
  });
  it("reads are never candidates; a lookalike prefix or encoded path does not slip through", () => {
    expect(managedReadOnlyCandidate("GET", "/api/property-records")).toBe(false);
    expect(managedReadOnlyCandidate("HEAD", "/api/property-records")).toBe(false);
    expect(managedReadOnlyCandidate("POST", "/api/profile-evil")).toBe(true);
    expect(managedReadOnlyCandidate("POST", "/api/auth/../property-records")).toBe(true);
    expect(managedReadOnlyCandidate("POST", "/api/%70roperty-records")).toBe(true);
    expect(managedReadOnlyCandidate("POST", "/api//stripe/checkout")).toBe(false);
    expect(managedReadOnlyCandidate("POST", "/portal/dashboard")).toBe(false);
  });
  it("the block is account-wide: it depends on ownership alone, never on a workspace cookie", () => {
    expect(managedReadOnlyBlocks(false)).toBe(false);
    expect(managedReadOnlyBlocks(true)).toBe(true);
  });
  it("an encoded dot-dot cannot climb out of /api and skip the check", () => {
    for (const p of [
      "/api/x/abc%2F..%2F..%2F..%2Fy",
      "/api/x/%2e%2e/%2e%2e/%2e%2e/y",
      "/API/property-records",
      "/api/../property-records",
      "/api/auth/..%2F..%2F..%2Fproperty-records",
    ]) {
      expect(managedReadOnlyCandidate("POST", p), p).toBe(true);
    }
    expect(normalizeApiPath("/api/x/abc%2F..%2F..%2F..%2Fy").startsWith("/api/")).toBe(true);
    expect(managedReadOnlyCandidate("POST", "/api/auth/sign-out")).toBe(false);
    expect(managedReadOnlyCandidate("POST", "/API/Auth/sign-out")).toBe(false);
    expect(managedReadOnlyCandidate("POST", "/portal/dashboard")).toBe(false);
  });
  it("the inbox lock runs for delete / deleteIds (no scope) and an unscoped request, not for her other portals", () => {
    const M = "axis_portal_inbox_manager_v1";
    expect(managedReadOnlyInboxLockApplies("delete", "", M)).toBe(true);
    expect(managedReadOnlyInboxLockApplies("deleteIds", "", M)).toBe(true);
    expect(managedReadOnlyInboxLockApplies("delete", "axis_portal_inbox_resident_v1", M)).toBe(true);
    expect(managedReadOnlyInboxLockApplies("upsert", M, M)).toBe(true);
    expect(managedReadOnlyInboxLockApplies("changeFolder", "", M)).toBe(true);
    expect(managedReadOnlyInboxLockApplies("upsert", "axis_portal_inbox_resident_v1", M)).toBe(false);
  });
  it("inbox: only the workspace Team chat and her Assistant thread", () => {
    expect(managedReadOnlyInboxThreadAllowed(`team-thread:client:ws:${WS}`, WS, "client", "client")).toBe(true);
    expect(managedReadOnlyInboxThreadAllowed("agent_notice_client", WS, "client", "client")).toBe(true);
    // The bare `agent_notice_` prefix used to pass for ANY id, including a staff member's own Assistant.
    expect(managedReadOnlyInboxThreadAllowed("agent_notice_staff", WS, "client", "client")).toBe(false);
    expect(managedReadOnlyInboxThreadAllowed(`team-thread:client:ws:${WS2}`, WS, "client", "client")).toBe(false);
    expect(managedReadOnlyInboxThreadAllowed("team-thread:client", WS, "client", "client")).toBe(false);
    expect(managedReadOnlyInboxThreadAllowed("resident-thread-1", WS, "client", "client")).toBe(false);
    expect(managedReadOnlyInboxThreadAllowed("", WS, "client", "client")).toBe(false);
    expect(managedReadOnlyInboxWrites({ action: "upsert", row: { id: "r1" } })).toEqual(["r1"]);
    expect(managedReadOnlyInboxWrites({ action: "replace", rows: [{ id: "a" }, {}] })).toEqual(["a", ""]);
    expect(managedReadOnlyInboxWrites({ action: "dismissContacts" })).toBeNull();
  });
});

describe("managedReadOnlyOwnerLocked (mirror of managed_read_only_owner_locked)", () => {
  it("true for the owner of a locked service workspace, false once she pays, is admin or owns none", async () => {
    expect(await managedReadOnlyOwnerLocked(world({}), "client")).toBe(true);
    expect(await managedReadOnlyOwnerLocked(world({ purchases: [{ user_id: "client", tier: "pro", stripe_subscription_id: "sub_1", subscription_status: "active", first_paid_at: PAID }] }), "client")).toBe(false);
    expect(await managedReadOnlyOwnerLocked(world({ roles: [{ user_id: "client", role: "admin" }] }), "client")).toBe(false);
    expect(await managedReadOnlyOwnerLocked(world({ workspaces: [{ id: WS, owner_user_id: "client", is_service: false }] }), "client")).toBe(false);
  });
  it("a property_owner seat does not fire the account-wide lock (it only locks its own workspace)", async () => {
    const invites = [{ invitee_user_id: "owner-1", inviter_user_id: "mgr", workspace_id: WS2, team_role: "property_owner", status: "accepted" }];
    const db = world({ invites });
    expect(await managedReadOnlyOwnerLocked(db, "owner-1")).toBe(false);
    expect(await managedReadOnlyWorkspaceIds(db, "owner-1")).toEqual([WS2]);
  });
});


describe("the SQL mirror (migration v3)", () => {
  const sql = readFileSync("supabase/migrations/20261020100000_managed_read_only_v3.sql", "utf8");

  it("replaces the lock function idempotently and reads admin off profile_roles and the ops address only", () => {
    expect(sql).toContain("create or replace function public.managed_read_only_owned_locked_ids(uid uuid)");
    expect(sql).toContain("from public.profile_roles r where r.user_id = uid and r.role = 'admin'");
    expect(sql).toContain("founders@axis-seattle-housing.com");
    // The legacy column is gone from the escape.
    expect(sql).not.toMatch(/coalesce\(p\.role/);
  });

  it("still requires a CURRENT pro|business tier alongside the Stripe or Apple anchor", () => {
    expect(sql).toContain("lower(btrim(coalesce(mp.tier, ''))) in ('pro', 'business')");
    expect(sql).toContain("mp.stripe_subscription_id");
    expect(sql).toContain("mp.apple_original_transaction_id");
  });
});

describe("self-paid needs money that actually moved (first_paid_at)", () => {
  const purchasesFor = (row: Row) => [{ user_id: "client", email: "ambika@example.com", ...row }];
  it("a trial that rolled to past_due with no paid invoice is NOT self-paid", () => {
    expect(hasSelfPaidPlan([{ tier: "pro", stripe_subscription_id: "sub_1", subscription_status: "past_due", first_paid_at: null }])).toBe(false);
    expect(hasSelfPaidPlan([{ tier: "pro", stripe_subscription_id: "sub_1", subscription_status: "past_due" }])).toBe(false);
  });
  it("a 100%-off promotion that is `active` at $0 is NOT self-paid", () => {
    expect(hasSelfPaidPlan([{ tier: "business", stripe_subscription_id: "sub_1", subscription_status: "active", first_paid_at: null }])).toBe(false);
    expect(hasSelfPaidPlan([{ tier: "business", stripe_subscription_id: "sub_1", subscription_status: "active", first_paid_at: "  " }])).toBe(false);
  });
  it("a real paid invoice, then past_due, is self-paid; an Apple anchor needs no payment stamp", () => {
    expect(hasSelfPaidPlan([{ tier: "pro", stripe_subscription_id: "sub_1", subscription_status: "past_due", first_paid_at: PAID }])).toBe(true);
    expect(hasSelfPaidPlan([{ tier: "pro", apple_original_transaction_id: "2000001", first_paid_at: null }])).toBe(true);
  });
  it("the workspace lock follows: past_due with no payment is view-only, with a payment it is not", async () => {
    const trial = purchasesFor({ tier: "pro", stripe_subscription_id: "sub_9", subscription_status: "past_due" });
    expect(await managedReadOnlyWorkspaceIds(world({ purchases: trial }), "client")).toEqual([WS]);
    const free100 = purchasesFor({ tier: "pro", stripe_subscription_id: "sub_9", subscription_status: "active", first_paid_at: null });
    expect(await managedReadOnlyWorkspaceIds(world({ purchases: free100 }), "client")).toEqual([WS]);
    const paid = purchasesFor({ tier: "pro", stripe_subscription_id: "sub_9", subscription_status: "past_due", first_paid_at: PAID });
    expect(await managedReadOnlyWorkspaceIds(world({ purchases: paid }), "client")).toEqual([]);
    const apple = purchasesFor({ tier: "business", apple_original_transaction_id: "2000009" });
    expect(await managedReadOnlyWorkspaceIds(world({ purchases: apple }), "client")).toEqual([]);
  });
});

describe("the SQL mirror: first_paid_at (migration 20261020140000)", () => {
  const sql = readFileSync("supabase/migrations/20261020140000_manager_purchase_first_paid.sql", "utf8");
  it("adds the column idempotently, replaces the lock function and keeps the revoke", () => {
    expect(sql).toContain("add column if not exists first_paid_at timestamptz");
    expect(sql).toContain("create or replace function public.managed_read_only_owned_locked_ids(uid uuid)");
    expect(sql).toContain("revoke all on function public.managed_read_only_owned_locked_ids(uuid) from public, anon, authenticated;");
  });
  it("requires first_paid_at inside the Stripe branch only", () => {
    const stripeIdx = sql.indexOf("btrim(coalesce(mp.stripe_subscription_id, '')) <> ''");
    const paidIdx = sql.indexOf("mp.first_paid_at is not null");
    expect(paidIdx).toBeGreaterThan(stripeIdx);
    expect(sql.indexOf("btrim(coalesce(mp.apple_original_transaction_id, '')) <> ''")).toBeLessThan(stripeIdx);
    expect(sql).toContain("lower(btrim(coalesce(mp.subscription_status, ''))) in ('active', 'past_due')");
  });
});

describe("the SQL mirror: a trialing subscription is not self-paid (migration 20261020130000)", () => {
  const sql = readFileSync("supabase/migrations/20261020130000_manager_purchase_subscription_status.sql", "utf8");

  it("adds the status column idempotently and replaces the lock function", () => {
    expect(sql).toContain("add column if not exists subscription_status text");
    expect(sql).toContain("create or replace function public.managed_read_only_owned_locked_ids(uid uuid)");
    expect(sql).toContain("revoke all on function public.managed_read_only_owned_locked_ids(uuid) from public, anon, authenticated;");
  });

  it("requires active|past_due beside the Stripe id, and leaves the Apple anchor alone", () => {
    expect(sql).toContain("lower(btrim(coalesce(mp.subscription_status, ''))) in ('active', 'past_due')");
    const stripeBranch = sql.slice(sql.indexOf("btrim(coalesce(mp.stripe_subscription_id, '')) <> ''"));
    expect(stripeBranch.slice(0, 200)).toContain("mp.subscription_status");
    const appleBranch = sql.indexOf("btrim(coalesce(mp.apple_original_transaction_id, '')) <> ''");
    expect(appleBranch).toBeGreaterThan(-1);
    expect(appleBranch).toBeLessThan(sql.indexOf("btrim(coalesce(mp.stripe_subscription_id, '')) <> ''"));
  });
});
