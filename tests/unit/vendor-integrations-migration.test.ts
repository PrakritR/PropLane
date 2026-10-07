import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNT_PURGE_TABLES } from "@/lib/auth/account-purge-manifest";

const sql = readFileSync(
  path.join(process.cwd(), "supabase", "migrations", "20261006210000_vendor_integrations.sql"),
  "utf8",
);
const executable = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .toLowerCase();

describe("vendor integrations migration", () => {
  it("is additive and idempotent", () => {
    expect(executable).toContain("create table if not exists public.vendor_calendar_feeds");
    expect(executable).toContain("create table if not exists public.vendor_integration_access_requests");
    expect(executable).not.toMatch(/\bdrop\s+(table|column|index|policy)/);
    expect(executable).not.toMatch(/\btruncate\b|\bdelete\s+from\b|\bupdate\s+public\./);
    expect(executable).not.toMatch(/alter\s+table[^;]*\b(drop|rename|alter\s+column)\b/);
    for (const match of executable.matchAll(/create\s+(unique\s+)?index\s+(?!if not exists)/g)) {
      throw new Error(`non-idempotent index: ${match[0]}`);
    }
  });

  it("locks both tables to the service role with RLS enabled", () => {
    for (const table of ["vendor_calendar_feeds", "vendor_integration_access_requests"]) {
      expect(executable).toContain(`alter table public.${table} enable row level security`);
      expect(executable).toContain(`revoke all on table public.${table} from anon, authenticated`);
      expect(executable).toContain(`grant all on table public.${table} to service_role`);
    }
  });

  it("pins the provider allowlist and the per-vendor uniqueness", () => {
    expect(executable).toContain("check (provider in ('jobber', 'housecall_pro', 'thumbtack'))");
    expect(executable).toContain("unique (vendor_user_id, provider)");
  });

  it("classifies both tables for account purge", () => {
    for (const table of ["vendor_calendar_feeds", "vendor_integration_access_requests"]) {
      const rule = ACCOUNT_PURGE_TABLES.find((r) => r.table === table);
      expect(rule?.vendor?.ids).toEqual(["vendor_user_id"]);
    }
  });
});
