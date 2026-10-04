// MONEY (database half): waive codes cover the application fee, the lease fee, or both, and can be limited to
// several properties (leasing pipeline, D4). The rules live in two Postgres functions, so this replays the REAL
// migrations into Postgres and drives the functions - a hand-written mock of the query would test nothing.
//
// Guarantees pinned here:
//  - every code written before the migration is an application-only code and still redeems exactly as before;
//  - applies_to decides which fee a code can be spent on (the matrix);
//  - a property list limits a code, falls back to the legacy single property, then to every property;
//  - the use cap is atomic under concurrent redemption, for both fees, and spends exactly the cap;
//  - one lease spends at most one use even when the resident double-clicks;
//  - a use given back (the waiver could not be applied) is spendable again.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = [
  "20260726190000_application_fee_waiver_codes.sql",
  "20260909210000_scope_application_fee_waiver_codes_to_property.sql",
  "20261003210000_waive_codes_applies_to_and_property_limits.sql",
];

const MANAGER = "11111111-1111-4111-8111-111111111111";
const OTHER_MANAGER = "22222222-2222-4222-8222-222222222222";

let db: PGlite;

async function seedCode(opts: {
  code: string;
  appliesTo?: string | null;
  propertyId?: string | null;
  propertyIds?: string[] | null;
  status?: string;
  maxUses?: number | null;
  expiresAt?: string | null;
  managerUserId?: string;
}): Promise<string> {
  const columns = ["manager_user_id", "code", "code_normalized", "property_id", "property_ids", "status", "max_uses", "expires_at"];
  const values: unknown[] = [
    opts.managerUserId ?? MANAGER,
    opts.code,
    opts.code,
    opts.propertyId ?? null,
    opts.propertyIds ?? null,
    opts.status ?? "active",
    opts.maxUses ?? null,
    opts.expiresAt ?? null,
  ];
  if (opts.appliesTo !== undefined) {
    columns.push("applies_to");
    values.push(opts.appliesTo);
  }
  const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await db.query<{ id: string }>(
    `insert into public.manager_application_fee_waiver_codes (${columns.join(", ")}) values (${placeholders}) returning id`,
    values,
  );
  return rows.rows[0]!.id;
}

async function redeemApplication(codeId: string, propertyId: string, managerUserId = MANAGER) {
  const res = await db.query<{ id: string }>(
    `select * from public.redeem_application_fee_waiver_code($1, $2, $3, $4, $5)`,
    [codeId, managerUserId, propertyId, "applicant@example.com", null],
  );
  return res.rows;
}

async function redeemLease(codeId: string, propertyId: string, leaseId: string, managerUserId = MANAGER) {
  const res = await db.query<{ id: string; redemption_id: string }>(
    `select * from public.redeem_lease_fee_waiver_code($1, $2, $3, $4, $5)`,
    [codeId, managerUserId, propertyId, "resident@example.com", leaseId],
  );
  return res.rows;
}

async function usedCount(codeId: string): Promise<number> {
  const res = await db.query<{ used_count: number }>(
    `select used_count from public.manager_application_fee_waiver_codes where id = $1`,
    [codeId],
  );
  return res.rows[0]!.used_count;
}

