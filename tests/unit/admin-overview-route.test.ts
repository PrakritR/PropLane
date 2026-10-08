/**
 * GET /api/admin/overview: the admin Dashboard's server aggregate.
 *
 * Pinned here, in order of what a regression costs:
 * 1. Authorization is re-derived in the route: signed out is 401, signed in without the admin role is 403,
 *    and the service-role client is never even constructed for either.
 * 2. Sandbox/demo accounts never count toward real totals.
 * 3. A figure is a count of real rows (feedback by status, failures by window, disputes by status), and
 *    a payout gap is a manager with no linked Stripe account, not a guess.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminFakeDb, type AdminFakeDb, type Row } from "../helpers/admin-fake-db";

const isAdminUser = vi.fn();
const getUser = vi.fn();
const serviceRoleFactory = vi.fn();

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...a) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => serviceRoleFactory() }));

const { GET } = await import("@/app/api/admin/overview/route");

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function seed(): Record<string, Row[]> {
  return {
    profile_roles: [
      { user_id: "m1", role: "manager" },
      { user_id: "m2", role: "manager" },
      { user_id: "m3", role: "manager" },
      { user_id: "mSandbox", role: "manager" },
      { user_id: "r1", role: "resident" },
      { user_id: "r2", role: "resident" },
      { user_id: "rSandbox", role: "resident" },
      { user_id: "v1", role: "vendor" },
    ],
    profiles: [
      { id: "m1", email: "one@real.com", full_name: "Manager One", stripe_connect_account_id: "acct_1", application_approved: true, created_at: hoursAgo(5) },
      // Disabled: not an ACTIVE manager.
      { id: "m2", email: "two@real.com", application_approved: false, created_at: hoursAgo(50) },
      // Active, no Stripe account linked: counts as a payout gap.
      { id: "m3", email: "three@real.com", full_name: "Manager Three", application_approved: true, created_at: hoursAgo(1) },
      { id: "mSandbox", email: "demo@axis.local", application_approved: true, created_at: hoursAgo(2) },
      { id: "r1", email: "res1@real.com", created_at: hoursAgo(10) },
      { id: "r2", email: "res2@real.com", created_at: hoursAgo(11) },
      { id: "rSandbox", email: "res@test.proplane.local", created_at: hoursAgo(3) },
      { id: "v1", email: "vendor@real.com", created_at: hoursAgo(20) },
    ],
    manager_purchases: [],
    portal_bug_feedback_records: [
      { id: "f1", status: "open" },
      { id: "f2", status: "in_progress" },
      { id: "f3", status: "completed" },
      { id: "f4", status: "open" },
    ],
    sms_delivery_log: [
      { id: "s1", status: "failed", created_at: hoursAgo(2) },
      { id: "s2", status: "undelivered", created_at: hoursAgo(10) },
      { id: "s3", status: "delivered", created_at: hoursAgo(3) },
      // Older than 24h: outside the window.
      { id: "s4", status: "failed", created_at: hoursAgo(30) },
    ],
    sms_delivery_attempts: [
      { id: "a1", state: "provider_rejected", started_at: hoursAgo(4) },
      { id: "a2", state: "submitted", started_at: hoursAgo(4) },
    ],
    stripe_disputes: [
      { id: "d1", status: "needs_response" },
      { id: "d2", status: "won" },
      { id: "d3", status: "under_review" },
      { id: "d4", status: "lost" },
    ],
  };
}

let db: AdminFakeDb;

beforeEach(() => {
  isAdminUser.mockReset();
  getUser.mockReset();
  serviceRoleFactory.mockReset();
  db = createAdminFakeDb(seed());
  serviceRoleFactory.mockImplementation(() => db);
});

describe("GET /api/admin/overview", () => {
  it("is 401 when signed out, and never touches the database", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const res = await GET();
    expect(res.status).toBe(401);
    expect(serviceRoleFactory).not.toHaveBeenCalled();
  });

  it("is 403 for a signed-in account without the admin role", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "someone" } } });
    isAdminUser.mockResolvedValue(false);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(isAdminUser).toHaveBeenCalledWith("someone");
    expect(serviceRoleFactory).not.toHaveBeenCalled();
  });

  it("gives an admin the aggregates, with sandbox accounts excluded", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "admin-1" } } });
    isAdminUser.mockResolvedValue(true);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    // m1 + m3 are active; m2 is disabled; mSandbox is a demo account.
    expect(body.activeManagers).toBe(2);
    expect(body.activeResidents).toBe(2);
    expect(body.activeVendors).toBe(1);

    // Only status "open" (the Feedback page's Open tab); in progress and completed are not.
    expect(body.openFeedback).toBe(2);
  });

  it("counts failures, disputes and payout gaps from real rows", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "admin-1" } } });
    isAdminUser.mockResolvedValue(true);
    const body = await (await GET()).json();

    // 2 failed/undelivered texts inside 24h + 1 rejected attempt.
    expect(body.smsFailures24h).toBe(3);
    // needs_response + under_review are open; won / lost are done.
    expect(body.openDisputes).toBe(2);
    // m3 is the only ACTIVE manager with no Connect account (m2 is disabled, the sandbox is excluded).
    expect(body.managersWithoutPayouts).toBe(1);
  });

  it("lists the newest real sign-ups first and never a sandbox account", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "admin-1" } } });
    isAdminUser.mockResolvedValue(true);
    const body = await (await GET()).json();
    const ids = body.recentSignups.map((s: { id: string }) => s.id);
    expect(ids[0]).toBe("m3");
    expect(ids).not.toContain("mSandbox");
    expect(ids).not.toContain("rSandbox");
    expect(body.recentSignups[0]).toMatchObject({ kind: "manager", name: "Manager Three" });
  });

  it("does not read email delivery or listing review, which have no honest source", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "admin-1" } } });
    isAdminUser.mockResolvedValue(true);
    const body = await (await GET()).json();
    expect(db.touched.has("portal_outbound_mail_records")).toBe(false);
    expect(body).not.toHaveProperty("emailFailures24h");
    expect(body).not.toHaveProperty("listingsPendingReview");
  });
});
