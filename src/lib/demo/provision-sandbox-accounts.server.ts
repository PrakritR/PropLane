import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CANONICAL_DEMO_ADMIN_EMAIL,
  CANONICAL_DEMO_GUIDED_NAME,
  CANONICAL_DEMO_MANAGER_EMAIL,
  CANONICAL_DEMO_MANAGER_NAME,
  CANONICAL_DEMO_RESIDENT_EMAIL,
  CANONICAL_DEMO_RESIDENT_NAME,
  CANONICAL_DEMO_VENDOR_EMAIL,
  CANONICAL_DEMO_VENDOR_NAME,
} from "@/lib/demo/demo-canonical-accounts";
import { seedCanonicalDemoPortfolio } from "@/lib/demo/canonical-demo-portfolio-db";

/**
 * Provisions the canonical sandbox accounts (manager / resident / vendor /
 * testeverything) into WHATEVER database the runtime points at — the dev/test
 * project locally, the production project on the live deploy. This is how the
 * sandbox accounts + `/demo` mirror stay identical across environments without
 * ever moving credentials between them.
 *
 * The accounts are provisioned with the shared `buildDemoIdleSnapshot()`
 * portfolio (Seattle Homes — see `demo-guided-data.ts`, `docs/agents/demo-sandbox.md`)
 * unless `seedPortfolio` is explicitly `false`, in which case this route
 * creates and repairs only the logins.
 *
 * It is still a write against whatever database the runtime points at, not a
 * read-only check. `seedPortfolio` defaults to true. The call below passes
 * `skipGlobalScheduleSingletons: true` so seeding the portfolio's one tour
 * never touches the two DEPLOYMENT-WIDE schedule singletons
 * (`axis_admin_planned_events_v1` / `axis_admin_partner_inquiries_v1`), which
 * hold real prospect tour requests in production — every other row
 * (properties, charges, leases, applications) is still written normally.
 *
 * Keep the account set and passwords in lockstep with
 * tests/helpers/seed-test-db.mjs (the test-DB seed also prunes non-canonical
 * accounts; this route never deletes anything).
 *
 * The admin@test.proplane.local account is deliberately NOT provisioned here — an
 * admin-role account with a well-known password must never be auto-created in
 * production.
 */

/** Must match E2E_RESIDENT_AXIS_ID in tests/fixtures/index.ts. */
const RESIDENT_AXIS_ID = "AXIS-TESTRSID";

type SandboxRole = "manager" | "resident" | "vendor" | "admin";

type AccountSpec = {
  email: string;
  password: string;
  primaryRole: SandboxRole;
  roles: SandboxRole[];
  /** Strip profile_roles rows outside `roles` (single-role accounts). */
  onlyListedRoles: boolean;
  fullName: string;
  defaultManagerId?: string;
  proTierSessionId?: string;
  axisId?: string;
  applicationApproved?: boolean;
};

const ACCOUNT_SPECS: AccountSpec[] = [
  {
    email: CANONICAL_DEMO_MANAGER_EMAIL,
    password: "TestManager123!",
    primaryRole: "manager",
    roles: ["manager"],
    onlyListedRoles: true,
    fullName: CANONICAL_DEMO_MANAGER_NAME,
    defaultManagerId: "MGR-TESTE2E",
    proTierSessionId: "sandbox_provision_manager",
  },
  {
    email: CANONICAL_DEMO_RESIDENT_EMAIL,
    password: "TestResident123!",
    primaryRole: "resident",
    roles: ["resident"],
    onlyListedRoles: true,
    fullName: CANONICAL_DEMO_RESIDENT_NAME,
    axisId: RESIDENT_AXIS_ID,
    applicationApproved: true,
  },
  {
    email: CANONICAL_DEMO_VENDOR_EMAIL,
    password: "TestVendor123!",
    primaryRole: "vendor",
    roles: ["vendor"],
    onlyListedRoles: true,
    fullName: CANONICAL_DEMO_VENDOR_NAME,
  },
  {
    email: CANONICAL_DEMO_ADMIN_EMAIL,
    password: "TestEverything123!",
    primaryRole: "manager",
    roles: ["manager", "admin", "resident", "vendor"],
    onlyListedRoles: false,
    fullName: CANONICAL_DEMO_GUIDED_NAME,
    defaultManagerId: "MGR-TESTEVERY",
    proTierSessionId: "sandbox_provision_everything",
  },
];

async function must<T>(
  promise: PromiseLike<{ data: T; error: { message: string } | null }>,
  label: string,
): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data as T;
}

async function findUserIdByEmail(db: SupabaseClient, email: string): Promise<string | null> {
  const { data: profileRow } = await db
    .from("profiles")
    .select("id")
    .eq("email", email)
    .limit(1)
    .maybeSingle();
  if (profileRow?.id) return String(profileRow.id);
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const match = data?.users?.find((u) => u.email?.toLowerCase() === email);
    if (match) return match.id;
    if (!data?.users?.length || data.users.length < 1000) break;
  }
  return null;
}

