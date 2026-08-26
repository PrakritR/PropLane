import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sql(name: string): string {
  return readFileSync(join(process.cwd(), "supabase/migrations", name), "utf8")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

describe("managed SMS service-role boundary", () => {
  it("revokes browser roles from every control-plane table and SECURITY DEFINER RPC", () => {
    const migration = sql("20260825120000_sms_control_plane.sql");
    for (const table of [
      "sms_runtime_config",
      "sms_manager_entitlements",
      "sms_provisioning_operations",
      "sms_consent_events",
      "sms_outbox",
      "sms_delivery_attempts",
      "sms_provider_events",
      "sms_delivery_events",
      "sms_segment_usage",
      "sms_control_receipts",
      "sms_inbound_receipts",
    ]) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(migration).toContain(`revoke all on table public.${table} from anon, authenticated`);
    }

    for (const signature of [
      "apply_sms_control_keyword(text, text, text, timestamptz, uuid, text)",
      "claim_sms_inbound(text, uuid, text, text, integer)",
      "claim_sms_outbox(text, integer, integer, uuid)",
      "claim_manager_sms_provisioning(uuid, uuid)",
      "spend_sms_segment_budget(integer)",
      "apply_manager_sms_number_event(text, text, text, text, timestamptz, text)",
      "apply_sms_delivery_status(text, text, integer, text, timestamptz)",
    ]) {
      expect(migration).toContain(
        `revoke execute on function public.${signature} from public, anon, authenticated`,
      );
      expect(migration).toContain(`grant execute on function public.${signature} to service_role`);
    }
  });

  it("keeps manager contact labels inaccessible through public PostgREST roles", () => {
    const migration = sql("20260826130000_manager_sms_contacts.sql");
    expect(migration).toContain("alter table public.manager_sms_contacts enable row level security");
    expect(migration).toContain(
      "revoke all on table public.manager_sms_contacts from anon, authenticated",
    );
  });
});
