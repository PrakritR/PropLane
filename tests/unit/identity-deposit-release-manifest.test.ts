import { describe, expect, it } from "vitest";
import { assertIdentityDepositLedger, reviewedIdentityDepositMigrations } from "../../scripts/identity-deposit-release-manifest.mjs";

describe("identity and deposit migration release manifest", () => {
  it("pins ten unique ordered source files", () => {
    const entries = reviewedIdentityDepositMigrations();
    expect(entries).toHaveLength(10);
    expect(new Set(entries.map((m: {version: string}) => m.version)).size).toBe(10);
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
});