async function ensureSandboxAccount(
  db: SupabaseClient,
  spec: AccountSpec,
): Promise<{ email: string; userId: string; created: boolean; roles: SandboxRole[] }> {
  const email = spec.email.toLowerCase();
  let created = false;
  let userId: string;

  const { data: createdUser, error: createErr } = await db.auth.admin.createUser({
    email,
    password: spec.password,
    email_confirm: true,
    user_metadata: { role: spec.primaryRole },
  });
  if (createErr) {
    if (!createErr.message.toLowerCase().includes("already")) {
      throw new Error(`createUser ${email}: ${createErr.message}`);
    }
    const existingId = await findUserIdByEmail(db, email);
    if (!existingId) throw new Error(`User ${email} exists but could not be resolved`);
    userId = existingId;
    const { error: updateErr } = await db.auth.admin.updateUserById(userId, {
      password: spec.password,
      user_metadata: { role: spec.primaryRole },
    });
    if (updateErr) throw new Error(`updateUserById ${email}: ${updateErr.message}`);
  } else {
    userId = createdUser.user.id;
    created = true;
  }

  // Keep an existing manager business id — rows already scoped to it must not orphan.
  let managerId: string | null = null;
  if (spec.defaultManagerId) {
    const { data: profileRow } = await db
      .from("profiles")
      .select("manager_id")
      .eq("id", userId)
      .maybeSingle();
    managerId = profileRow?.manager_id?.trim() || spec.defaultManagerId;
  }

  await must(
    db.from("profiles").upsert(
      {
        id: userId,
        email,
        role: spec.primaryRole,
        full_name: spec.fullName,
        ...(managerId ? { manager_id: managerId } : {}),
        ...(spec.axisId ? { manager_id: spec.axisId } : {}),
        ...(spec.applicationApproved != null ? { application_approved: spec.applicationApproved } : {}),
      },
      { onConflict: "id" },
    ),
    `profiles(${email})`,
  );

  for (const role of spec.roles) {
    await must(
      db.from("profile_roles").upsert({ user_id: userId, role }, { onConflict: "user_id,role" }),
      `profile_roles(${email}:${role})`,
    );
  }
  if (spec.onlyListedRoles) {
    await must(
      db.from("profile_roles").delete().eq("user_id", userId).not("role", "in", `(${spec.roles.join(",")})`),
      `profile_roles(strip stray roles for ${email})`,
    );
  }

  // Pro tier (FREE100 waiver) so tier-gated tabs are never paywalled for sandbox accounts.
  if (spec.proTierSessionId && managerId) {
    const { data: purchases } = await db.from("manager_purchases").select("id, tier").eq("user_id", userId);
    const hasPaidTier = (purchases ?? []).some((p) =>
      ["pro", "business"].includes(String(p.tier ?? "").toLowerCase()),
    );
    if (!hasPaidTier) {
      await must(
        db.from("manager_purchases").upsert(
          {
            stripe_checkout_session_id: spec.proTierSessionId,
            email,
            manager_id: managerId,
            tier: "pro",
            billing: "portal",
            user_id: userId,
            promo_code: "FREE100",
            paid_at: new Date().toISOString(),
          },
          { onConflict: "manager_id" },
        ),
        `manager_purchases(${email})`,
      );
    }
  }

  return { email, userId, created, roles: spec.roles };
}

export type ProvisionSandboxResult = {
  accounts: Array<{ email: string; userId: string; created: boolean; roles: SandboxRole[] }>;
  portfolioSeeded: boolean;
};

export async function provisionSandboxAccounts(
  db: SupabaseClient,
  options: { seedPortfolio?: boolean } = {},
): Promise<ProvisionSandboxResult> {
  const seedPortfolio = options.seedPortfolio ?? true;

  const accounts: ProvisionSandboxResult["accounts"] = [];
  for (const spec of ACCOUNT_SPECS) {
    accounts.push(await ensureSandboxAccount(db, spec));
  }

  const byEmail = new Map(accounts.map((a) => [a.email, a.userId]));
  let portfolioSeeded = false;
  if (seedPortfolio) {
    await seedCanonicalDemoPortfolio(
      db,
      {
        managerUserId: byEmail.get(CANONICAL_DEMO_MANAGER_EMAIL)!,
        residentUserId: byEmail.get(CANONICAL_DEMO_RESIDENT_EMAIL)!,
        vendorUserId: byEmail.get(CANONICAL_DEMO_VENDOR_EMAIL)!,
        residentEmail: CANONICAL_DEMO_RESIDENT_EMAIL,
        vendorEmail: CANONICAL_DEMO_VENDOR_EMAIL,
        residentAxisId: RESIDENT_AXIS_ID,
        managerEmail: CANONICAL_DEMO_MANAGER_EMAIL,
      },
      // buildDemoIdleSnapshot() carries the Seattle Homes portfolio again
      // (captain 2026-09-25) — this route can run against PRODUCTION, so it
      // must never let that portfolio's tour reach the two DEPLOYMENT-WIDE
      // schedule singletons (axis_admin_planned_events_v1 /
      // axis_admin_partner_inquiries_v1), which hold real prospect tour
      // requests. Every property/charge/lease/application row is still
      // written and scoped to the canonical manager account as before.
      { skipGlobalScheduleSingletons: true },
    );
    portfolioSeeded = true;
  }

  return { accounts, portfolioSeeded };
}
