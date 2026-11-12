import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The ownership mover (`move_managed_workspace_to_service_owner`) works from an ALLOWLIST: every public table that carries a
 * manager identity column is MOVE (house/workspace scoped), ACCOUNT (moves only for a client with no other live workspace),
 * KEEP (the client's own money history; never written) or SPECIAL (a dedicated step). The function also stops a real run when a
 * table with an identity column is missing from the list and holds rows for the client. This reads the migrations, like
 * account-purge-coverage.test.ts, so a NEW table is a failure here before it is a stopped (or worse, a mis-moved) run.
 */
const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");
const MOVER_FILE = "20261112230000_managed_workspace_mover.sql";
const IDENTITY = ["manager_user_id", "owner_user_id", "owner_manager_user_id", "landlord_id"];
const SCOPE = ["property_id", "assigned_property_id", "workspace_id"];

function readSchema(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    for (const m of sql.matchAll(/create table\s+(?:if not exists\s+)?(?:public\.)?([a-z_]+)\s*\(([\s\S]*?)\n\);/gi)) {
      const t = m[1]!.toLowerCase();
      if (t === "if") continue;
      const cols = tables.get(t) ?? new Set<string>();
      for (const line of m[2]!.split("\n")) {
        const c = /^\s*([a-z_]+)\s+(uuid|text|citext|varchar)\b/i.exec(line);
        if (c) cols.add(c[1]!.toLowerCase());
      }
      tables.set(t, cols);
    }
    for (const m of sql.matchAll(/drop table\s+(?:if exists\s+)?(?:public\.)?([a-z_]+)/gi)) tables.delete(m[1]!.toLowerCase());
    for (const m of sql.matchAll(/alter table\s+(?:if exists\s+)?(?:public\.)?([a-z_]+)\s+rename to\s+(?:public\.)?([a-z_]+)/gi)) {
      const cols = tables.get(m[1]!.toLowerCase());
      if (cols) { tables.set(m[2]!.toLowerCase(), new Set([...cols, ...(tables.get(m[2]!.toLowerCase()) ?? [])])); tables.delete(m[1]!.toLowerCase()); }
    }
    for (const m of sql.matchAll(/alter table\s+(?:if exists\s+)?(?:public\.)?([a-z_]+)([\s\S]*?);/gi)) {
      const cols = tables.get(m[1]!.toLowerCase());
      if (!cols) continue;
      for (const c of m[2]!.matchAll(/add column\s+(?:if not exists\s+)?([a-z_]+)\s+(uuid|text|citext)\b/gi)) cols.add(c[1]!.toLowerCase());
      for (const c of m[2]!.matchAll(/drop column\s+(?:if exists\s+)?([a-z_]+)/gi)) cols.delete(c[1]!.toLowerCase());
    }
  }
  return tables;
}

type Entry = { table: string; klass: string; idCol: string };
function readClassification(): Entry[] {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, MOVER_FILE), "utf8");
  const body = sql.slice(sql.indexOf("select * from (values"), sql.indexOf(") as t(table_name, klass, id_col)"));
  return [...body.matchAll(/\('([a-z_]+)',\s*'(move|account|keep|special)',\s*'([a-z_]+)'\)/g)].map((m) => ({ table: m[1]!, klass: m[2]!, idCol: m[3]! }));
}

describe("managed move classification (allowlist)", () => {
  const schema = readSchema();
  const entries = readClassification();
  const byTable = new Map(entries.map((e) => [e.table, e]));

  it("reads a real classification", () => {
    expect(entries.length).toBeGreaterThan(150);
    expect(new Set(entries.map((e) => e.table)).size).toBe(entries.length);
  });

  it("classifies every table that carries a manager identity column", () => {
    const missing: string[] = [];
    for (const [table, cols] of schema) {
      if (!IDENTITY.some((c) => cols.has(c))) continue;
      if (!byTable.has(table)) missing.push(table);
    }
    expect(missing.sort(), "add these to managed_move_classification() as move / account / keep / special").toEqual([]);
  });

  it("names a real identity column for each entry, and a scope column for every MOVE table", () => {
    const bad: string[] = [];
    for (const e of entries) {
      const cols = schema.get(e.table);
      if (!cols) continue; // created by a statement shape this reader does not parse; the dev scan in the rehearsal covers it
      if (!cols.has(e.idCol)) bad.push(`${e.table}: no column ${e.idCol}`);
      if (e.klass === "move" && !SCOPE.some((c) => cols.has(c))) bad.push(`${e.table}: MOVE with no property_id / assigned_property_id / workspace_id`);
      if (e.klass === "account" && SCOPE.some((c) => cols.has(c))) bad.push(`${e.table}: ACCOUNT but it has a scope column (make it MOVE)`);
    }
    expect(bad).toEqual([]);
  });

  it("keeps the client's money, identity and pre-management history out of the move", () => {
    for (const t of [
      "managed_workspace_fee_policies", "managed_rent_allocations", "owner_statements", "owner_expenses", "platform_payment_holds",
      "payout_destinations_cache", "payout_identity_status", "stripe_payouts", "stripe_disputes", "gl_journal_entries", "chart_of_accounts",
      "manager_bank_accounts", "manager_tax_profiles", "manager_billing_settings", "audit_log", "number_subscriptions",
      "manager_owner_distributions", "platform_revenue_entries",
    ]) {
      expect(byTable.get(t)?.klass, t).toBe("keep");
    }
  });

  it("moves the operational rows staff read by workspace or house", () => {
    for (const t of [
      "manager_application_records", "portal_lease_pipeline_records", "portal_household_charge_records", "portal_recurring_rent_profile_records",
      "portal_work_order_records", "portal_service_request_records", "ledger_entries", "portal_inbox_thread_records", "manager_sms_messages",
      "resident_inspections", "security_deposit_ledger", "manager_documents",
    ]) {
      expect(byTable.get(t)?.klass, t).toBe("move");
    }
  });

  it("writes the property and workspace rows only through dedicated steps, never the generic loop", () => {
    for (const t of ["manager_property_records", "portal_workspaces", "manager_sms_numbers", "manager_assistant_emails", "platform_service_settings"]) {
      expect(byTable.get(t)?.klass, t).toBe("special");
    }
  });

  it("never writes property_data or row_data of a listing, and takes p_to from the service-owner row, not a parameter", () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, MOVER_FILE), "utf8");
    const fn = sql.slice(sql.indexOf("create or replace function public.move_managed_workspace_to_service_owner"), sql.indexOf("create or replace function public.undo_managed_workspace_move"));
    expect(fn).not.toMatch(/set\s+property_data|set\s+row_data|property_data\s*=|row_data\s*=/i);
    expect(fn).toMatch(/select owner_user_id into v_to from public\.platform_service_settings/);
    expect(fn).not.toMatch(/p_to\b/);
    expect(sql).toMatch(/revoke all on function public\.move_managed_workspace_to_service_owner\(uuid, uuid, boolean\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.move_managed_workspace_to_service_owner\(uuid, uuid, boolean\) to service_role/);
  });
});
