import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assertIdentityDepositLedger, reviewedIdentityDepositMigrations } from "../../scripts/identity-deposit-release-manifest.mjs";

describe("identity and deposit migration release manifest", () => {
  it("pins eleven unique ordered source files", () => {
    const entries = reviewedIdentityDepositMigrations();
    expect(entries).toHaveLength(11);
    expect(new Set(entries.map((m: {version: string}) => m.version)).size).toBe(11);
    expect(entries.map((m: {version: string}) => m.version)).toEqual(entries.map((m: {version: string}) => m.version).sort());
  });
  it("rejects partial, duplicate, renamed and altered ledger entries", () => {
    const migrations = reviewedIdentityDepositMigrations();
    const rows = migrations.map((m: {version: string; name: string; sql: string}) => ({ version: m.version, name: m.name, statements: [m.sql] }));
    expect(() => assertIdentityDepositLedger([], migrations, false)).not.toThrow();
    expect(() => assertIdentityDepositLedger(rows, migrations, true)).not.toThrow();
    expect(() => assertIdentityDepositLedger(rows.slice(1), migrations, true)).toThrow();
    expect(() => assertIdentityDepositLedger([...rows, rows[0]], migrations, true)).toThrow();
    expect(() => assertIdentityDepositLedger([{ ...rows[0], version: "999" }], migrations, false)).toThrow();
    expect(() => assertIdentityDepositLedger([{ ...rows[0], statements: ["changed"] }, ...rows.slice(1)], migrations, true)).toThrow();
  });
  it("changes only the provider null guard and preserves the RPC grants", () => {
    const previous = readFileSync("supabase/migrations/20261030123000_resident_identity_provider_state.sql", "utf8");
    const repaired = readFileSync("supabase/migrations/20261108130000_resident_identity_null_provider_guard.sql", "utf8");
    expect(repaired).toBe(previous
      .replace("drop function if exists public.apply_resident_identity_event(text, text, uuid, text, timestamptz);", "-- Reject absent provider status before applying an identity transition.")
      .replace("not (case p_event_type", "(case p_event_type")
      .replace("else false end) then v_disposition", "else false end) is not true then v_disposition"));
  });
});
