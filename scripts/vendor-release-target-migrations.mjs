#!/usr/bin/env node
/** Separately reviewed staging/production vendor operation. Read-only by default. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const TARGETS = Object.freeze({ staging: 'xwszcafaontidfgznlxd', production: 'qahnczmilgptcedaqype' });
const SOURCE_PINS = Object.freeze({
  './vendor-release-migrations.mjs': 'b9b37fcb8544bffbfc30927e71488c8b1535de27f07c99af65bbbad4d597488d',
  './sms-durability-release-migrations.mjs': '12cdfd6515530204ef753cc9f24e8c356425ecee900bfe7ef4c525c88cf952bd',
});
const hash = value => createHash('sha256').update(value).digest('hex');

export function parseTargetOptions(argv) {
  const options = { phase: 'preflight' };
  const names = { '--target': 'target', '--confirm-ref': 'confirmRef', '--phase': 'phase', '--expected-state': 'expectedState', '--backup-file': 'backupFile', '--expected-candidate': 'candidate' };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!Object.hasOwn(names, flag) || seen.has(flag) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Unknown, duplicate or missing target operation option');
    seen.add(flag); options[names[flag]] = argv[++index];
  }
  if (!Object.hasOwn(TARGETS, options.target ?? '') || options.confirmRef !== TARGETS[options.target] ||
      !['preflight', 'apply', 'postflight'].includes(options.phase) || !/^[a-f0-9]{40}$/.test(options.candidate ?? '')) throw new Error('Exact staging|production target, confirm-ref and expected-candidate required');
  if (options.phase === 'apply') {
    if (!/^[a-f0-9]{64}$/.test(options.expectedState ?? '') || !options.backupFile ||
        !resolve(options.backupFile).startsWith('/private/tmp/') || realpathSync(dirname(resolve(options.backupFile))) !== '/private/tmp') throw new Error('Apply requires expected-state and an exclusive backup directly beneath /private/tmp');
  } else if (options.expectedState || options.backupFile) throw new Error('Apply-only option in read-only phase');
  return options;
}

export function assertReviewedTargetSources() {
  for (const [path, expected] of Object.entries(SOURCE_PINS)) {
    if (hash(readFileSync(new URL(path, import.meta.url))) !== expected) throw new Error(`Reviewed shared operation changed: ${path}`);
  }
}

export function bindTargetState(options, state) {
  return hash(JSON.stringify({ target: options.target, project: TARGETS[options.target], candidate: options.candidate, sharedSourcePins: SOURCE_PINS, schemaDigest: state.digest }));
}

function assertCandidate(options) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (head !== options.candidate) throw new Error('Release candidate HEAD changed');
  if (options.phase === 'apply') {
    execFileSync('git', ['cat-file', '-e', `${head}:scripts/vendor-release-target-migrations.mjs`], { stdio: 'ignore' });
    execFileSync('git', ['diff', '--quiet', head], { stdio: 'ignore' });
  }
}

async function main() {
  const options = parseTargetOptions(process.argv.slice(2));
  assertReviewedTargetSources(); assertCandidate(options);
  const { reviewedVendorMigrations, assertVendorLedger, snapshotVendorRelease, postflightVendorRelease, readOnlyVendorRelease } = await import('./vendor-release-migrations.mjs');
  const { credential, connect, backup } = await import('./sms-durability-release-migrations.mjs');
  const migrations = reviewedVendorMigrations(); // All 15 SQL pins are verified before credential access.
  const project = TARGETS[options.target];
  const bindState = state => bindTargetState(options, state);
  const config = credential(project);
  let db = await connect(config);
  try {
    const state = await readOnlyVendorRelease(db, () => options.phase === 'postflight' ? postflightVendorRelease(db, migrations) : snapshotVendorRelease(db, migrations));
    if (options.phase !== 'apply') {
      console.log(JSON.stringify({ target: options.target, project, phase: options.phase, candidate: options.candidate, stateDigest: bindState(state), schemaDigest: state.digest,
        existing: state.ledger.map(({ version, name, statements }) => ({ version, name, statementsSha256: hash(JSON.stringify(statements)) })),
        missing: assertVendorLedger(state.ledger, migrations).map(({ version, name, hash }) => ({ version, name, hash })) }));
      return;
    }
    if (bindState(state) !== options.expectedState) throw new Error('Target preflight state changed');
    backup(config, options.backupFile);
    if (!statSync(options.backupFile).size || (statSync(options.backupFile).mode & 0o077) !== 0) throw new Error('Backup is empty or not private');
    await db.query('begin'); let commitAttempted = false;
    try {
      await db.query('set local role postgres');
      await db.query("set local lock_timeout='3s'"); await db.query("set local statement_timeout='60s'");
      if (!(await db.query('select pg_try_advisory_xact_lock(20261104120000::bigint) acquired')).rows[0].acquired) throw new Error('Release migration lock unavailable');
      assertCandidate(options);
      const locked = await snapshotVendorRelease(db, migrations);
      if (bindState(locked) !== options.expectedState) throw new Error('Locked target preflight state changed');
      for (const migration of assertVendorLedger(locked.ledger, migrations)) {
        await db.query(migration.sql);
        await db.query('insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)', [migration.version, migration.name, [migration.sql]]);
      }
      await postflightVendorRelease(db, migrations);
      commitAttempted = true; await db.query('commit');
    } catch (error) {
      if (!commitAttempted) await db.query('rollback').catch(() => undefined);
      throw error;
    }
    await db.end(); db = await connect(config);
    const verified = await readOnlyVendorRelease(db, () => postflightVendorRelease(db, migrations));
    console.log(JSON.stringify({ target: options.target, project, phase: 'apply', candidate: options.candidate, outcome: 'committed_and_verified', backupFile: options.backupFile, stateDigest: bindState(verified), schemaDigest: verified.digest }));
  } finally { await db.end().catch(() => undefined); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Target vendor operation failed; reconcile before retry: ${error instanceof Error ? error.message : 'unknown'}`); process.exitCode = 1; });
}
