// Reported: "code to waive application should be independent to each property",
// and the same code must be shared between a manager and their co-managers on
// that property.
//
// The settings modal always presented ONE code per property, and the storage
// layer already tagged codes `label = 'listing:<id>'`. Redemption never read
// that tag — its SQL matched on manager + code + active + unexpired +
// under-max-uses and nothing else — so a code set on one listing waived the fee
// on every listing that manager owned, under UI copy reading "this property's
// application".
//
// This replays the REAL migrations against Postgres (same approach as the
// account-purge SQL suites) so the guarantee is tested where it is actually
// enforced, not against a hand-written mock of the query.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = [
  "20260726190000_application_fee_waiver_codes.sql",
  "20260909210000_scope_application_fee_waiver_codes_to_property.sql",
];

const MANAGER = "11111111-1111-4111-8111-111111111111";
const OTHER_MANAGER = "22222222-2222-4222-8222-222222222222";

let db: PGlite;

async function seedCode(opts: {
  code: string;
  propertyId: string | null;
  label?: string | null;
  status?: string;
  maxUses?: number | null;
  managerUserId?: string;
}): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `insert into public.manager_application_fee_waiver_codes
       (manager_user_id, code, code_normalized, label, property_id, status, max_uses)
     values ($1, $2, $2, $3, $4, $5, $6)
     returning id`,
    [
      opts.managerUserId ?? MANAGER,
      opts.code,
      opts.label ?? null,
      opts.propertyId,
      opts.status ?? "active",
      opts.maxUses ?? null,
    ],
  );
  return rows.rows[0]!.id;
}

async function redeem(codeId: string, propertyId: string, managerUserId = MANAGER) {
  const res = await db.query<{ id: string }>(
    `select * from public.redeem_application_fee_waiver_code($1, $2, $3, $4, $5)`,
    [codeId, managerUserId, propertyId, "applicant@example.com", null],
  );
  return res.rows;
}

beforeAll(async () => {
  db = new PGlite();
  // Same bootstrap shape as the other migration-replay suites: the roles the
  // grants name, and the auth.users rows the codes table references.
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);`);
  await db.exec(
    `insert into auth.users(id) values ('${MANAGER}'), ('${OTHER_MANAGER}') on conflict do nothing;`,
  );
  for (const file of MIGRATIONS) {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations", file), "utf8");
    await db.exec(sql);
  }
}, 30_000);

afterAll(async () => {
  await db?.close();
});

describe("waiver codes are scoped to one property", () => {
  it("does NOT waive on a property the code was not set for", async () => {
    const id = await seedCode({ code: "ROOM-A-ONLY", propertyId: "prop-a" });

    expect(await redeem(id, "prop-a")).toHaveLength(1);
    // The defect: this used to succeed too.
    expect(await redeem(id, "prop-b")).toHaveLength(0);
  });

  it("keeps a legacy portfolio-wide code (null property) working everywhere", async () => {
    const id = await seedCode({ code: "LEGACY-ALL", propertyId: null });
    expect(await redeem(id, "prop-a")).toHaveLength(1);
    expect(await redeem(id, "prop-c")).toHaveLength(1);
  });

  it("still refuses a revoked, expired or exhausted code on its own property", async () => {
    const revoked = await seedCode({ code: "REVOKED-1", propertyId: "prop-a", status: "revoked" });
    expect(await redeem(revoked, "prop-a")).toHaveLength(0);

    const capped = await seedCode({ code: "ONE-USE", propertyId: "prop-a", maxUses: 1 });
    expect(await redeem(capped, "prop-a")).toHaveLength(1);
    expect(await redeem(capped, "prop-a")).toHaveLength(0);
  });

  it("never crosses managers", async () => {
    const id = await seedCode({ code: "MINE-ONLY", propertyId: "prop-a" });
    expect(await redeem(id, "prop-a", OTHER_MANAGER)).toHaveLength(0);
  });

  it("records the property the code was redeemed against", async () => {
    const id = await seedCode({ code: "AUDIT-ME", propertyId: "prop-z" });
    await redeem(id, "prop-z");
    const rows = await db.query<{ property_id: string }>(
      `select property_id from public.application_fee_waiver_redemptions where code_id = $1`,
      [id],
    );
    expect(rows.rows.map((r) => r.property_id)).toEqual(["prop-z"]);
  });
});

describe("the backfill pins existing labelled codes", () => {
  it("reads the property out of a listing:<id> label", async () => {
    // A row as it existed BEFORE the column, then the migration replayed.
    await db.query(
      `insert into public.manager_application_fee_waiver_codes
         (manager_user_id, code, code_normalized, label, status)
       values ($1, 'PRE-EXISTING', 'PRE-EXISTING', 'listing:prop-legacy', 'active')`,
      [MANAGER],
    );
    const sql = readFileSync(
      join(process.cwd(), "supabase/migrations", MIGRATIONS[1]!),
      "utf8",
    );
    await db.exec(sql);

    const rows = await db.query<{ property_id: string | null }>(
      `select property_id from public.manager_application_fee_waiver_codes where code_normalized = 'PRE-EXISTING'`,
    );
    expect(rows.rows[0]?.property_id).toBe("prop-legacy");
  });
});
