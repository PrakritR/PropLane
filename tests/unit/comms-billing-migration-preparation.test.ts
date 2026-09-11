import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as preparation from "../../scripts/prepare-20260911-comms-billing-migrations.mjs";

const PINNED_COMMIT = "8ce3868b4e5775661956c6c3f36fcb146bfa931a";
const CORRECTION_FILE =
  "scripts/rollouts/2026-09-11-comms-billing/20260911160000_comms_credit_recovery_guards.sql";
const EXPECTED_SOURCES = [
  ["20260910140000_manager_communication_credits.sql", 21013, "70e8ddd6138d74f67712076498ec6d5d88f2568470fe446b9954aa4102562c13"],
  ["20260910160000_comms_credit_alerts.sql", 1725, "d6b0dc09f80894e26e1b8b0b9df25f98e85729b948c2c9f94130211481bea07f"],
  ["20260910170000_manager_billing_customer.sql", 354, "7ff6fc4cbaf2e2835194610ea8af22aaa9b772bb1e5ba76943fceaf1336fd4da"],
  ["20260910180000_comms_wallet_snapshots.sql", 1153, "c67d8283ba00d4c1798b370eb5d1374c9309c3f78ed9e9d6086bf87f7bf1572b"],
  ["20260910190000_sms_outbox_campaign_budget.sql", 1467, "9c32e16882f869ae059483655b087117edd2a2c740a40321dc9c28f2d53ead47"],
] as const;
const CORRECTION_VERSION = "20260911160000";
const CORRECTION_NAME = "comms_credit_recovery_guards";

function pinnedSource(file: string) {
  return execFileSync("git", ["show", `${PINNED_COMMIT}:supabase/migrations/${file}`]);
}

function correctionSource() {
  return readFileSync(CORRECTION_FILE);
}

function manifest() {
  return preparation.reviewedMigrationManifest();
}

function bundle() {
  return preparation.buildAtomicBundle();
}

describe("communication billing preparation manifest", () => {
  it("contains exactly the five pinned Git sources plus the correction", () => {
    const entries = manifest();
    expect(entries).toHaveLength(6);
    expect(entries.map(({ file }: { file: string }) => file)).toEqual([
      ...EXPECTED_SOURCES.map(([file]) => file),
      `${CORRECTION_VERSION}_${CORRECTION_NAME}.sql`,
    ]);

    for (const [index, [file, size, sha256]] of EXPECTED_SOURCES.entries()) {
      const source = pinnedSource(file);
      expect(source.byteLength).toBe(size);
      expect(createHash("sha256").update(source).digest("hex")).toBe(sha256);
      expect(entries[index].file).toBe(file);
      expect(entries[index].size ?? Buffer.byteLength(entries[index].sql, "utf8")).toBe(size);
      expect(entries[index].sha256).toBe(sha256);
      expect(Buffer.from(entries[index].sql)).toEqual(source);
    }

    const correction = correctionSource();
    const correctionEntry = entries[5];
    expect(correctionEntry.version).toBe(CORRECTION_VERSION);
    expect(correctionEntry.name).toBe(CORRECTION_NAME);
    expect(Buffer.from(correctionEntry.sql)).toEqual(correction);
    expect(correctionEntry.sha256).toBe(createHash("sha256").update(correction).digest("hex"));
  });

  it("fails closed when a pinned source or correction is changed", () => {
    const entries = manifest();
    const pinned = entries.slice(0, 5);
    const changedPinned = { ...pinned[0], sql: `${pinned[0].sql}\n-- mutation` };
    const changedCorrection = { ...entries[5], sql: `${entries[5].sql}\n-- mutation` };

    expect(() => preparation.buildAtomicBundle([changedPinned, ...entries.slice(1)])).toThrow();
    expect(() => preparation.buildAtomicBundle([...entries.slice(0, 5), changedCorrection])).toThrow();
    expect(() => preparation.reviewedMigrationManifest({
      readPinned: (file: string) => file === `supabase/migrations/${EXPECTED_SOURCES[0][0]}`
        ? Buffer.from("mutated")
        : pinnedSource(file.replace("supabase/migrations/", "")),
    })).toThrow();
  });
});

