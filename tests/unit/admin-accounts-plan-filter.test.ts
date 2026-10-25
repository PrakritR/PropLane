/**
 * Accounts > Managers gained the Plan filter (Paid, Trial, Promo, Free) when the Subscribers page went (Oct 25).
 * The bucket is decided by the SAME classifier the Dashboard cards count, the search term also matches the promo
 * code an account used (a promo code's "View accounts" link), and only a platform admin can ask.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminFakeDb, type AdminFakeDb, type Row } from "../helpers/admin-fake-db";

const isAdminUser = vi.fn();
const getUser = vi.fn();
const serviceRoleFactory = vi.fn();

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...a) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => serviceRoleFactory() }));

const { GET } = await import("@/app/api/admin/accounts/search/route");
const { accountPlanFromParam } = await import("@/lib/admin/admin-accounts-search.server");

const NOW = Date.now();
const iso = (days: number) => new Date(NOW + days * 86_400_000).toISOString();

const seed = (): Record<string, Row[]> => ({
  profile_roles: [
    { user_id: "m-paid", role: "manager" },
    { user_id: "m-trial", role: "manager" },
    { user_id: "m-promo", role: "manager" },
    { user_id: "m-free", role: "manager" },
    { user_id: "r1", role: "resident" },
  ],
  profiles: [
    { id: "m-paid", email: "paid@real.com", full_name: "Paid Co", manager_id: "AXIS-1", application_approved: true, created_at: iso(-90) },
    { id: "m-trial", email: "trial@real.com", full_name: "Trial Co", manager_id: "AXIS-2", application_approved: true, created_at: iso(-3) },
    { id: "m-promo", email: "promo@real.com", full_name: "Promo Co", manager_id: "AXIS-3", application_approved: false, created_at: iso(-20) },
    { id: "m-free", email: "free@real.com", full_name: "Free Co", manager_id: "AXIS-4", application_approved: true, created_at: iso(-10) },
    { id: "r1", email: "res@real.com", full_name: "Res", manager_id: "AXIS-5", created_at: iso(-5) },
  ],
  manager_purchases: [
    { id: "p1", user_id: "m-paid", email: "paid@real.com", tier: "pro", billing: "monthly", paid_at: iso(-40), stripe_subscription_id: "sub_1" },
    { id: "p2", user_id: "m-trial", email: "trial@real.com", tier: "pro", billing: "trial", paid_at: iso(-3) },
    { id: "p3", user_id: "m-promo", email: "promo@real.com", tier: "pro", billing: "monthly", paid_at: iso(-20), promo_code: "FREE100" },
  ],
  manager_automation_settings: [],
  portal_workspaces: [],
});

let db: AdminFakeDb;
const search = (qs: string) => GET(new Request(`https://prop-lane.space/api/admin/accounts/search?${qs}`));
const ids = (body: { rows: { id: string }[] }) => body.rows.map((r) => r.id).sort();

beforeEach(() => {
  isAdminUser.mockReset();
  getUser.mockReset();
  serviceRoleFactory.mockReset();
  db = createAdminFakeDb(seed());
  serviceRoleFactory.mockImplementation(() => db);
  getUser.mockResolvedValue({ data: { user: { id: "admin-1" } } });
  isAdminUser.mockResolvedValue(true);
});

describe("accountPlanFromParam", () => {
  it("accepts only the four buckets", () => {
    expect(accountPlanFromParam("PAID")).toBe("paid");
    expect(accountPlanFromParam("promo")).toBe("promo");
    expect(accountPlanFromParam("all")).toBeNull();
    expect(accountPlanFromParam("nonsense")).toBeNull();
    expect(accountPlanFromParam(null)).toBeNull();
  });
});

describe("Accounts role tabs (no Accounts | Subscribers strip any more)", () => {
  it("lists Managers, Residents, Vendors and, for an operator only, Test after Vendors", async () => {
    const { adminAccountRoleTabs } = await import("@/components/portal/admin-axis-users-client");
    const plain = adminAccountRoleTabs({ showTestTab: false });
    expect(plain.map((t) => t.label)).toEqual(["Managers", "Residents", "Vendors"]);
    const operator = adminAccountRoleTabs({ counts: { manager: 3, resident: 2, vendor: 1 }, showTestTab: true });
    expect(operator.map((t) => [t.label, t.count])).toEqual([
      ["Managers", 3],
      ["Residents", 2],
      ["Vendors", 1],
      ["Test", undefined],
    ]);
    expect(operator[3]!.href).toBe("/admin/test-accounts");
    expect(operator[0]!.href).toBe("/admin/axis-users?category=management");
  });
});

describe("GET /api/admin/accounts/search?plan=", () => {
  it.each([
    ["paid", ["m-paid"]],
    ["trial", ["m-trial"]],
    ["promo", ["m-promo"]],
    ["free", ["m-free"]],
  ])("lists only the %s managers", async (plan, expected) => {
    const body = await (await search(`kind=manager&plan=${plan}`)).json();
    expect(ids(body)).toEqual(expected);
    // The manager tab counts the bucket; the other tabs keep their ordinary counts.
    expect(body.counts.manager).toBe(expected.length);
    expect(body.counts.resident).toBe(1);
  });

  it("counts a disabled account under the manager count but not the Active pill", async () => {
    const body = await (await search("kind=manager&plan=promo")).json();
    expect(body.counts.manager).toBe(1);
    expect(body.activeCounts.manager).toBe(0);
    expect(body.rows[0]).toMatchObject({ id: "m-promo", active: false });
  });

  it("finds the accounts that used a promo code (the promo codes page link)", async () => {
    const body = await (await search("kind=manager&plan=promo&q=free100")).json();
    expect(ids(body)).toEqual(["m-promo"]);
    const none = await (await search("kind=manager&plan=paid&q=free100")).json();
    expect(ids(none)).toEqual([]);
  });

  it("still matches name and PropLane ID inside a plan", async () => {
    expect(ids(await (await search("kind=manager&plan=paid&q=Paid%20Co")).json())).toEqual(["m-paid"]);
    expect(ids(await (await search("kind=manager&plan=free&q=AXIS-4")).json())).toEqual(["m-free"]);
  });

  it("ignores an unknown plan and lists everyone, and ignores a plan on residents", async () => {
    expect(ids(await (await search("kind=manager&plan=bogus")).json())).toEqual(["m-free", "m-paid", "m-promo", "m-trial"]);
    expect(ids(await (await search("kind=resident&plan=paid")).json())).toEqual(["r1"]);
  });

  it("is 401 signed out and 403 for a non-admin, before reading anything", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await search("kind=manager&plan=paid")).status).toBe(401);
    getUser.mockResolvedValue({ data: { user: { id: "x" } } });
    isAdminUser.mockResolvedValue(false);
    expect((await search("kind=manager&plan=paid")).status).toBe(403);
    expect(serviceRoleFactory).not.toHaveBeenCalled();
  });
});
