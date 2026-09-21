import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TARGETS, assertTransactionalSql, buildAtomicBundle, inspectTargetState,
  ledgerRowDigest, parseArgs, policyInventory, reviewedMigrations, validateSnapshot,
} from "../../scripts/prepare-test-workspace-release-migrations.mjs";

const migrations = reviewedMigrations();
const inventory = policyInventory(migrations);
const historical = [
  { version: "20200101000000", name: "automated_communication_reminder_kinds", statements: ["select 'historical private value';"] },
  { version: "20200102000000", name: "automated_communication_reminder_kinds", statements: null },
  { version: "20200103000000", name: null, statements: [null, "select 'Unicode 🛩️';"] },
];
function snapshot(target: "staging" | "production" = "staging") {
  return { project: TARGETS[target], read_only: "on", ledger: structuredClone(historical),
    tables: inventory.finalTables.filter((name: string) => !inventory.created.includes(name))
      .map((name: string) => ({ name, rls: true })) };
}

describe("immutable offline release migration preparation", () => {
  it("preserves the exact first-nine order and source bodies", () => {
    expect(migrations.slice(0, 9).map((row: { version: string }) => row.version)).toEqual([
      "20260917120000", "20260917193000", "20260917201500", "20260918130000",
      "20260918131500", "20260918133000", "20260919113000", "20260919120000", "20260919123000",
    ]);
    for (const row of migrations) {
      const source = readFileSync(new URL(`../../supabase/migrations/${row.file}`, import.meta.url), "utf8");
      expect(row.statements).toEqual([source]);
      expect(row.sql).toBe(source);
    }
    expect(migrations).toHaveLength(10);
    expect(migrations[9].sha256).toBe("f25bc175cfcc79aa29994c705e70a20e44bca8f97fbad97b05c629c25c24a282");
    expect(migrations[8].sha256).toBe("52c4f59995d8812cbb504db4485aa18076fc53050904d0d1a814bfd5c82f8d80");
  });

  it("rejects source-byte drift, missing sources and a duplicate pinned version", () => {
    expect(() => reviewedMigrations({ readSource: () => Buffer.from("-- changed\n") })).toThrow(/hash changed/);
    const files = migrations.map((row: { file: string }) => row.file);
    expect(() => reviewedMigrations({ files: files.slice(1) })).toThrow(/Missing/);
    expect(() => reviewedMigrations({ files: [...files, "20260917120000_other.sql"] })).toThrow(/duplicate/);
  });

  it("requires a full read-only ledger capture bound to the exact allowed target", () => {
    expect(() => validateSnapshot(undefined, "staging")).toThrow();
    expect(() => validateSnapshot(snapshot(), "production")).toThrow(/exact-target/);
    expect(() => validateSnapshot(snapshot(), "development")).toThrow();
    expect(() => validateSnapshot({ ...snapshot(), read_only: "off" }, "staging")).toThrow();
    const missingStatements = { ...snapshot(), ledger: [{ version: "20200101", name: "old" }] };
    expect(() => validateSnapshot(missingStatements, "staging")).toThrow(/statements/);
    expect(() => validateSnapshot({ ...snapshot(), ledger: [] }, "staging")).toThrow();
  });

  it("preserves historical duplicate names and null statement arrays without repairs", () => {
    const before = snapshot();
    const original = structuredClone(before);
    expect(validateSnapshot(before, "staging").ledger).toEqual(historical);
    expect(before).toEqual(original);
    const duplicateVersion = { ...before, ledger: [...before.ledger, before.ledger[0]] };
    expect(() => validateSnapshot(duplicateVersion, "staging")).toThrow(/unique versions/);
  });

  it("refuses partial task installation and mismatched task names or statement bytes", () => {
    const partial = { ...snapshot(), ledger: [...historical, migrations[0]] };
    expect(() => inspectTargetState(partial, "staging")).toThrow(/Partial/);
    const wrongName = { ...snapshot(), ledger: [...historical, { ...migrations[0], name: "different" }] };
    expect(() => inspectTargetState(wrongName, "staging")).toThrow(/Conflicting/);
    const wrongVersion = { ...snapshot(), ledger: [...historical, { ...migrations[0], version: "20000101000000" }] };
    expect(() => inspectTargetState(wrongVersion, "staging")).toThrow(/Conflicting/);
    const wrongBody = { ...snapshot(), ledger: [...historical, { ...migrations[0], statements: [migrations[0].sql + "\n"] }] };
    expect(() => inspectTargetState(wrongBody, "staging")).toThrow(/Conflicting/);
  });

  it("refuses any unreviewed business table and disabled RLS", () => {
    const extra = { ...snapshot(), tables: [...snapshot().tables, { name: "unreviewed_business", rls: true }] };
    expect(() => inspectTargetState(extra, "staging")).toThrow(/inventory mismatch/);
    const missing = { ...snapshot(), tables: snapshot().tables.slice(1) };
    expect(() => inspectTargetState(missing, "staging")).toThrow(/inventory mismatch/);
    const rlsOff = { ...snapshot(), tables: snapshot().tables.map((row, i) => ({ ...row, rls: i !== 0 })) };
    expect(() => validateSnapshot(rlsOff, "staging")).toThrow(/enabled RLS/);
  });

  it("emits one complete transaction, preserves historical bytes by fingerprint and refuses replay", () => {
    expect(inventory.missingForward).toEqual([]);
    expect(inventory.denied).toHaveLength(149);
    const prepared = buildAtomicBundle({ target: "staging", snapshot: snapshot(), backupSha256: "a".repeat(64) });
    expect(prepared.sql).toMatch(/\nBEGIN;/);
    expect(prepared.sql).toMatch(/COMMIT;\n$/);
    expect(prepared.sql.indexOf("20260918131500_test_workspaces.sql")).toBeLessThan(prepared.sql.indexOf("20260918133000_remove_raw_live_listing_read_policy.sql"));
    expect(prepared.sql.indexOf("$release_schema_postconditions$")).toBeLessThan(prepared.sql.indexOf("insert into supabase_migrations.schema_migrations"));
    expect(prepared.sql).not.toContain("historical private value");
    expect(prepared.plan.ledgerBefore).toHaveLength(historical.length);
    expect(prepared.plan.ledgerAfter).toHaveLength(historical.length + migrations.length);
    for (const row of historical) expect(prepared.plan.ledgerAfter).toContainEqual({ version: row.version, name: row.name, sha256: ledgerRowDigest(row) });
    const complete = { ...snapshot(), ledger: [...historical, ...migrations], tables: inventory.finalTables.map((name: string) => ({ name, rls: true })) };
    expect(inspectTargetState(complete, "staging").status).toBe("already_complete");
    expect(() => buildAtomicBundle({ target: "staging", snapshot: complete, backupSha256: "a".repeat(64) })).toThrow(/already complete/);
    expect(() => buildAtomicBundle({ target: "staging", snapshot: snapshot() })).toThrow(/backup/);
  });

  it("frames UTF-8 text, nulls, empty arrays and statement boundaries distinctly", () => {
    const base = { version: "20200101", name: "old" };
    const variants = [null, [], [null], [""], ["a", "bc"], ["ab", "c"], ["🛩️"], ["N"]];
    const hashes = variants.map((statements) => ledgerRowDigest({ ...base, statements }));
    expect(new Set(hashes).size).toBe(variants.length);
    expect(ledgerRowDigest({ ...base, statements: ["select 1;\n"] })).not.toBe(ledgerRowDigest({ ...base, statements: ["select 1;"] }));
  });

  it("masks nested comments, quoted literals and dollar bodies but rejects transaction escapes", () => {
    expect(assertTransactionalSql("/* outer /* COMMIT; */ done */ DO $body$ BEGIN RAISE NOTICE 'ROLLBACK;'; END $body$; SELECT 'x'';COMMIT;', E'\\\\'; -- COMMIT;\n")).toBe(true);
    for (const sql of ["COMMIT;", "DO $$ BEGIN END $$; ROLLBACK;", "-- comment\nBEGIN;", "SET SESSION statement_timeout=0;", "VACUUM;", "\\i other.sql", "CREATE INDEX CONCURRENTLY i ON t(id);"]) {
      expect(() => assertTransactionalSql(sql)).toThrow();
    }
    for (const sql of ["DO $body$ never closed", "SELECT 'open", "/* not closed"]) expect(() => assertTransactionalSql(sql)).toThrow(/Unterminated/);
  });

  it("has no credential/apply argument or default side effects", () => {
    expect(parseArgs([])).toEqual({});
    for (const args of [["--apply"], ["--db-url", "postgres://secret"], ["--target", "production"], ["--out", "x", "--out", "y"]]) expect(() => parseArgs(args)).toThrow();
  });
});