async function redemptionCount(codeId: string): Promise<number> {
  const res = await db.query<{ n: number }>(
    `select count(*)::int as n from public.application_fee_waiver_redemptions where code_id = $1`,
    [codeId],
  );
  return res.rows[0]!.n;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);`);
  await db.exec(`insert into auth.users(id) values ('${MANAGER}'), ('${OTHER_MANAGER}') on conflict do nothing;`);
  for (const file of MIGRATIONS) {
    await db.exec(readFileSync(join(process.cwd(), "supabase/migrations", file), "utf8"));
  }
}, 30_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`delete from public.application_fee_waiver_redemptions; delete from public.manager_application_fee_waiver_codes;`);
});

describe("a code written before the migration is unchanged", () => {
  it("reads as an application code, and redeems for the application fee only", async () => {
    // Inserted the way every pre-migration writer does it: no applies_to, no property_ids.
    const id = await seedCode({ code: "OLDCODE1" });
    const row = await db.query<{ applies_to: string; property_ids: string[] | null }>(
      `select applies_to, property_ids from public.manager_application_fee_waiver_codes where id = $1`,
      [id],
    );
    expect(row.rows[0]).toEqual({ applies_to: "application", property_ids: null });

    expect(await redeemApplication(id, "prop-a")).toHaveLength(1);
    expect(await redeemLease(id, "prop-a", "lease-1")).toHaveLength(0);
    expect(await usedCount(id)).toBe(1);
  });

  it("keeps the legacy single-property pin and the portfolio-wide null working", async () => {
    const pinned = await seedCode({ code: "PINNED-ONE", propertyId: "prop-a" });
    expect(await redeemApplication(pinned, "prop-a")).toHaveLength(1);
    expect(await redeemApplication(pinned, "prop-b")).toHaveLength(0);

    const everywhere = await seedCode({ code: "EVERYWHERE" });
    expect(await redeemApplication(everywhere, "prop-a")).toHaveLength(1);
    expect(await redeemApplication(everywhere, "prop-z")).toHaveLength(1);
  });

  it("rejects an applies_to value the rule does not know", async () => {
    await expect(seedCode({ code: "BAD-KIND1", appliesTo: "deposit" })).rejects.toThrow();
  });
});

describe("applies_to decides which fee a code can waive", () => {
  const cases: { appliesTo: string; application: boolean; lease: boolean }[] = [
    { appliesTo: "application", application: true, lease: false },
    { appliesTo: "lease", application: false, lease: true },
    { appliesTo: "both", application: true, lease: true },
  ];

  it.each(cases)("$appliesTo: application=$application lease=$lease", async ({ appliesTo, application, lease }) => {
    const id = await seedCode({ code: `KIND-${appliesTo}`.toUpperCase(), appliesTo });
    expect(await redeemApplication(id, "prop-a")).toHaveLength(application ? 1 : 0);
    expect(await redeemLease(id, "prop-a", `lease-${appliesTo}`)).toHaveLength(lease ? 1 : 0);
    expect(await usedCount(id)).toBe(Number(application) + Number(lease));
  });

  it("still refuses a revoked, expired or other manager's code for either fee", async () => {
    const revoked = await seedCode({ code: "REVOKED-1", appliesTo: "both", status: "revoked" });
    expect(await redeemApplication(revoked, "prop-a")).toHaveLength(0);
    expect(await redeemLease(revoked, "prop-a", "lease-r")).toHaveLength(0);

    const expired = await seedCode({ code: "EXPIRED-1", appliesTo: "both", expiresAt: "2020-01-01T00:00:00Z" });
    expect(await redeemApplication(expired, "prop-a")).toHaveLength(0);
    expect(await redeemLease(expired, "prop-a", "lease-e")).toHaveLength(0);

    const mine = await seedCode({ code: "MINE-ONLY1", appliesTo: "both" });
    expect(await redeemApplication(mine, "prop-a", OTHER_MANAGER)).toHaveLength(0);
    expect(await redeemLease(mine, "prop-a", "lease-m", OTHER_MANAGER)).toHaveLength(0);
  });
});

describe("property limits", () => {
  it("a property list limits the code to exactly those properties, for both fees", async () => {
    const id = await seedCode({ code: "TWO-HOUSES", appliesTo: "both", propertyIds: ["prop-a", "prop-b"] });
    expect(await redeemApplication(id, "prop-a")).toHaveLength(1);
    expect(await redeemLease(id, "prop-b", "lease-b")).toHaveLength(1);
    expect(await redeemApplication(id, "prop-c")).toHaveLength(0);
    expect(await redeemLease(id, "prop-c", "lease-c")).toHaveLength(0);
  });

  it("the list wins over the legacy single property, and an empty list falls back to it", async () => {
    const listed = await seedCode({ code: "LIST-WINS1", propertyId: "prop-old", propertyIds: ["prop-new"] });
    expect(await redeemApplication(listed, "prop-new")).toHaveLength(1);
    expect(await redeemApplication(listed, "prop-old")).toHaveLength(0);

    const empty = await seedCode({ code: "EMPTY-LIST1", propertyId: "prop-old", propertyIds: [] });
    expect(await redeemApplication(empty, "prop-old")).toHaveLength(1);
    expect(await redeemApplication(empty, "prop-new")).toHaveLength(0);
  });

  it("no list and no pin is workspace-wide", async () => {
    const id = await seedCode({ code: "WORKSPACE1", appliesTo: "lease" });
    expect(await redeemLease(id, "prop-a", "lease-1")).toHaveLength(1);
    expect(await redeemLease(id, "prop-zzz", "lease-2")).toHaveLength(1);
  });

  it("records the property and the lease a lease code was spent on", async () => {
    const id = await seedCode({ code: "AUDIT-LEASE", appliesTo: "lease" });
    await redeemLease(id, "prop-z", "lease-9");
    const rows = await db.query<{ property_id: string; kind: string; lease_id: string; resident_email: string }>(
      `select property_id, kind, lease_id, resident_email from public.application_fee_waiver_redemptions where code_id = $1`,
      [id],
    );
    expect(rows.rows).toEqual([
      { property_id: "prop-z", kind: "lease", lease_id: "lease-9", resident_email: "resident@example.com" },
    ]);
  });
});

describe("the use cap is atomic", () => {
  it("never spends more than the cap when many residents redeem at once (lease)", async () => {
    const id = await seedCode({ code: "RACE-LEASE", appliesTo: "lease", maxUses: 3 });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => redeemLease(id, "prop-a", `lease-race-${i}`)),
    );
    expect(results.filter((rows) => rows.length === 1)).toHaveLength(3);
    expect(await usedCount(id)).toBe(3);
    expect(await redemptionCount(id)).toBe(3);
  });

  it("never spends more than the cap when many applicants redeem at once (application)", async () => {
    const id = await seedCode({ code: "RACE-APP1", maxUses: 2 });
    const results = await Promise.all(Array.from({ length: 10 }, () => redeemApplication(id, "prop-a")));
    expect(results.filter((rows) => rows.length === 1)).toHaveLength(2);
    expect(await usedCount(id)).toBe(2);
    expect(await redemptionCount(id)).toBe(2);
  });

  it("a cap shared by both fees is shared: one pool of uses", async () => {
    const id = await seedCode({ code: "SHARED-POOL", appliesTo: "both", maxUses: 2 });
    const results = await Promise.all([
      redeemApplication(id, "prop-a"),
      redeemLease(id, "prop-a", "lease-1"),
      redeemApplication(id, "prop-a"),
      redeemLease(id, "prop-a", "lease-2"),
    ]);
    expect(results.filter((rows) => rows.length === 1)).toHaveLength(2);
    expect(await usedCount(id)).toBe(2);
  });

  it("a double click on one lease spends one use", async () => {
    const id = await seedCode({ code: "DOUBLE-TAP", appliesTo: "lease", maxUses: 5 });
    const results = await Promise.all([
      redeemLease(id, "prop-a", "lease-same"),
      redeemLease(id, "prop-a", "lease-same"),
      redeemLease(id, "prop-a", "lease-same"),
    ]);
    expect(results.filter((rows) => rows.length === 1)).toHaveLength(1);
    expect(await usedCount(id)).toBe(1);
    expect(await redemptionCount(id)).toBe(1);
  });

  it("a second, different code cannot be spent on a lease that already used one", async () => {
    const first = await seedCode({ code: "FIRST-CODE", appliesTo: "lease" });
    const second = await seedCode({ code: "SECOND-CODE", appliesTo: "lease" });
    expect(await redeemLease(first, "prop-a", "lease-1")).toHaveLength(1);
    expect(await redeemLease(second, "prop-a", "lease-1")).toHaveLength(0);
    expect(await usedCount(second)).toBe(0);
  });
});

describe("giving a use back", () => {
  it("removes the audit row, returns the use, and the code can be spent again", async () => {
    const id = await seedCode({ code: "GIVE-BACK1", appliesTo: "lease", maxUses: 1 });
    const spent = await redeemLease(id, "prop-a", "lease-1");
    expect(spent).toHaveLength(1);
    expect(await redeemLease(id, "prop-a", "lease-2")).toHaveLength(0);

    const released = await db.query<{ release_lease_fee_waiver_redemption: boolean }>(
      `select public.release_lease_fee_waiver_redemption($1)`,
      [spent[0]!.redemption_id],
    );
    expect(released.rows[0]!.release_lease_fee_waiver_redemption).toBe(true);
    expect(await usedCount(id)).toBe(0);
    expect(await redemptionCount(id)).toBe(0);

    // Releasing twice never drives the count negative or touches anything else.
    const again = await db.query<{ release_lease_fee_waiver_redemption: boolean }>(
      `select public.release_lease_fee_waiver_redemption($1)`,
      [spent[0]!.redemption_id],
    );
    expect(again.rows[0]!.release_lease_fee_waiver_redemption).toBe(false);
    expect(await usedCount(id)).toBe(0);

    expect(await redeemLease(id, "prop-a", "lease-2")).toHaveLength(1);
  });

  it("never gives back an application redemption", async () => {
    const id = await seedCode({ code: "APP-STAYS1" });
    await redeemApplication(id, "prop-a");
    const redemption = await db.query<{ id: string }>(
      `select id from public.application_fee_waiver_redemptions where code_id = $1`,
      [id],
    );
    const released = await db.query<{ release_lease_fee_waiver_redemption: boolean }>(
      `select public.release_lease_fee_waiver_redemption($1)`,
      [redemption.rows[0]!.id],
    );
    expect(released.rows[0]!.release_lease_fee_waiver_redemption).toBe(false);
    expect(await usedCount(id)).toBe(1);
  });
});
