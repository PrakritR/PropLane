/**
 * C152 `work_order_open_listings` is a redacted, semi-public marketplace
 * listing — but PostgREST only ever constrains which ROW a policy exposes,
 * never which COLUMN, so a `status = 'open'` SELECT policy "for vendors"
 * would let ANY authenticated user (a resident, another manager, anyone
 * signed in) read every open listing's RAW row directly — manager_user_id
 * and work_order_id included — bypassing the service-role API's redacted
 * projection entirely. Both the manager's own view and the vendor's browse
 * are served exclusively by that API, so this table has NO client-side read
 * path at all: no policy, and no privilege to even attempt one.
 *
 * A lighter, table-scoped version of `role-grant-surface.test.ts`'s replay,
 * kept as its own file so a later migration touching this one table fails a
 * fast, obviously-named test rather than only the broad trust-table suite
 * (which does not name this table — see AGENTS.md "The PostgREST surface is
 * public").
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const TABLE = "work_order_open_listings";
const CLIENT_ROLES = ["anon", "authenticated"] as const;

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

  it("revokes all privileges from authenticated — no client read path at all", () => {
    expect(new RegExp(`revoke\\s+all\\s+on\\s+public\\.${TABLE}\\s+from\\s+authenticated`, "i").test(SQL)).toBe(true);
  });

  it("creates NO policy on this table — neither role has a read (or write) path", () => {
    const createPolicies = [...SQL.matchAll(new RegExp(`create\\s+policy\\s+"?([\\w-]+)"?\\s+on\\s+public\\.${TABLE}\\b`, "gi"))];
    expect(
      createPolicies.map((m) => m[1]),
      `${TABLE} must have zero RLS policies — every client read goes through the service-role API, and a policy here is exactly the leak that shipped once already`,
    ).toEqual([]);
  });

  it("grants nothing to anon or authenticated at any point in the migration history", () => {
    // Every GRANT statement in the migration history that names this table, replayed
    // in order against a REVOKE-from-both baseline (this table starts fully locked).
    const held = new Map<string, Set<string>>(CLIENT_ROLES.map((r) => [r, new Set<string>()]));
    const statements = [...SQL.matchAll(/(grant|revoke)\s+(.+?)\s+on\s+(?:public\.)?([a-z_,\s]+?)\s+(?:to|from)\s+([a-z_,\s]+?);/gi)];
    for (const match of statements) {
      const [, verbRaw, privsRaw, targetsRaw, granteesRaw] = match;
      const targets = targetsRaw!.split(",").map((t) => t.trim());
      if (!targets.includes(TABLE) && !/all\s+tables\s+in\s+schema\s+public/i.test(targetsRaw!)) continue;
      const verb = verbRaw!.toLowerCase();
      const grantees = granteesRaw!.split(",").map((g) => g.trim());
      const privileges = /\ball\b/i.test(privsRaw!) ? ["select", "insert", "update", "delete"] : privsRaw!.split(",").map((p) => p.trim().toLowerCase());
      for (const role of CLIENT_ROLES) {
        if (!grantees.includes(role)) continue;
        for (const p of privileges) {
          if (verb === "grant") held.get(role)!.add(p);
          else held.get(role)!.delete(p);
        }
      }
    }
    for (const role of CLIENT_ROLES) {
      expect([...held.get(role)!].sort(), `${role} must end with no privilege on ${TABLE}`).toEqual([]);
    }
  });
});
