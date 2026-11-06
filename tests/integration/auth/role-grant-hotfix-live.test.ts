/**
 * Opt-in rehearsal of SECURITY HOTFIX 2 against a REAL dev/test Supabase project, because every other suite for it
 * runs on a fake database and so can never prove what an attacker actually ends up holding.
 *
 * The attack it closes: sign up with somebody else's legacy `manager_purchases` address, never prove the mailbox, and
 * stamp `user_metadata.role = "admin"` on the way in (self-writable at signup). Before the fix that address alone was
 * ownership — the sign-in resolver adopted the stranger's workspace, `reconcileAuthAccountsByEmail` claimed the
 * purchase row and auto-confirmed the address, and the manager Google-services route accepted the metadata role.
 *
 * Each scenario drives the real sign-in destination resolver and the real route handler against the live database,
 * then reads back the rows that decide access (`profile_roles`, `profiles.manager_id`, `manager_purchases.user_id`,
 * `auth.users.email_confirmed_at`) so the evidence is persisted state, not a mock's call log.
 *
 * Skipped unless `ROLE_GRANT_HOTFIX_LIVE_DB=1`, and it refuses to run against anything but the dev/test project, so
 * CI and a plain `npm run test:unit` are untouched. Run it with:
 *
 *   ROLE_GRANT_HOTFIX_LIVE_DB=1 npx vitest run tests/integration/auth/role-grant-hotfix-live.test.ts
 *
 * Everything it creates is torn down in `afterAll`.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const DEV_TEST_PROJECT_REF = "emstjswhotsnyksqhqyf";
const enabled = process.env.ROLE_GRANT_HOTFIX_LIVE_DB === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (enabled && !url.includes(DEV_TEST_PROJECT_REF)) {
  throw new Error(`ROLE_GRANT_HOTFIX_LIVE_DB only runs against the dev/test project (${DEV_TEST_PROJECT_REF}).`);
}

/** The signed-in Auth user the mocked route session hands back, swapped per scenario. */
const session: { user: User | null } = { user: null };
/** The live service-role client the route reaches for, set in `beforeAll`. */
const live: { db: SupabaseClient | null } = { db: null };

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: session.user } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => live.db }));
// The only boundary stubbed: the Google payload the route returns AFTER it has authorized. The authorization read
// itself (`profile_roles`) goes to the live database.
vi.mock("@/lib/auth/manager-google-services-onboarding.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadGoogleServicesOnboardingStatus: async () => ({
    dismissed: false,
    pending: true,
    calendarConnected: false,
    calendarConfigured: false,
    calendarEmail: null,
  }),
}));

/** The rehearsal is read by a human, so it narrates what really happened on the database as it goes. */
const transcript: string[] = [];
const note = (line: string) => {
  transcript.push(line);
  console.log(line);
};

const suite = enabled ? describe : describe.skip;

