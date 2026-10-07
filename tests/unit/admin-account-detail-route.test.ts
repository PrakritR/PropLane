/**
 * GET /api/admin/accounts/[id]: one account's record for the admin portal.
 *
 * The id is a PATH parameter, which makes it input, not authorization: the route has to prove the
 * caller is an admin on its own, refuse anything that is not a UUID before a query is built from it,
 * and 404 an account that does not exist. What it returns must be scoped to that one account and
 * must never carry auth secrets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminFakeDb, type AdminFakeDb, type Row } from "../helpers/admin-fake-db";

const isAdminUser = vi.fn();
const getUser = vi.fn();
const serviceRoleFactory = vi.fn();

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...a) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => serviceRoleFactory() }));

const { GET } = await import("@/app/api/admin/accounts/[id]/route");

const MGR = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const DEMO = "33333333-3333-4333-8333-333333333333";
const MISSING = "44444444-4444-4444-8444-444444444444";

function seed(): Record<string, Row[]> {
  return {
    profiles: [
      {
        id: MGR,
        email: "owner@real.com",
        full_name: "Ora Owner",
        phone: "+12065550100",
        manager_id: "AXIS-100200",
        role: "manager",
        application_approved: true,
        created_at: "2026-09-01T10:00:00.000Z",
        stripe_connect_account_id: "acct_secretish",
      },
      { id: OTHER, email: "other@real.com", full_name: "Other", role: "manager" },
      { id: DEMO, email: "demo@axis.local", full_name: "Demo" },
    ],
    profile_roles: [
      { user_id: MGR, role: "manager" },
      { user_id: MGR, role: "resident" },
      { user_id: OTHER, role: "manager" },
    ],
    manager_purchases: [
      { id: "p1", user_id: MGR, email: "owner@real.com", tier: "pro", billing: "monthly", paid_at: "2026-09-02T00:00:00.000Z" },
      { id: "p2", user_id: OTHER, email: "other@real.com", tier: "business", billing: "annual", paid_at: "2026-09-02T00:00:00.000Z" },
    ],
    portal_workspaces: [
      { id: "w1", owner_user_id: MGR, name: "Home base", is_default: true, created_at: "2026-09-01T10:00:00.000Z", stripe_connect_payouts_enabled: true },
      { id: "w2", owner_user_id: OTHER, name: "Not mine", is_default: true },
    ],
    account_link_invites: [
      { id: "l1", status: "accepted", inviter_user_id: MGR, invitee_user_id: OTHER, tab_kind: "manager", invitee_display_name: "Other", inviter_display_name: "Ora Owner", assigned_property_ids: ["a", "b"], responded_at: "2026-09-10T00:00:00.000Z" },
      { id: "l2", status: "pending", inviter_user_id: MGR, invitee_user_id: OTHER, tab_kind: "manager" },
    ],
    stripe_payouts: [
      { id: "po1", manager_user_id: MGR, status: "paid", amount_cents: 125000, created_at: "2026-09-20T00:00:00.000Z" },
      { id: "po2", manager_user_id: OTHER, status: "paid", amount_cents: 999, created_at: "2026-09-20T00:00:00.000Z" },
    ],
    stripe_disputes: [
      { id: "di1", manager_user_id: MGR, status: "needs_response", amount_cents: 5000, reason: "fraudulent", created_at: "2026-09-21T00:00:00.000Z" },
    ],
    sms_delivery_log: [
      { id: "sl1", manager_user_id: MGR, to_phone: "+12065559999", status: "failed", error_code: "30008", created_at: "2026-09-22T00:00:00.000Z" },
      { id: "sl2", manager_user_id: OTHER, to_phone: "+12065550000", status: "delivered", created_at: "2026-09-22T00:00:00.000Z" },
    ],
    sms_outbox: [],
    portal_outbound_mail_records: [
      { id: "mail1", recipient_email: "owner@real.com", subject: "Welcome", created_at: "2026-09-01T11:00:00.000Z", emailSent: "true" },
    ],
    audit_log: [
      { id: "au1", actor_user_id: MGR, landlord_id: MGR, action: "send_reminder", tool_name: "send_rent_reminder", created_at: "2026-09-23T00:00:00.000Z" },
      { id: "au2", actor_user_id: "admin-x", landlord_id: MGR, action: "billing_override", created_at: "2026-09-24T00:00:00.000Z" },
      { id: "au3", actor_user_id: OTHER, landlord_id: OTHER, action: "someone_elses", created_at: "2026-09-25T00:00:00.000Z" },
    ],
    portal_bug_feedback_records: [
      { id: "fb1", reporter_user_id: MGR, report_type: "bug", created_at: "2026-09-26T00:00:00.000Z", title: "Button broken", status: "open" },
      { id: "fb2", reporter_user_id: OTHER, report_type: "bug", created_at: "2026-09-26T00:00:00.000Z", title: "Not mine", status: "open" },
    ],
  };
}

let db: AdminFakeDb;
const call = (id: string) =>
  GET(new Request(`https://prop-lane.space/api/admin/accounts/${id}`), { params: Promise.resolve({ id }) });
const asAdmin = () => {
  getUser.mockResolvedValue({ data: { user: { id: "admin-1" } } });
  isAdminUser.mockResolvedValue(true);
};

beforeEach(() => {
  isAdminUser.mockReset();
  getUser.mockReset();
  serviceRoleFactory.mockReset();
  db = createAdminFakeDb(seed(), {
    [MGR]: { last_sign_in_at: "2026-10-05T08:00:00.000Z", email_confirmed_at: "2026-09-01T10:05:00.000Z" },
  });
  serviceRoleFactory.mockImplementation(() => db);
});

afterEach(() => {
  delete process.env.POSTHOG_PROJECT_ID;
  delete process.env.LANGFUSE_PROJECT_ID;
});

describe("GET /api/admin/accounts/[id]", () => {
  it("is 401 signed out and 403 without the admin role, before any read", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await call(MGR)).status).toBe(401);

    getUser.mockResolvedValue({ data: { user: { id: "mgr" } } });
    isAdminUser.mockResolvedValue(false);
    expect((await call(MGR)).status).toBe(403);
    expect(serviceRoleFactory).not.toHaveBeenCalled();
  });

  it("refuses an id that is not a UUID without querying", async () => {
    asAdmin();
    for (const bad of ["1", "x,landlord_id.eq.1", "../../etc", `${MGR}%2Cactor_user_id.eq.${OTHER}`]) {
      expect((await call(bad)).status).toBe(404);
    }
    expect(db.touched.size).toBe(0);
  });

  it("404s an account that does not exist, and a sandbox account", async () => {
    asAdmin();
    expect((await call(MISSING)).status).toBe(404);
    expect((await call(DEMO)).status).toBe(404);
  });

  it("returns the account's identity, roles and status", async () => {
    asAdmin();
    const res = await call(MGR);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: MGR,
      email: "owner@real.com",
      fullName: "Ora Owner",
      phone: "+12065550100",
      propLaneId: "AXIS-100200",
      status: "active",
      createdAt: "2026-09-01T10:00:00.000Z",
      lastSignInAt: "2026-10-05T08:00:00.000Z",
      emailConfirmed: true,
    });
    expect(body.roles).toEqual(["manager", "resident"]);
    expect(body.manager).toEqual({ tier: "pro", billing: "monthly" });
  });

  it("scopes workspaces, payments, communication, audit and feedback to that one account", async () => {
    asAdmin();
    const body = await (await call(MGR)).json();

    expect(body.workspaces.owned.map((w: { id: string }) => w.id)).toEqual(["w1"]);
    // Only the accepted link, not the pending one.
    expect(body.workspaces.links.map((l: { id: string }) => l.id)).toEqual(["l1"]);
    expect(body.workspaces.links[0]).toMatchObject({ relation: "inviter", counterpartName: "Other", propertyCount: 2 });

    expect(body.payments.connectLinked).toBe(true);
    expect(body.payments.payouts.map((p: { id: string }) => p.id)).toEqual(["po1"]);
    expect(body.payments.disputes.map((d: { id: string }) => d.id)).toEqual(["di1"]);

    const comms = body.communications.map((c: { id: string }) => c.id);
    expect(comms).toContain("log-sl1");
    expect(comms).toContain("mail-mail1");
    expect(comms).not.toContain("log-sl2");
    const failedText = body.communications.find((c: { id: string }) => c.id === "log-sl1");
    expect(failedText).toMatchObject({ status: "failed", errorCode: "30008", channel: "sms" });
    // A phone is masked to its last four digits.
    expect(failedText.summary).toBe("Text to •••• 9999");

    // Actor OR landlord, newest first, and nothing from another account.
    expect(body.audit.map((a: { id: string }) => a.id)).toEqual(["au2", "au1"]);
    expect(body.audit.find((a: { id: string }) => a.id === "au1").byAccount).toBe(true);
    expect(body.audit.find((a: { id: string }) => a.id === "au2").byAccount).toBe(false);

    expect(body.support.feedback.map((f: { id: string }) => f.id)).toEqual(["fb1"]);
  });

  it("never returns auth secrets or the raw Stripe account id", async () => {
    asAdmin();
    const text = JSON.stringify(await (await call(MGR)).json());
    expect(text).not.toMatch(/password|encrypted|token|secret|refresh|acct_/i);
  });

  it("omits the PostHog and Langfuse links unless they are configured, and builds them from config when they are", async () => {
    asAdmin();
    const bare = await (await call(MGR)).json();
    expect(bare.support.sessionReplaysUrl).toBeNull();
    expect(bare.support.aiTracesUrl).toBeNull();

    process.env.POSTHOG_PROJECT_ID = "492655";
    process.env.LANGFUSE_PROJECT_ID = "proj_abc";
    const configured = await (await call(MGR)).json();
    expect(configured.support.sessionReplaysUrl).toBe(
      `https://us.posthog.com/project/492655/person/${MGR}#activeTab=sessionRecordings`,
    );
    expect(configured.support.aiTracesUrl).toBe(`https://us.cloud.langfuse.com/project/proj_abc/users/${MGR}`);
  });
});
