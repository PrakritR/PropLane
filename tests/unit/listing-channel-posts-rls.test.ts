import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ACCOUNT_PURGE_TABLES } from "@/lib/auth/account-purge-manifest";

/**
 * Static end-state guard in the style of role-grant-surface.test.ts: `public` is reachable through
 * PostgREST, so a client role must never be able to write `listing_channel_posts` (a manager could
 * forge "posted" state or point a row at another manager's property), and must never read the
 * encrypted Meta token table at all.
 */
const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

function statements(): { sql: string; file: string }[] {
  const out: { sql: string; file: string }[] = [];
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const stripped = readFileSync(join(MIGRATIONS_DIR, file), "utf8")
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    for (const chunk of stripped.split(";")) {
      const sql = chunk.trim().replace(/\s+/g, " ");
      if (sql) out.push({ sql, file });
    }
  }
  return out;
}

const ALL = statements();
const touching = (table: string) => ALL.filter((s) => new RegExp(`\\b(public\\.)?${table}\\b`, "i").test(s.sql));

describe("listing_channel_posts grant surface", () => {
  const posts = touching("listing_channel_posts");

  it("RLS is enabled", () => {
    expect(posts.some((s) => /alter table public\.listing_channel_posts enable row level security/i.test(s.sql))).toBe(true);
  });

  it("client roles are revoked, then granted SELECT only", () => {
    const grants = posts.filter((s) => /^grant /i.test(s.sql));
    const clientGrants = grants.filter((s) => /\bto (anon|authenticated)\b/i.test(s.sql));
    expect(clientGrants.length).toBeGreaterThan(0);
    for (const grant of clientGrants) {
      expect(grant.sql).toMatch(/^grant select on table/i);
      expect(grant.sql).not.toMatch(/\b(insert|update|delete|all|truncate)\b/i);
      expect(grant.sql).not.toMatch(/\banon\b/i);
    }
    expect(posts.some((s) => /^revoke all on table public\.listing_channel_posts from anon, authenticated/i.test(s.sql))).toBe(true);
  });

  it("the only policy is a SELECT scoped to manager_user_id = auth.uid(), dropped before it is created", () => {
    const policies = posts.filter((s) => /^create policy/i.test(s.sql));
    expect(policies).toHaveLength(1);
    expect(policies[0]!.sql).toMatch(/for select/i);
    expect(policies[0]!.sql).not.toMatch(/for (all|insert|update|delete)/i);
    expect(policies[0]!.sql).toMatch(/using \(manager_user_id = auth\.uid\(\)\)/i);
    const drop = posts.findIndex((s) => /^drop policy if exists listing_channel_posts_select_own/i.test(s.sql));
    const create = posts.findIndex((s) => /^create policy listing_channel_posts_select_own/i.test(s.sql));
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(drop).toBeLessThan(create);
  });

  it("is additive and idempotent", () => {
    for (const s of posts.filter((x) => /^create (table|index|unique index)/i.test(x.sql))) {
      expect(s.sql).toMatch(/if not exists/i);
    }
    expect(posts.some((s) => /^drop table|^alter table .* drop /i.test(s.sql))).toBe(false);
  });
});

describe("listing_channel_connections (encrypted Meta token)", () => {
  const connections = touching("listing_channel_connections");

  it("is service-role only: no client grant of any kind, not even SELECT, and no policy", () => {
    expect(connections.some((s) => /alter table public\.listing_channel_connections enable row level security/i.test(s.sql))).toBe(true);
    expect(connections.some((s) => /^revoke all on table public\.listing_channel_connections from anon, authenticated/i.test(s.sql))).toBe(true);
    for (const s of connections.filter((x) => /^grant /i.test(x.sql))) {
      expect(s.sql).toMatch(/to service_role$/i);
    }
    expect(connections.some((s) => /^create policy/i.test(s.sql))).toBe(false);
  });

  it("stores the page token only as an encrypted column", () => {
    expect(connections.some((s) => /page_token_encrypted text not null/i.test(s.sql))).toBe(true);
    expect(connections.some((s) => /\b(page_token|access_token) text/i.test(s.sql))).toBe(false);
  });
});

describe("account purge", () => {
  it("classifies both tables on the manager's id", () => {
    for (const table of ["listing_channel_posts", "listing_channel_connections"]) {
      const rule = ACCOUNT_PURGE_TABLES.find((t) => t.table === table);
      expect(rule?.manager?.ids).toContain("manager_user_id");
    }
  });
});
