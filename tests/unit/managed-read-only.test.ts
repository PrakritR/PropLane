import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

import {
  hasSelfPaidPlan,
  isManagedReadOnly,
  managedReadOnlyWorkspaceIds,
} from "@/lib/auth/managed-read-only.server";
import {
  MANAGED_READ_ONLY_ALLOWED_PATHS,
  managedReadOnlyBlocks,
  managedReadOnlyCandidate,
  managedReadOnlyInboxThreadAllowed,
  managedReadOnlyInboxWrites,
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
  it("admin grant, trial, waiver and promo are not self-paid", () => {
    expect(hasSelfPaidPlan([{ billing: "admin" }])).toBe(false);
    expect(hasSelfPaidPlan([{ billing: "trial" }])).toBe(false);
    expect(hasSelfPaidPlan([{ billing: "waiver", stripe_subscription_id: "  " }])).toBe(false);
    expect(hasSelfPaidPlan([{ billing: null }])).toBe(false);
    expect(hasSelfPaidPlan([])).toBe(false);
    expect(hasSelfPaidPlan(null)).toBe(false);
  });
  it("a stripe subscription, monthly, annual or an apple anchor is self-paid", () => {
    expect(hasSelfPaidPlan([{ stripe_subscription_id: "sub_1" }])).toBe(true);
    expect(hasSelfPaidPlan([{ billing: "monthly" }])).toBe(true);
    expect(hasSelfPaidPlan([{ billing: "Annual" }])).toBe(true);
    expect(hasSelfPaidPlan([{ apple_original_transaction_id: "2000001" }])).toBe(true);
    expect(hasSelfPaidPlan([{ billing: "trial" }, { billing: "monthly" }])).toBe(true);
  });
});

describe("managedReadOnlyWorkspaceIds (mirror of the SQL rule)", () => {
  const purchasesFor = (row: Row) => [{ user_id: "client", email: "ambika@example.com", ...row }];

  it("locks the client whose plan is admin-granted (Ambika) or a trial (Vinod)", async () => {
    expect(await managedReadOnlyWorkspaceIds(world({ purchases: purchasesFor({ tier: "business", billing: "admin" }) }), "client")).toEqual([WS]);
    expect(await managedReadOnlyWorkspaceIds(world({ purchases: purchasesFor({ tier: "pro", billing: "trial" }) }), "client")).toEqual([WS]);
    expect(await managedReadOnlyWorkspaceIds(world({}), "client")).toEqual([WS]);
  });
  it("matches a purchase by email when user_id was never linked", async () => {
    const db = world({ purchases: [{ user_id: null, email: "AMBIKA@example.com", billing: "annual" }] });
    expect(await managedReadOnlyWorkspaceIds(db, "client")).toEqual([]);
  });
  it("a self-paid plan unlocks", async () => {
    expect(await managedReadOnlyWorkspaceIds(world({ purchases: purchasesFor({ stripe_subscription_id: "sub_9" }) }), "client")).toEqual([]);
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
  it("blocks on a locked cookie or no cookie, passes on an unlocked workspace cookie", () => {
    expect(managedReadOnlyBlocks([], undefined)).toBe(false);
    expect(managedReadOnlyBlocks([WS], undefined)).toBe(true);
    expect(managedReadOnlyBlocks([WS], WS)).toBe(true);
    expect(managedReadOnlyBlocks([WS], WS2)).toBe(false);
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