suite("SECURITY HOTFIX 2 on the dev/test database: a role is never granted from an unproven mailbox", () => {
  // Creating auth users plus the resolver round trips are several real network calls.
  vi.setConfig({ testTimeout: 180_000 });

  const tag = randomUUID().slice(0, 8);
  const legacyEmail = `hotfix2-legacy-${tag}@proplane.test`;
  const claimedEmail = `hotfix2-claimed-${tag}@proplane.test`;
  const legacyManagerId = `mgr_hf2_${tag}`;
  const claimedManagerId = `mgr_hf2c_${tag}`;

  let db: SupabaseClient;
  let attacker: User;
  /** Holds the address of a purchase row that a DIFFERENT account already claimed. */
  let latecomer: User;
  /** The account that legitimately owns the `claimedEmail` purchase row. */
  let incumbent: User;
  const purchaseIds: string[] = [];
  /** Extra accounts a scenario creates on the way, torn down with the rest. */
  const driftUsers: User[] = [];

  const createUser = async (email: string, opts: { confirmed: boolean; metadataRole?: string }) => {
    const { data, error } = await db.auth.admin.createUser({
      email,
      password: `Hf2-${randomUUID()}`,
      email_confirm: opts.confirmed,
      user_metadata: opts.metadataRole ? { role: opts.metadataRole, full_name: "Hotfix Two" } : { full_name: "Hotfix Two" },
    });
    if (error || !data.user) throw error ?? new Error(`could not create ${email}`);
    return data.user;
  };

  const refetch = async (id: string): Promise<User> => {
    const { data, error } = await db.auth.admin.getUserById(id);
    if (error || !data.user) throw error ?? new Error(`could not read ${id}`);
    return data.user;
  };

  const seedPurchase = async (email: string, managerId: string, userId: string | null) => {
    const { data, error } = await db
      .from("manager_purchases")
      .insert({
        email,
        manager_id: managerId,
        tier: "business",
        billing: "monthly",
        // Not an `axis_intent_…` id, so the signup counts as COMPLETE and the row is a live entitlement.
        stripe_checkout_session_id: `cs_live_hf2_${randomUUID().slice(0, 12)}`,
        paid_at: new Date("2026-02-01T00:00:00.000Z").toISOString(),
        user_id: userId,
        full_name: "Legacy Owner",
      })
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("could not seed purchase");
    purchaseIds.push(data.id);
    return data.id as string;
  };

  /** What the account actually HOLDS on the database after a sign-in. */
  const accessState = async (userId: string) => {
    const [{ data: roleRows }, { data: profile }, user] = await Promise.all([
      db.from("profile_roles").select("role").eq("user_id", userId),
      db.from("profiles").select("role, manager_id").eq("id", userId).maybeSingle(),
      refetch(userId),
    ]);
    return {
      roles: (roleRows ?? []).map((r) => String(r.role)).sort(),
      profileRole: profile?.role ?? null,
      managerId: profile?.manager_id ?? null,
      emailConfirmedAt: user.email_confirmed_at ?? null,
    };
  };

  const purchaseOwner = async (id: string) => {
    const { data } = await db.from("manager_purchases").select("user_id").eq("id", id).maybeSingle();
    return data?.user_id ?? null;
  };

  const googleServicesStatus = async (user: User) => {
    session.user = user;
    const { GET } = await import("@/app/api/auth/manager-google-services/route");
    const res = await GET();
    return { status: res.status, body: await res.json() };
  };

  beforeAll(async () => {
    const { createClient } = await import("@supabase/supabase-js");
    db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    live.db = db;

    attacker = await createUser(legacyEmail, { confirmed: false, metadataRole: "admin" });
    incumbent = await createUser(`hotfix2-incumbent-${tag}@proplane.test`, { confirmed: true });
    latecomer = await createUser(claimedEmail, { confirmed: true });

    await seedPurchase(legacyEmail, legacyManagerId, null);
    await seedPurchase(claimedEmail, claimedManagerId, incumbent.id);

    note("");
    note("=== Live dev/test database (emstjswhotsnyksqhqyf) ===========================================");
    note(`unclaimed legacy purchase : ${legacyEmail}  manager_id=${legacyManagerId}  user_id=NULL`);
    note(`already-claimed purchase  : ${claimedEmail}  manager_id=${claimedManagerId}  user_id=${incumbent.id}`);
    note("");
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of purchaseIds) await db.from("manager_purchases").delete().eq("id", id);
    for (const user of [attacker, incumbent, latecomer, ...driftUsers]) {
      if (!user?.id) continue;
      await db.from("manager_automation_settings").delete().eq("manager_user_id", user.id);
      await db.from("profile_roles").delete().eq("user_id", user.id);
      await db.from("profiles").delete().eq("id", user.id);
      await db.auth.admin.deleteUser(user.id);
    }
    note("");
    note("torn down: every account and purchase row this rehearsal created is deleted.");
  });

  it("1. an unproven mailbox with user_metadata.role=admin is granted nothing", async () => {
    const { resolveOAuthPortalRedirect } = await import("@/lib/auth/resolve-oauth-portal-access");
    const { reconcileAuthAccountsByEmail } = await import("@/lib/auth/reconcile-auth-accounts-by-email");

    note("--- 1. attacker signs up on the legacy address, mailbox UNCONFIRMED, metadata role=admin -----");
    note(`    user_metadata.role        : ${String((attacker.user_metadata ?? {}).role)}`);
    note(`    email_confirmed_at        : ${String(attacker.email_confirmed_at ?? null)}`);

    await reconcileAuthAccountsByEmail(db, attacker);
    const destination = await resolveOAuthPortalRedirect(db, attacker, "/auth/continue");
    const state = await accessState(attacker.id);
    const owner = await purchaseOwner(purchaseIds[0]);
    const route = await googleServicesStatus(attacker);

    note(`    lands on                  : ${destination}`);
    note(`    profile_roles rows        : ${JSON.stringify(state.roles)}`);
    note(`    profiles.manager_id       : ${String(state.managerId)}`);
    note(`    purchase.user_id          : ${String(owner)}`);
    note(`    email_confirmed_at after  : ${String(state.emailConfirmedAt)}`);
    note(`    GET /api/auth/manager-google-services -> ${route.status} ${JSON.stringify(route.body)}`);
    note("");

    expect(destination).toBe("/auth/get-started");
    expect(state.roles).toEqual([]);
    expect(state.managerId).toBeNull();
    expect(owner).toBeNull();
    expect(state.emailConfirmedAt).toBeNull();
    expect(route.status).toBe(403);
  });

  it("2. the same account, once Auth confirms the mailbox, gets the entitlement", async () => {
    const { resolveOAuthPortalRedirect } = await import("@/lib/auth/resolve-oauth-portal-access");

    const { error } = await db.auth.admin.updateUserById(attacker.id, { email_confirm: true });
    expect(error).toBeNull();
    const confirmed = await refetch(attacker.id);

    note("--- 2. the ONLY thing that changed: Auth confirmed this exact mailbox -----------------------");
    note(`    email_confirmed_at        : ${String(confirmed.email_confirmed_at)}`);

    const destination = await resolveOAuthPortalRedirect(db, confirmed, "/auth/continue");
    const state = await accessState(confirmed.id);
    const owner = await purchaseOwner(purchaseIds[0]);
    const route = await googleServicesStatus(confirmed);

    note(`    lands on                  : ${destination}`);
    note(`    profile_roles rows        : ${JSON.stringify(state.roles)}`);
    note(`    profiles.manager_id       : ${String(state.managerId)}  (the purchase's workspace)`);
    note(`    GET /api/auth/manager-google-services -> ${route.status} ${JSON.stringify(route.body)}`);
    note("");

    expect(state.roles).toContain("manager");
    expect(state.managerId).toBe(legacyManagerId);
    expect(destination.startsWith("/portal") || destination.startsWith("/auth/connect-google-services")).toBe(true);
    expect(route.status).toBe(200);
    // Still only the by-email read: a confirmed match entitles, it does not silently rewrite the row's owner.
    expect(owner).toBeNull();
  });

  it("3b. an unreadable plan is reported as retryable, never as 'no plan'", async () => {
    const { resolveOAuthPortalRedirect } = await import("@/lib/auth/resolve-oauth-portal-access");
    // Everything answers from the live database except `manager_purchases`, which behaves like a blip.
    const blip = {
      ...db,
      from: (table: string) =>
        table === "manager_purchases"
          ? ((): Record<string, unknown> => {
              const err = { code: "57P01", message: "terminating connection due to administrator command" };
              const chain: Record<string, unknown> = {
                select: () => chain,
                eq: () => chain,
                is: () => chain,
                order: () => chain,
                limit: () => chain,
                maybeSingle: async () => ({ data: null, error: err }),
                then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: err }).then(resolve),
              };
              return chain;
            })()
          : db.from(table),
    } as unknown as SupabaseClient;

    note("--- 3b. the manager from step 2 signs in while the manager_purchases read is failing --------");
    const confirmed = await refetch(attacker.id);
    const destination = await resolveOAuthPortalRedirect(blip, confirmed, "/auth/continue");

    live.db = blip;
    const { GET } = await import("@/app/api/auth/manager-onboarding-status/route");
    session.user = confirmed;
    const res = await GET();
    const body = await res.json();
    live.db = db;

    note(`    lands on                  : ${destination}  (not the plan chooser)`);
    note(`    GET /api/auth/manager-onboarding-status -> ${res.status} ${JSON.stringify(body)}`);
    note("");

    expect(destination).toBe("/portal/dashboard");
    expect(res.status).toBe(500);
    expect(String(body.error)).toContain("Could not read this account's manager signup");
    expect(body.needsPricing).toBeUndefined();
  });

  it("3c. a drifted profiles.email no longer entitles the account to a stranger's plan", async () => {
    // `profiles.email` is written by server routes from caller-supplied values, so it is not the account's
    // mailbox. The plan read now asks Auth for the confirmed address instead.
    const { getEffectiveManagerSkuTier } = await import("@/lib/manager-access-server");

    const drifter = await createUser(`hotfix2-drifter-${tag}@proplane.test`, { confirmed: true });
    driftUsers.push(drifter);
    const driftTargetEmail = `hotfix2-drift-target-${tag}@proplane.test`;
    const driftManagerId = `mgr_hf2d_${tag}`;
    const driftPurchaseId = await seedPurchase(driftTargetEmail, driftManagerId, null);
    await db.from("profiles").upsert(
      { id: drifter.id, email: driftTargetEmail, role: "manager", application_approved: true },
      { onConflict: "id" },
    );

    note("--- 3c. an account whose profiles.email was set to a stranger's purchase address ------------");
    note(`    confirmed Auth email      : ${drifter.email}`);
    note(`    profiles.email            : ${driftTargetEmail}  (the business-tier purchase's address)`);

    const plan = await getEffectiveManagerSkuTier(drifter.id);
    const owner = await purchaseOwner(driftPurchaseId);

    note(`    getEffectiveManagerSkuTier: ${JSON.stringify(plan)}`);
    note(`    purchase.user_id after    : ${String(owner)} (unchanged)`);
    note("");

    expect(plan.ok).toBe(true);
    expect(plan.tier).toBe("free");
    expect(owner).toBeNull();
  });

  it("3. a purchase row another account already holds is never adopted", async () => {
    const { resolveOAuthPortalRedirect } = await import("@/lib/auth/resolve-oauth-portal-access");

    note("--- 3. a confirmed mailbox whose purchase row is already CLAIMED by another account ---------");
    note(`    signed in as              : ${claimedEmail} (confirmed)`);
    note(`    purchase.user_id          : ${incumbent.id} (the incumbent)`);

    const destination = await resolveOAuthPortalRedirect(db, latecomer, "/auth/continue");
    const state = await accessState(latecomer.id);
    const owner = await purchaseOwner(purchaseIds[1]);

    note(`    lands on                  : ${destination}`);
    note(`    profile_roles rows        : ${JSON.stringify(state.roles)}`);
    note(`    profiles.manager_id       : ${String(state.managerId)}`);
    note(`    purchase.user_id after    : ${String(owner)} (unchanged)`);
    note("");

    expect(destination).toBe("/auth/get-started");
    expect(state.roles).toEqual([]);
    expect(state.managerId).toBeNull();
    expect(owner).toBe(incumbent.id);
  });
});
