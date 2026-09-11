// Reported (Sep 10): a manager set the application-fee waiver code `AKASH` on a
// listing, and the applicant entering it was told "That code isn't valid for
// this listing." The code was real, active and correctly pinned. What had
// actually happened is that the Sep 9 per-property change started selecting a
// `property_id` column that existed only in the dev database — staging and
// production had never had the migration applied — so every lookup errored with
// `42703: column "property_id" does not exist`.
//
// Two separate failures made that unreadable, and this file guards both:
//
// 1. The lookups selected columns no migration in the repo had to create. This
//    replays the REAL migrations into Postgres and runs the lib's own column
//    lists against them, so code and schema cannot drift apart silently again.
// 2. The database error was DISCARDED (`const { data } = ...`), so "we could not
//    check" and "this code does not exist" produced the same sentence. A failure
//    of ours must never be phrased as a verdict on the applicant's code.
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  previewApplicationFeeWaiverCode,
  redeemApplicationFeeWaiverCode,
} from "@/lib/application-fee-waiver";

const MIGRATIONS = [
  "20260726190000_application_fee_waiver_codes.sql",
  "20260909210000_scope_application_fee_waiver_codes_to_property.sql",
];

const WAIVER_LIB = join(process.cwd(), "src/lib/application-fee-waiver.ts");
const WAIVER_TABLES = ["manager_application_fee_waiver_codes", "application_fee_waiver_redemptions"] as const;

/**
 * Every `(table, column list)` pair the library actually asks Postgres for.
 * Read out of the source rather than restated here, so a new query is covered
 * the moment it is written instead of when somebody remembers this file.
 */
function selectedColumnsByTable(source: string): { table: string; columns: string[] }[] {
  const out: { table: string; columns: string[] }[] = [];
  const fromPattern = /\.from\("([a-z_]+)"\)/g;
  for (let m = fromPattern.exec(source); m; m = fromPattern.exec(source)) {
    const table = m[1]!;
    if (!(WAIVER_TABLES as readonly string[]).includes(table)) continue;
    // The chained call that follows this `.from(...)`, and only that one.
    const tail = source.slice(m.index, m.index + 400);
    const select = /\.select\("([^"]+)"\)/.exec(tail);
    if (!select) continue;
    const list = select[1]!.trim();
    if (list === "*") continue; // a star select cannot name a column that is missing
    out.push({ table, columns: list.split(",").map((c) => c.trim()).filter(Boolean) });
  }
  return out;
}

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  // Same bootstrap shape as the other migration-replay suites: the roles the
  // grants name, and the auth.users rows the codes table references.
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);`);
  for (const file of MIGRATIONS) {
    await db.exec(readFileSync(join(process.cwd(), "supabase/migrations", file), "utf8"));
  }
}, 30_000);

afterAll(async () => {
  await db?.close();
});

describe("waiver-code queries and the migrations agree", () => {
  it("finds at least one real select list to check", () => {
    const lists = selectedColumnsByTable(readFileSync(WAIVER_LIB, "utf8"));
    expect(lists.length).toBeGreaterThan(0);
  });

  it("selects only columns the migrations create", async () => {
    const lists = selectedColumnsByTable(readFileSync(WAIVER_LIB, "utf8"));
    for (const { table, columns } of lists) {
      // `limit 0` — this asserts the column set resolves, not what is stored.
      await expect(
        db.query(`select ${columns.join(", ")} from public.${table} limit 0`),
        `${table}: ${columns.join(", ")}`,
      ).resolves.toBeTruthy();
    }
  });

  it("inserts only columns the migrations create", async () => {
    const source = readFileSync(WAIVER_LIB, "utf8");
    // The insert in `createApplicationFeeWaiverCode`, read from the source.
    const insert = /\.insert\(\{([\s\S]*?)\}\)/.exec(source);
    expect(insert).not.toBeNull();
    const keys = [...insert![1]!.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]!);
    expect(keys).toContain("property_id");
    const { rows } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public'
          and table_name = 'manager_application_fee_waiver_codes'`,
    );
    const existing = new Set(rows.map((r) => r.column_name));
    for (const key of keys) expect(existing, `insert column ${key}`).toContain(key);
  });

  it("calls the redeem function with the signature the migration defines", async () => {
    const { rows } = await db.query<{ args: string }>(
      `select pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'redeem_application_fee_waiver_code'`,
    );
    expect(rows).toHaveLength(1);
    const source = readFileSync(WAIVER_LIB, "utf8");
    for (const param of rows[0]!.args.split(",").map((a) => a.trim().split(" ")[0]!)) {
      expect(source, `rpc parameter ${param}`).toContain(param);
    }
  });
});

/** A client whose every read fails, the way a drifted schema or an outage reads. */
function failingDb(message: string): SupabaseClient {
  const failure = Promise.resolve({ data: null, error: { message } });
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => Object.assign(Object.create(chain), failure, { then: failure.then.bind(failure) });
  return {
    from: () => chain,
    rpc: () => failure,
  } as unknown as SupabaseClient;
}

describe("a failed lookup is never reported as an invalid code", () => {
  it("previews as UNAVAILABLE, not NOT_FOUND", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await previewApplicationFeeWaiverCode(
      failingDb('column "property_id" does not exist'),
      "11111111-1111-4111-8111-111111111111",
      "AKASH",
      "mgr-listing-1",
    );
    spy.mockRestore();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("UNAVAILABLE");
    // The exact sentence the applicant was wrongly shown.
    expect(result.error).not.toContain("isn't valid");
  });

  it("redeems as UNAVAILABLE, not NOT_FOUND", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await redeemApplicationFeeWaiverCode(failingDb("connection terminated"), {
      managerUserId: "11111111-1111-4111-8111-111111111111",
      propertyId: "mgr-listing-1",
      residentEmail: "applicant@test.proplane.local",
      code: "AKASH",
    });
    spy.mockRestore();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("UNAVAILABLE");
    expect(result.error).not.toContain("isn't valid");
  });

  it("still rejects a genuinely absent code as NOT_FOUND", async () => {
    const empty = Promise.resolve({ data: [], error: null });
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => Object.assign(Object.create(chain), { then: empty.then.bind(empty) });
    const db2 = { from: () => chain } as unknown as SupabaseClient;
    const result = await previewApplicationFeeWaiverCode(
      db2,
      "11111111-1111-4111-8111-111111111111",
      "NOPECODE",
      "mgr-listing-1",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("NOT_FOUND");
  });
});