describe("deterministic candidate bundle", () => {
  it("preserves exact source bytes and order, with six exactSource ledger rows", () => {
    const first = bundle();
    expect(first).toBe(bundle());
    expect(first.match(/-- exact source:/g)).toHaveLength(6);

    let previous = -1;
    for (const entry of manifest()) {
      const marker = `-- exact source: ${entry.file} sha256:${entry.sha256}`;
      const markerPosition = first.indexOf(marker);
      expect(markerPosition).toBeGreaterThan(previous);
      expect(first.slice(markerPosition + marker.length)).toContain(entry.sql);
      previous = markerPosition;
    }

    const correctionPosition = first.indexOf(`-- exact source: ${CORRECTION_VERSION}_${CORRECTION_NAME}.sql`);
    expect(correctionPosition).toBeGreaterThan(first.indexOf("20260910190000_sms_outbox_campaign_budget.sql"));
    expect(first.match(/insert into supabase_migrations\.schema_migrations/g)).toHaveLength(6);
    for (const entry of manifest()) {
      expect(first).toMatch(new RegExp(
        `insert into supabase_migrations\\.schema_migrations\\(version,name,statements\\)\\s*values\\s*\\('${entry.version}','${entry.name}',array\\[`,
      ));
      expect(first).toContain(entry.sql.replaceAll("'", "''"));
    }
  });

  it("supports one auxiliary completeBundle identity without self-referential hash material", () => {
    const row = preparation.completeBundleLedgerRow(bundle());
    expect(row).toEqual({ version: "20260911161000", name: "comms_billing_rollout", statements: [bundle()] });
    expect(row.statements[0]).not.toContain("bundle_sha256");
    expect(JSON.stringify(row)).not.toMatch(/array\[[^\]]*completeBundle/);
  });

  it("contains the atomic timeout, lock, precondition, backfill, and postcheck guards", () => {
    const source = bundle();
    expect(source).toMatch(/set local lock_timeout\s*=\s*'3s'/i);
    expect(source).toMatch(/set local statement_timeout\s*=\s*'60s'/i);
    for (const invariant of [
      "pg_try_advisory_xact_lock",
      "BEGIN",
      "COMMIT",
      "zero",
      "payment_preferences",
      "for update",
      "account_recovery_write_guard",
      "account_recovery_capture_delete",
      "manager_comms_credit_purchases",
      "manager_comms_credit_adjustments",
      "postcheck",
    ]) expect(source.toLowerCase()).toContain(invariant.toLowerCase());
    expect(source).not.toMatch(/disable\s+trigger|drop\s+trigger|alter\s+table\s+.*disable/i);
    expect(source).not.toMatch(/create\s+(or replace\s+)?function\s+public\.account_recovery_/i);
  });

  it("does not weaken RLS/grants or add an unrelated remote/application surface", () => {
    const source = bundle();
    expect(source).not.toMatch(/grant\s+all[^;]*\b(?:anon|authenticated)\b|disable\s+row\s+level\s+security|drop\s+policy/i);
    expect(source).not.toMatch(/supabase\.co|postgres(?:ql)?:\/\/|fetch\(|twilio|resend|remote/i);
    expect(source).not.toMatch(/5257|5259|4709A|Brooklyn/i);
  });
});

describe("preparation CLI boundary and report", () => {
  it("rejects all unsupported, apply, remote, and generic SQL arguments", () => {
    const unsupported = [
      ["--apply"], ["--preflight"], ["--remote"], ["--remote=production"], ["--db-url", "postgres://secret"],
      ["--database-url=postgres://secret"], ["--target", "production"], ["--target=staging"], ["--sql", "select 1"],
      ["--file", "/tmp/migration.sql"], ["--migration", "anything.sql"], ["--generic-sql=select 1"],
      ["--ledger-stdin", "--ledger-stdin"], ["--apply", "--waiver", "anything"],
    ];
    for (const args of unsupported) expect(() => preparation.parsePreparationArgs(args)).toThrow();
    expect(preparation.parsePreparationArgs([])).toEqual({});
    expect(() => preparation.parsePreparationArgs(["--ledger-stdin"])).toThrow();
  });

  it("prints a deterministic sanitized default report", () => {
    const report = preparation.preparationReport();
    expect(report).toEqual(preparation.preparationReport());
    expect(report.preparationOnly).toBe(true);
    expect(report.migrationCount).toBe(6);
    expect(report.applySupported).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/postgres(?:ql)?:\/\/|password|secret|SUPABASE|PGPASSWORD/i);
    expect(JSON.stringify(report)).not.toContain("select ");
  });

  it("does not expose credentials or application output when apply is attempted", () => {
    const secret = "comms-billing-test-secret";
    const result = spawnSync("node", ["scripts/prepare-20260911-comms-billing-migrations.mjs", "--apply"], {
      encoding: "utf8",
      env: { ...process.env, SUPABASE_DB_URL: `postgresql://postgres:${secret}@example.invalid/postgres` },
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    expect(`${result.stdout}${result.stderr}`).toMatch(/preparation|unsupported|forbidden/i);
  });
});
