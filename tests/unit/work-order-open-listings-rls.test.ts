/**
 * C152 `work_order_open_listings` is a redacted, semi-public marketplace
 * listing — the row-level policies below are the thing standing between "any
 * signed-in vendor may browse this" and "any signed-in vendor may write it,
 * or an anonymous caller may read it too". This is a lighter, table-scoped
 * version of `role-grant-surface.test.ts`'s replay, kept as its own file so a
 * later migration touching this one table fails a fast, obviously-named test
 * rather than only the broad trust-table suite (which does not name this
 * table — see AGENTS.md "The PostgREST surface is public").
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const TABLE = "work_order_open_listings";

function migrationText(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  return files
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
    .join("\n")
    // Strip line comments so explanatory prose never registers as SQL.
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const SQL = migrationText();

describe(`RLS/grant surface: public.${TABLE}`, () => {
  it("enables row level security", () => {
    expect(new RegExp(`alter\\s+table\\s+public\\.${TABLE}\\s+enable\\s+row\\s+level\\s+security`, "i").test(SQL)).toBe(true);
  });

  it("revokes all privileges from anon", () => {
    expect(new RegExp(`revoke\\s+all\\s+on\\s+public\\.${TABLE}\\s+from\\s+anon`, "i").test(SQL)).toBe(true);
  });

  it("revokes insert/update/delete from authenticated", () => {
    expect(
      new RegExp(`revoke\\s+insert\\s*,\\s*update\\s*,\\s*delete\\s+on\\s+public\\.${TABLE}\\s+from\\s+authenticated`, "i").test(SQL),
    ).toBe(true);
  });

  it("grants no INSERT/UPDATE/DELETE to anon or authenticated", () => {
    // Every GRANT statement in the migration history that names this table.
    const grants = [...SQL.matchAll(/grant\s+(.+?)\s+on\s+(?:public\.)?([a-z_,\s]+?)\s+to\s+([a-z_,\s]+?);/gi)];
    for (const [, privileges, targetsRaw, granteesRaw] of grants) {
      const targets = targetsRaw.split(",").map((t) => t.trim());
      if (!targets.includes(TABLE) && !/all\s+tables\s+in\s+schema\s+public/i.test(targetsRaw)) continue;
      const grantees = granteesRaw.split(",").map((g) => g.trim());
      const writesAny = /insert|update|delete|\ball\b/i.test(privileges);
      if (!writesAny) continue;
      for (const role of ["anon", "authenticated"]) {
        expect(grantees, `unexpected write grant on ${TABLE} to ${role}: "${privileges}"`).not.toContain(role);
      }
    }
  });

  it("creates only SELECT policies (no client-side write policy)", () => {
    const createPolicies = [...SQL.matchAll(new RegExp(`create\\s+policy\\s+"?([\\w-]+)"?\\s+on\\s+public\\.${TABLE}\\s+([\\s\\S]*?);`, "gi"))];
    expect(createPolicies.length).toBeGreaterThan(0);
    for (const [, name, body] of createPolicies) {
      expect(/\bfor\s+(insert|update|delete|all)\b/i.test(body), `policy ${name} on ${TABLE} must not permit a client write: ${body}`).toBe(
        false,
      );
    }
  });

  it("scopes the vendor SELECT policy to authenticated and status = 'open' — never anon, never every row", () => {
    const vendorPolicy = /create\s+policy\s+work_order_open_listings_vendor_read\s+on\s+public\.work_order_open_listings\s+([\s\S]*?);/i.exec(
      SQL,
    );
    expect(vendorPolicy, "expected work_order_open_listings_vendor_read to exist").not.toBeNull();
    const body = vendorPolicy![1];
    expect(/\bto\s+authenticated\b/i.test(body)).toBe(true);
    expect(/status\s*=\s*'open'/i.test(body)).toBe(true);
  });

  it("scopes the manager SELECT policy to their own rows via auth.uid()", () => {
    const managerPolicy = /create\s+policy\s+work_order_open_listings_manager_read\s+on\s+public\.work_order_open_listings\s+([\s\S]*?);/i.exec(
      SQL,
    );
    expect(managerPolicy, "expected work_order_open_listings_manager_read to exist").not.toBeNull();
    expect(/manager_user_id\s*=\s*auth\.uid\(\)/i.test(managerPolicy![1])).toBe(true);
  });
});
