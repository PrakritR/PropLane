import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Privilege-escalation regression guard.
 *
 * `public` is exposed through PostgREST (`supabase/config.toml`), so anything
 * `anon` / `authenticated` may write is reachable from a browser console with
 * the public anon key. On these three tables that was a direct route to admin:
 * the RLS policies constrained only *which row* you may write, never which
 * column or value, so `update profiles set role='admin' where id=<me>` passed
 * `USING (auth.uid() = id)` cleanly.
 *
 * The fix is 20260722123000_lock_role_grant_surface.sql. This test asserts the
 * *end state* across the whole migration directory, so a later migration that
 * re-adds a write policy or re-grants DML fails here rather than silently
 * reopening the hole. It is a static check — the live proof is
 * `scripts/verify-role-escalation-closed.mjs`, which runs the real attack
 * against a real database.
 */

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

/** Tables whose contents are read as a trust signal by the auth layer. */
const TRUST_TABLES = ["profiles", "profile_roles", "vendor_invites"] as const;
/** Credential rows must be service-role-only: no browser policy, including SELECT. */
const CREDENTIAL_TABLES = ["manager_api_keys", "mcp_oauth_clients", "mcp_oauth_authorization_codes", "mcp_oauth_tokens"] as const;

const CLIENT_ROLES = ["anon", "authenticated"] as const;

type Statement = { sql: string; file: string };

function loadStatements(): Statement[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const statements: Statement[] = [];
  for (const file of files) {
    const raw = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    // Strip line comments so commented-out SQL and the explanatory prose in
    // migration headers never register as statements.
    const stripped = raw
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    for (const chunk of stripped.split(";")) {
      const sql = chunk.trim().replace(/\s+/g, " ");
      if (sql) statements.push({ sql, file });
    }
  }
  return statements;
}

const STATEMENTS = loadStatements();

const WRITE_PRIVILEGES = ["INSERT", "UPDATE", "DELETE"] as const;

type GrantStatement = {
  verb: "grant" | "revoke";
  /** Write privileges this statement moves, expanded from `ALL`. */
  writes: string[];
  grantees: string[];
  targetsTable: (table: string) => boolean;
};

