import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { assertCatalogShape, parseOptions, reviewedMigration, runTransaction } from "../../scripts/sms-notice-atomic-release-migration.mjs";

const migration = reviewedMigration();
const backup = "/Users/akhilvemuri/.codex/release-backups/sms-20260926/sms-notice-atomic-staging-20260926T000000.dump";

test("valid phases parse and invalid requests fail before credential bootstrap", () => {
  for (const phase of ["preflight", "rehearsal", "postflight"]) assert.equal(parseOptions(["--target", "staging", "--phase", phase]).phase, phase);
  assert.equal(parseOptions(["--target", "staging", "--phase", "apply", "--apply-authorized", "--backup-file", backup]).backupFile, backup);
  for (const argv of [["--target", "dev"], ["--target", "production", "--phase", "rehearsal"], ["--target", "staging", "--phase", "apply"],
    ["--target", "staging", "--phase", "preflight", "--phase", "postflight"]]) {
    assert.throws(() => parseOptions(argv));
    const result = spawnSync(process.execPath, [new URL("../../scripts/sms-notice-atomic-release-migration.mjs", import.meta.url).pathname, ...argv], { encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /Credential bootstrap/);
  }
});

test("postflight checks ledger, full body, security mode and service-only ACL", () => {
  const base = { prerequisites: { inbox: true, controls: true }, ledger: [{ version: migration.version, name: migration.name, statements: [migration.sql] }],
    functions: [{ signature: "append_manager_sms_inbox_notice(uuid,text,text,text,jsonb,jsonb,boolean,text[])", body: migration.body, returnType: "jsonb",
      language: "plpgsql", volatility: "v", securityDefiner: false, searchPath: "search_path=public, pg_temp", anonExecute: false, authExecute: false, serviceExecute: true }] };
  assert.doesNotThrow(() => assertCatalogShape(base, migration, true));
  for (const key of ["body", "securityDefiner", "authExecute", "searchPath", "returnType"]) {
    const state = structuredClone(base);
    state.functions[0][key] = key === "body" ? "changed" : key === "searchPath" || key === "returnType" ? "changed" : true;
    assert.throws(() => assertCatalogShape(state, migration, true), /definition or ACL/);
  }
  assert.throws(() => assertCatalogShape({ ...base, ledger: [] }, migration, true), /ledger/);
  assert.doesNotThrow(() => assertCatalogShape({ prerequisites: base.prerequisites, ledger: [], functions: [] }, migration, false));
});

test("unavailable advisory lock rolls back without commit", async () => {
  const calls = [];
  const client = { async query(sql) { calls.push(sql); return sql.includes("pg_try_advisory_xact_lock") ? { rows: [{ acquired: false }] } : { rows: [] }; } };
  await assert.rejects(runTransaction(client, migration, true, "fingerprint"), /lock unavailable/);
  assert.equal(calls.at(-1), "rollback");
  assert.ok(!calls.includes("commit"));
});
