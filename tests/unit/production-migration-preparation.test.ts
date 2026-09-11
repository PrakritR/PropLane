import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLI_MECHANISM_EVIDENCE,
  buildAtomicBundle,
  generatePrivateWorkspace,
  inspectAppliedState,
  parseLedgerSnapshot,
  parsePreparationArgs,
  preparationReport,
  reviewedMigrationManifest,
  validateManifestEntries,
} from "../../scripts/prepare-20260911-production-migrations.mjs";

const expectedFiles = [
  "20260907130000_webhook_subscriptions.sql",
  "20260907214100_preserve_resident_financial_history.sql",
  "20260907221500_preserve_shared_vendor_financial_history.sql",
  "20260907223000_account_attachment_references.sql",
  "20260907224000_account_recovery_shared_retention.sql",
  "20260907224500_account_recovery_snapshot.sql",
  "20260907225000_account_recovery_identity_patches.sql",
  "20260907225500_account_recovery_capture.sql",
  "20260907230000_account_recovery_object_generations.sql",
  "20260907231000_account_recovery_financial_access_keys.sql",
  "20260907232000_account_recovery_restore.sql",
  "20260907233000_account_recovery_finish_archival.sql",
];
const manifest = reviewedMigrationManifest();
const exactApplied = manifest.map(({ version, name }) => ({ version, name }));