/** Parses a GRANT/REVOKE into the pieces both the replay and the revoke-present checks need. */
function parseGrantStatement(sql: string, privileges: readonly string[] = WRITE_PRIVILEGES): GrantStatement | null {
  const m = /^(grant|revoke)\s+(.+?)\s+(?:on|ON)\s+(.+?)\s+(?:to|TO|from|FROM)\s+(.+)$/i.exec(sql);
  if (!m) return null;
  const [, verbRaw, privsRaw, targetRaw, granteesRaw] = m;

  const target = targetRaw.toLowerCase().replace(/\btable\b/g, "").replace(/public\./g, "").trim();
  const targetNames = target.split(/\s*,\s*/).map((t) => t.trim());
  // `GRANT ... ON ALL TABLES IN SCHEMA public` also lands on every trust table.
  const targetsAllTables = /all\s+tables\s+in\s+schema\s+public/i.test(targetRaw);
  const privs = privsRaw.toUpperCase();

  return {
    verb: verbRaw.toLowerCase() as "grant" | "revoke",
    writes: privileges.filter((p) => privs.includes(p) || /\ball\b/i.test(privsRaw)),
    grantees: granteesRaw.toLowerCase().split(/\s*,\s*/).map((g) => g.trim().replace(/[";]/g, "")),
    targetsTable: (table) => targetsAllTables || target === table || targetNames.includes(table),
  };
}

const POLICY_DROP_RE = /^drop\s+policy\s+(?:if\s+exists\s+)?"?([\w-]+)"?\s+on\s+(?:public\.)?"?(\w+)"?/i;
const POLICY_CREATE_RE = /^create\s+policy\s+"?([\w-]+)"?\s+on\s+(?:public\.)?"?(\w+)"?\s+(.*)$/i;

/**
 * Replays every drop/create in migration order and returns the policies still
 * live on `table` — name → `<policy body> [<defining file>]`. One implementation
 * so the two policy assertions below cannot drift apart on the parsing.
 */
function livePoliciesFor(table: string): Map<string, string> {
  const live = new Map<string, string>();
  for (const { sql, file } of STATEMENTS) {
    const drop = POLICY_DROP_RE.exec(sql);
    if (drop && drop[2].toLowerCase() === table) {
      live.delete(drop[1].toLowerCase());
      continue;
    }
    const create = POLICY_CREATE_RE.exec(sql);
    if (create && create[2].toLowerCase() === table) {
      live.set(create[1].toLowerCase(), `${create[3]} [${file}]`);
    }
  }
  return live;
}

describe("role-grant surface on trust tables", () => {
  it("reads the migration directory", () => {
    expect(STATEMENTS.length).toBeGreaterThan(100);
  });

  for (const table of TRUST_TABLES) {
    describe(`public.${table}`, () => {
      it("ends with no INSERT/UPDATE/DELETE grant to anon or authenticated", () => {
        // Replay grants/revokes in migration order and check the final state.
        const held = new Map<string, Set<string>>(CLIENT_ROLES.map((r) => [r, new Set<string>()]));

        for (const { sql } of STATEMENTS) {
          const stmt = parseGrantStatement(sql);
          if (!stmt || !stmt.targetsTable(table)) continue;

          for (const role of CLIENT_ROLES) {
            if (!stmt.grantees.includes(role)) continue;
            for (const p of stmt.writes) {
              if (stmt.verb === "grant") held.get(role)!.add(p);
              else held.get(role)!.delete(p);
            }
          }
        }

        for (const role of CLIENT_ROLES) {
          expect(
            [...held.get(role)!].sort(),
            `${role} must hold no write privilege on ${table} — a self-service write here is a self-service admin grant`,
          ).toEqual([]);
        }
      });

      // The replay above starts from an empty privilege set because the DML that
      // made the escalation reachable came from Supabase's platform-level default
      // privileges, which live outside supabase/migrations. So deleting the
      // REVOKEs would leave the replay green while reopening the hole in the real
      // database. Assert the REVOKEs themselves are still present.
      it("explicitly revokes INSERT, UPDATE and DELETE from anon and authenticated", () => {
        const revoked = new Map<string, Set<string>>(CLIENT_ROLES.map((r) => [r, new Set<string>()]));

        for (const { sql } of STATEMENTS) {
          const stmt = parseGrantStatement(sql);
          if (!stmt || stmt.verb !== "revoke" || !stmt.targetsTable(table)) continue;
          for (const role of CLIENT_ROLES) {
            if (!stmt.grantees.includes(role)) continue;
            for (const p of stmt.writes) revoked.get(role)!.add(p);
          }
        }

        for (const role of CLIENT_ROLES) {
          expect(
            [...revoked.get(role)!].sort(),
            `${table} must keep an explicit REVOKE of INSERT/UPDATE/DELETE from ${role} — PostgREST inherits Supabase's platform default grants, so the absence of a GRANT in this repo is not the absence of the privilege`,
          ).toEqual([...WRITE_PRIVILEGES].sort());
        }
      });

      it("ends with no policy permitting a client-side write", () => {
        // A policy is only reachable if the grant exists, but a future migration
        // that re-grants DML must not find a permissive write policy waiting.
        const writePolicies = [...livePoliciesFor(table).entries()].filter(([, body]) =>
          /\bfor\s+(all|insert|update|delete)\b/i.test(body),
        );

        expect(
          writePolicies.map(([name, body]) => `${name}: ${body}`),
          `${table} must expose only SELECT policies to client roles; writes belong to service-role routes`,
        ).toEqual([]);
      });

      it("keeps an owner-scoped SELECT policy so the app can still read", () => {
        const selects = [...livePoliciesFor(table).values()].filter((body) => /\bfor\s+select\b/i.test(body));
        expect(selects.length, `${table} lost its SELECT policy — the portal reads this table on boot`).toBeGreaterThan(0);
        // Every surviving SELECT policy must still be scoped to the caller.
        for (const body of selects) {
          expect(body, `${table} SELECT policy must stay scoped to auth.uid()`).toMatch(/auth\.uid\(\)/);
        }
      });
    });
  }

  it("vendor_invites.expires_at is NOT NULL so redemption cannot skip the TTL", () => {
    const setsNotNull = STATEMENTS.some(({ sql }) =>
      /alter\s+table\s+(?:public\.)?vendor_invites\s+alter\s+column\s+expires_at\s+set\s+not\s+null/i.test(sql),
    );
    expect(setsNotNull).toBe(true);
  });
});

describe("credential-table grant surface", () => {
  for (const table of CREDENTIAL_TABLES) {
    it(`keeps public.${table} inaccessible to anon and authenticated`, () => {
      const revoked = new Map<string, Set<string>>(CLIENT_ROLES.map((r) => [r, new Set<string>()]));
      for (const { sql } of STATEMENTS) {
        const stmt = parseGrantStatement(sql);
        if (!stmt || !stmt.targetsTable(table)) continue;
        for (const role of CLIENT_ROLES) {
          if (!stmt.grantees.includes(role)) continue;
          for (const privilege of stmt.writes) {
            if (stmt.verb === "grant") revoked.get(role)!.delete(privilege);
            else revoked.get(role)!.add(privilege);
          }
        }
      }
      for (const role of CLIENT_ROLES) {
        expect([...revoked.get(role)!].sort(), `${table} must revoke client DML from ${role}`).toEqual(
          [...WRITE_PRIVILEGES].sort(),
        );
      }
      expect(livePoliciesFor(table).size, `${table} must have no client-readable or writable RLS policy`).toBe(0);
    });
  }
});

describe("sensitive-table browser least privilege", () => {
  const tablePrivileges = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;
  const serverTables = ["manager_application_records", "cosigner_submission_records", "manager_automation_settings"];
  for (const table of ["profiles", "profile_roles", ...serverTables]) {
    it(`${table} closes platform-default grants without regranting them later`, () => {
      const forbidden = serverTables.includes(table) ? tablePrivileges : ["TRUNCATE", "REFERENCES", "TRIGGER"];
      // Start with Supabase's observed platform defaults, including PUBLIC
      // inheritance: a missing REVOKE must fail even without a repo GRANT.
      const held = new Map(["anon", "authenticated", "public"].map((role) => [role, new Set(forbidden)]));
      for (const { sql } of STATEMENTS) {
        const stmt = parseGrantStatement(sql, forbidden);
        if (!stmt?.targetsTable(table)) continue;
        for (const [role, privileges] of held) {
          if (!stmt.grantees.includes(role)) continue;
          for (const privilege of stmt.writes) {
            if (stmt.verb === "grant") privileges.add(privilege);
            else privileges.delete(privilege);
          }
        }
      }
      for (const [role, privileges] of held) {
        expect([...privileges], `${role} must retain no forbidden table privilege on ${table}`).toEqual([]);
      }
      if (serverTables.includes(table)) {
        expect(livePoliciesFor(table).size, `${table} remains accessible only through authorized server routes`).toBe(0);
      }
    });
  }
});
