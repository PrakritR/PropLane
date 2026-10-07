import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNT_PURGE_RETAINED, ACCOUNT_PURGE_TABLES } from "@/lib/auth/account-purge-manifest";

const sql = readFileSync(
  path.join(process.cwd(), "supabase", "migrations", "20261006220000_platform_revenue_vendor_service_fee.sql"),
  "utf8",
);
const code = sql.replace(/--.*$/gm, "");

describe("platform_revenue_entries migration", () => {
  it("is additive and idempotent", () => {
    expect(code).toMatch(/create table if not exists public\.platform_revenue_entries/i);
    for (const match of code.matchAll(/create (?:unique )?index\s+(?!if not exists)/gi)) {
      throw new Error(`non-idempotent index: ${match[0]}`);
    }
    expect(code.match(/create index if not exists/gi)?.length).toBeGreaterThanOrEqual(2);
    expect(code).not.toMatch(/\bdrop\s+(table|column)\b/i);
    expect(code).not.toMatch(/\b(delete\s+from|truncate|update\s+public\.)/i);
    expect(code).not.toMatch(/alter table(?! public\.platform_revenue_entries)/i);
  });

  it("has the exact columns, kinds and sources", () => {
    expect(code).toMatch(/kind text not null check \(kind in \('vendor_service_fee', 'vendor_service_fee_reversal'\)\)/);
    expect(code).toMatch(/source text not null check \(source in \('work_order', 'invoice', 'refund', 'hold_expiry'\)\)/);
    expect(code).toMatch(/amount_cents integer not null/);
    expect(code).toMatch(/idempotency_key text not null unique/);
    expect(code).toMatch(/source_id text not null/);
    expect(code).toMatch(/description text not null/);
  });

  it("keeps vendor and manager ids free of foreign keys so revenue history outlives accounts", () => {
    expect(code).toMatch(/vendor_user_id uuid null,/);
    expect(code).toMatch(/manager_user_id uuid null,/);
    expect(code).not.toMatch(/references/i);
  });

  it("enables RLS, grants no client role anything, and is service_role only", () => {
    expect(code).toMatch(/alter table public\.platform_revenue_entries enable row level security/i);
    expect(code).toMatch(/revoke all on table public\.platform_revenue_entries from anon, authenticated/i);
    expect(code).toMatch(/grant all on table public\.platform_revenue_entries to service_role/i);
    expect(code).not.toMatch(/create policy/i);
    expect(code).not.toMatch(/grant [a-z, ]+ on table public\.platform_revenue_entries to (anon|authenticated)/i);
  });

  it("is classified as retained for account purge (not silently purged)", () => {
    expect("platform_revenue_entries" in ACCOUNT_PURGE_RETAINED).toBe(true);
    expect(ACCOUNT_PURGE_TABLES.some((rule) => rule.table === "platform_revenue_entries")).toBe(false);
  });
});