describe("production migration preparation manifest", () => {
  it("pins exactly the 12 plan migrations in stable order", () => {
    expect(manifest.map((entry) => entry.file)).toEqual(expectedFiles);
    expect(manifest).toHaveLength(12);
    expect(preparationReport(undefined)).toEqual(preparationReport(undefined));
    expect(preparationReport(undefined).workspaceGenerated).toBe(false);
    expect(preparationReport(undefined).mechanismEvidence).toBe(CLI_MECHANISM_EVIDENCE);
  });

  it("rejects missing, unexpected, reordered, and digest-drifted sources", () => {
    const raw = manifest.map(({ version, name, sha256 }) => [version, name, sha256]);
    expect(() => validateManifestEntries(raw.slice(1))).toThrow(/exactly 12/);
    expect(() => validateManifestEntries([...raw, raw[0]])).toThrow(/exactly 12/);
    expect(() => validateManifestEntries([raw[1], raw[0], ...raw.slice(2)])).toThrow(/position 1/);
    expect(() => reviewedMigrationManifest({ readSource: () => Buffer.from("changed SQL") })).toThrow(/digest changed/);
    expect(() => reviewedMigrationManifest({ candidateFiles: expectedFiles.slice(1) })).toThrow(/missing or unexpected/);
    expect(() => reviewedMigrationManifest({ candidateFiles: [...expectedFiles, "20260907232500_unexpected.sql"] }))
      .toThrow(/missing or unexpected/);
  });

  it("does not include any protected listing restore", () => {
    const sources = manifest.map(({ file }) =>
      readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8")).join("\n");
    expect(sources).not.toMatch(/5257|5259|4709A|Brooklyn/i);
  });
});

describe("fail-closed ledger states", () => {
  it("recognizes only an already-complete exact named installation", () => {
    expect(inspectAppliedState(exactApplied).status).toBe("already_complete");
    expect(inspectAppliedState([]).status).toBe("ready");
  });

  it("rejects every partial installation", () => {
    expect(inspectAppliedState(exactApplied.slice(0, 1)).status).toBe("partial");
    expect(inspectAppliedState(exactApplied.slice(0, -1)).status).toBe("partial");
  });

  it("rejects target version/name conflicts and duplicate ledger identities", () => {
    expect(inspectAppliedState([{ version: manifest[0].version, name: "different" }]).status).toBe("conflict");
    expect(inspectAppliedState([{ version: "20260101000000", name: manifest[0].name }]).status).toBe("conflict");
    expect(inspectAppliedState([exactApplied[0], exactApplied[0]]).status).toBe("conflict");
  });

  it("surfaces unknown historical bundles without treating them as the 12 named migrations", () => {
    const state = inspectAppliedState([{ version: "20260101000000", name: "historical_bundle" }]);
    expect(state.status).toBe("ready");
    expect(state.installed).toBe(0);
    expect(state.unknownHistoricalBundles).toEqual([{ version: "20260101000000", name: "historical_bundle" }]);
    expect(inspectAppliedState([{ version: "20260101000000", name: "" }]).status).toBe("conflict");
  });
});

describe("private CLI workspace", () => {
  it("contains validated ledger sentinels plus exactly one atomic pending bundle", () => {
    const known = [{ version: "20260907090000", name: "resident_invite_links" }];
    const root = mkdtempSync(join(tmpdir(), "preparation-test-"));
    const generated = generatePrivateWorkspace(known, { makeTemp: () => root });
    expect(readdirSync(join(root, "supabase", "migrations"))).toEqual([
      "20260907090000_resident_invite_links.sql",
      "20260911010000_production_recovery_schema.sql",
    ]);
    expect(generated.command).toEqual([
      "npx", "-y", "supabase@2.117.0", "db", "push", "--project-ref", "qahnczmilgptcedaqype",
      "--skip-vault", "--workdir", root, "--dry-run",
    ]);
    expect(readFileSync(join(root, "supabase", "migrations", "20260907090000_resident_invite_links.sql"), "utf8"))
      .toContain("Historical ledger sentinel must never execute");
    const bundle = readFileSync(join(root, "supabase", "migrations", generated.bundleFile), "utf8");
    expect(bundle).not.toMatch(/^\s*(begin|commit)\s*;/im);
    expect(bundle).toContain("set local lock_timeout = '3s'");
    expect(bundle).toContain("set local statement_timeout = '60s'");
    expect(bundle).toContain("current_setting('lock_timeout')::interval");
    expect(bundle).toContain("current_setting('statement_timeout')::interval");
    expect(bundle).toContain("pg_try_advisory_xact_lock(723081447302::bigint)");
    expect(bundle).not.toContain("lock table supabase_migrations.schema_migrations");
    expect(bundle.indexOf("production recovery migration ledger is no longer absent"))
      .toBeLessThan(bundle.indexOf("-- exact source:"));
    const prerequisiteRelationGuard = bundle.indexOf("to_regclass(item) is null");
    const existingRecoveryBucketGuard = bundle.indexOf(
      "select 1 from storage.buckets where id = 'account-recovery'",
    );
    const existingRecoveryBucketDiagnostic = bundle.indexOf(
      "production recovery bucket is no longer absent",
    );
    expect(prerequisiteRelationGuard).toBeGreaterThan(-1);
    expect(existingRecoveryBucketGuard).toBeGreaterThan(prerequisiteRelationGuard);
    expect(existingRecoveryBucketDiagnostic).toBeGreaterThan(existingRecoveryBucketGuard);
    expect(existingRecoveryBucketDiagnostic).toBeLessThan(bundle.indexOf("-- exact source:"));
    const finalSource = bundle.lastIndexOf("-- exact source:");
    const privacyPostcondition = bundle.indexOf("production recovery bucket is not private after install");
    const firstLedgerInsert = bundle.indexOf(
      "insert into supabase_migrations.schema_migrations(version,name,statements) values (",
    );
    expect(bundle).toContain("where id = 'account-recovery' for update");
    expect(privacyPostcondition).toBeGreaterThan(finalSource);
    expect(firstLedgerInsert).toBeGreaterThan(privacyPostcondition);
    expect(bundle.match(/-- exact source:/g)).toHaveLength(12);
    expect(bundle.match(/insert into supabase_migrations\.schema_migrations/g)).toHaveLength(12);
    expect(bundle).not.toMatch(/array\['sha256:/);
    expect(bundle).not.toMatch(/5257|5259|4709A|Brooklyn/i);
  });

  it("refuses workspaces for replay, partial, and target-conflict states", () => {
    for (const applied of [
      exactApplied,
      exactApplied.slice(0, 1),
      [{ version: manifest[0].version, name: "different" }],
    ]) expect(() => generatePrivateWorkspace(applied)).toThrow(/workspace refused/);
  });

  it("preserves a validated unknown historical row as a sentinel, not equivalence", () => {
    const root = mkdtempSync(join(tmpdir(), "preparation-test-"));
    const row = { version: "20260101000000", name: "historical_bundle" };
    const generated = generatePrivateWorkspace([row], { makeTemp: () => root });
    expect(readFileSync(join(root, "supabase", "migrations", `${row.version}_${row.name}.sql`), "utf8"))
      .toContain("Historical ledger sentinel must never execute");
    expect(inspectAppliedState([row]).unknownHistoricalBundles).toEqual([row]);
    expect(generated.bundleFile).toBe("20260911010000_production_recovery_schema.sql");
  });

  it("builds stable bundle bytes from the exact pinned sources", () => {
    expect(buildAtomicBundle()).toBe(buildAtomicBundle());
  });
});

describe("input boundary", () => {
  it("explicitly rejects apply, arbitrary paths, SQL, and duplicate flags", () => {
    expect(() => parsePreparationArgs(["--apply"])).toThrow(/forbidden/);
    for (const args of [["--file=/tmp/x"], ["--sql=select 1"], ["--ledger-stdin", "--ledger-stdin"]]) {
      expect(() => parsePreparationArgs(args)).toThrow(/Unsupported/);
    }
  });

  it("accepts only inert, bounded ledger metadata", () => {
    expect(parseLedgerSnapshot({ applied: exactApplied })).toEqual(exactApplied);
    for (const input of [
      { applied: exactApplied, dbUrl: "postgres://secret" },
      { applied: [{ version: manifest[0].version, name: "x; drop table profiles" }] },
      { applied: [{ version: manifest[0].version, name: manifest[0].name, sql: "select 1" }] },
      { applied: Array.from({ length: 1_001 }, () => exactApplied[0]) },
    ]) expect(() => parseLedgerSnapshot(input)).toThrow();
  });

  it("the CLI rejects --apply without logging inherited secrets", () => {
    const secret = "never-print-this-production-password";
    const result = spawnSync("node", ["scripts/prepare-20260911-production-migrations.mjs", "--apply"], {
      encoding: "utf8",
      env: { ...process.env, SUPABASE_DB_URL: `postgresql://postgres:${secret}@example.invalid/postgres` },
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("preparation-only");
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });

  it("the CLI treats exact replay as complete and blocks a fresh state", () => {
    const run = (applied: typeof exactApplied) => spawnSync(
      "node", ["scripts/prepare-20260911-production-migrations.mjs", "--ledger-stdin"],
      { encoding: "utf8", input: JSON.stringify({ applied }) },
    );
    const complete = run(exactApplied);
    expect(complete.status).toBe(0);
    expect(JSON.parse(complete.stdout).state.status).toBe("already_complete");
    expect(JSON.parse(complete.stdout).workspaceGenerated).toBe(false);
    const fresh = run([]);
    expect(fresh.status).toBe(0);
    expect(JSON.parse(fresh.stdout).state.status).toBe("ready");
    expect(JSON.parse(fresh.stdout).workspaceGenerated).toBe(true);
  });

  it("malformed JSON cannot echo secret input", () => {
    const secret = "postgresql://postgres:secret@example.invalid/postgres";
    const result = spawnSync(
      "node", ["scripts/prepare-20260911-production-migrations.mjs", "--ledger-stdin"],
      { encoding: "utf8", input: secret },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not valid JSON");
    expect(result.stderr).not.toContain(secret);
  });
});
