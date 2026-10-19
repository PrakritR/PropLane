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
    expect(hasSelfPaidPlan([{ tier: "free", stripe_subscription_id: "sub_1" }])).toBe(false);
    expect(hasSelfPaidPlan([{ tier: "free", apple_original_transaction_id: "2000001" }])).toBe(false);
    expect(hasSelfPaidPlan([{ tier: null, stripe_subscription_id: "sub_1" }])).toBe(false);
  });
  it("a pro or business row with a stripe subscription or an apple anchor is self-paid", () => {
    expect(hasSelfPaidPlan([{ tier: "pro", stripe_subscription_id: "sub_1" }])).toBe(true);
    expect(hasSelfPaidPlan([{ tier: "Business", apple_original_transaction_id: "2000001" }])).toBe(true);
    expect(hasSelfPaidPlan([{ tier: "free" }, { tier: "pro", stripe_subscription_id: "sub_2" }])).toBe(true);
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
    const db = world({ purchases: [{ user_id: null, email: "AMBIKA@example.com", tier: "pro", stripe_subscription_id: "sub_x" }] });
    expect(await managedReadOnlyWorkspaceIds(db, "client")).toEqual([WS]);
    const wild = world({ profile: { id: "client", email: "%@example.com", role: "manager" }, purchases: [{ user_id: "other", email: "x@example.com", tier: "pro", stripe_subscription_id: "sub_x" }] });
    expect(await managedReadOnlyWorkspaceIds(wild, "client")).toEqual([WS]);
  });
  it("a stripe subscription on a pro row, or an apple anchor on a business row, unlocks", async () => {
    expect(await managedReadOnlyWorkspaceIds(world({ purchases: purchasesFor({ tier: "pro", stripe_subscription_id: "sub_9" }) }), "client")).toEqual([]);
    expect(await managedReadOnlyWorkspaceIds(world({ purchases: purchasesFor({ tier: "business", apple_original_transaction_id: "2000009" }) }), "client")).toEqual([]);
  });
  it("platform admin and the platform service owner are never locked", async () => {
    expect(await managedReadOnlyWorkspaceIds(world({ roles: [{ user_id: "client", role: "admin" }] }), "client")).toEqual([]);
    expect(await managedReadOnlyWorkspaceIds(world({ settings: [{ owner_user_id: "client" }] }), "client")).toEqual([]);
    expect(await managedReadOnlyWorkspaceIds(world({ profile: { id: "client", email: "founders@axis-seattle-housing.com" } }), "client")).toEqual([]);
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
    const broken = fakeDb({ portal_workspaces: [{ id: WS, owner_user_id: "client", is_service: true }] }, "profiles");
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
    expect(managedReadOnlyInboxThreadAllowed(`team-thread:client:ws:${WS}`, WS, "client")).toBe(true);
    expect(managedReadOnlyInboxThreadAllowed("agent_notice_client", WS, "client")).toBe(true);
    expect(managedReadOnlyInboxThreadAllowed(`team-thread:client:ws:${WS2}`, WS, "client")).toBe(false);
    expect(managedReadOnlyInboxThreadAllowed("team-thread:client", WS, "client")).toBe(false);
    expect(managedReadOnlyInboxThreadAllowed("resident-thread-1", WS, "client")).toBe(false);
    expect(managedReadOnlyInboxThreadAllowed("", WS, "client")).toBe(false);
    expect(managedReadOnlyInboxWrites({ action: "upsert", row: { id: "r1" } })).toEqual(["r1"]);
    expect(managedReadOnlyInboxWrites({ action: "replace", rows: [{ id: "a" }, {}] })).toEqual(["a", ""]);
    expect(managedReadOnlyInboxWrites({ action: "dismissContacts" })).toBeNull();
  });
});

describe("managedReadOnlyOwnerLocked (mirror of managed_read_only_owner_locked)", () => {
  it("true for the owner of a locked service workspace, false once she pays, is admin or owns none", async () => {
    expect(await managedReadOnlyOwnerLocked(world({}), "client")).toBe(true);
    expect(await managedReadOnlyOwnerLocked(world({ purchases: [{ user_id: "client", tier: "pro", stripe_subscription_id: "sub_1" }] }), "client")).toBe(false);
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
