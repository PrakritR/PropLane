import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../supabase/migrations/20260918131500_test_workspaces.sql", import.meta.url),
  "utf8",
);
const rawListingReadRepair = readFileSync(
  new URL("../../supabase/migrations/20260918133000_remove_raw_live_listing_read_policy.sql", import.meta.url),
  "utf8",
);
const directAccessRevoke = readFileSync(
  new URL("../../supabase/migrations/20260919123000_revoke_classified_test_workspace_direct_access.sql", import.meta.url),
  "utf8",
);
const lateDirectAccessRevoke = readFileSync(
  new URL("../../supabase/migrations/20260919124500_harden_late_test_workspace_direct_access.sql", import.meta.url),
  "utf8",
);
const directAccessCatalog = JSON.parse(readFileSync(
  new URL("../../docs/plans/production-test-accounts/release-dev-direct-access-catalog.json", import.meta.url),
  "utf8",
)) as { tables: Array<{ table: string }> };
const identityAndRecoveryTables = new Set([
  "profiles", "profile_roles", "test_workspaces", "test_workspace_members",
  "site_content_records", "site_config_records", "site_preset_records",
]);
describe("test workspace durable link classification migration", () => {
  it("marks account and vendor link rows with durable workspace identity", () => {
    expect(migration).toMatch(/alter table public\.account_link_invites[\s\S]*?add column if not exists test_workspace_id uuid/i);
    expect(migration).toMatch(/alter table public\.vendor_invites[\s\S]*?add column if not exists test_workspace_id uuid/i);
  });

  it("guards mixed-principal links in the database trigger path", () => {
    expect(migration).toContain("derive_test_workspace_provenance");
    expect(migration).toMatch(/account_link_invites[\s\S]*?test_workspace_id/i);
    expect(migration).toMatch(/vendor_invites[\s\S]*?test_workspace_id/i);
  });

  it("does not recreate the raw live-listing policy after the projection lock", () => {
    // The original migration is already applied and immutable. The later
    // forward migration must remove the accidental policy without recreating it.
    expect(rawListingReadRepair).toMatch(
      /drop\s+policy\s+if\s+exists\s+["']manager_property_records_select_live["']/i,
    );
    expect(rawListingReadRepair).not.toMatch(/create\s+policy\s+["']?manager_property_records_select_live/i);
  });

  it("denies classified authenticated principals from direct business and storage access", () => {
    expect(directAccessRevoke).toMatch(/is_classified_test_workspace_principal/i);
    expect(directAccessRevoke).toMatch(/as restrictive\s+for all to authenticated/i);
    expect(directAccessRevoke).toMatch(/portal_service_request_records/i);
    expect(directAccessRevoke).toMatch(/manager_property_records/i);
    expect(directAccessRevoke).toMatch(/manager_portfolio_import_records/i);
    expect(directAccessRevoke).toMatch(/property_utility_allocations/i);
    expect(directAccessRevoke).toMatch(/vendor_business_profiles/i);
    expect(directAccessRevoke).toMatch(/on storage\.objects/i);
    expect(directAccessRevoke).toMatch(/current_user_has_password/i);
    expect(directAccessRevoke).toMatch(/current_test_workspace_membership/i);
    expect(directAccessRevoke).toMatch(/revoke all on function public\.allocate_sms_proxy_number\(uuid\) from public, anon, authenticated/i);
    expect(directAccessRevoke).toMatch(/grant execute on function public\.allocate_sms_proxy_number\(uuid\) to service_role/i);
    expect(directAccessRevoke).not.toMatch(/pg_proc/i);
    expect(directAccessRevoke).not.toMatch(/PROPLANE_TEST_WORKSPACES_ENABLED/i);
  });

  it("covers every catalogued business table while preserving only identity and recovery rows", () => {
    for (const { table } of directAccessCatalog.tables) {
      if (identityAndRecoveryTables.has(table)) continue;
      expect(directAccessRevoke).toContain(`'${table}'`);
    }
    for (const table of identityAndRecoveryTables) {
      expect(directAccessRevoke).not.toMatch(new RegExp(`'${table}'`));
    }
  });

  it("forward-hardens later-schema tables without changing the applied ninth migration", () => {
    expect(lateDirectAccessRevoke).toMatch(/to_regclass\(format\('public\.%I', table_name\)\) is null/i);
    expect(lateDirectAccessRevoke).toMatch(/continue;/i);
    expect(lateDirectAccessRevoke).toMatch(/as restrictive for all to authenticated/i);
    expect(lateDirectAccessRevoke).toContain("'agent_user_preferences'");
    expect(lateDirectAccessRevoke).toContain("'webhook_subscriptions'");
    expect(lateDirectAccessRevoke).toContain("'webhook_deliveries'");
  });
});
