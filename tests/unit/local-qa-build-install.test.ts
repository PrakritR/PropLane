import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink, readlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { packageBuild, KEEPER_REF } from '../../scripts/package-local-qa-build.mjs';
import { authenticatedGithubSource, extractQaArchive, installQaBuild, verifyInstalledQaBuild } from '../../scripts/install-local-qa-build.mjs';

const gitState = vi.hoisted(() => ({ sha: 'a'.repeat(40), dirty: '' }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn((command: string, args: string[], options: object) => command === 'git'
    ? { status: 0, stdout: args.includes('rev-parse') ? `${gitState.sha}\n` : gitState.dirty }
    : actual.spawnSync(command, args, options)) };
});
const SHA = 'a'.repeat(40), KEY = 'ab'.repeat(32), roots: string[] = [];
const context = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: KEEPER_REF, GITHUB_SHA: SHA, GITHUB_REPOSITORY: 'PrakritR/PropLane', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', NEXT_PUBLIC_SUPABASE_URL: 'https://emstjswhotsnyksqhqyf.supabase.co', NEXT_PUBLIC_APP_URL: 'http://localhost:3010', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-fixture-anon' };
afterEach(async () => { gitState.sha = SHA; gitState.dirty = ''; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function privateRoot() { const root = await realpath(await mkdtemp(path.join(tmpdir(), 'qa-install-'))); roots.push(root); return root; }
async function input(aliases = false) {
  const root = await privateRoot();
  await mkdir(path.join(root, '.next/server'), { recursive: true });
  await writeFile(path.join(root, '.next/BUILD_ID'), 'build-id'); await writeFile(path.join(root, '.next/required-server-files.json'), '{}');
  await writeFile(path.join(root, '.next/server/page.js'), 'module.exports = "clean"');
  await mkdir(path.join(root, 'node_modules/next'), { recursive: true });
  await writeFile(path.join(root, 'node_modules/next/package.json'), JSON.stringify({ name: 'next', version: '16.0.0' }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/next': { version: '16.0.0' } } }));
  if (aliases) {
    const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
    for (const packageName of ['pg', 'sharp', '@napi-rs/canvas']) {
      const alias = path.join(root, `.next/node_modules/${packageName}-0123456789abcdef`);
      await mkdir(path.dirname(alias), { recursive: true });
      await mkdir(path.join(root, 'node_modules', packageName), { recursive: true });
      await writeFile(path.join(root, 'node_modules', packageName, 'package.json'), JSON.stringify({ name: packageName, version: '1.0.9' }));
      lock.packages[`node_modules/${packageName}`] = { version: '1.0.9' };
      await symlink(packageName.startsWith('@') ? `../../../node_modules/${packageName}` : `../../node_modules/${packageName}`, alias);
    }
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  }
  const artifactDir = path.join(root, 'ciphertext');
  await packageBuild({ root, output: artifactDir, sha: SHA, context, secrets: [Buffer.from('server-secret-test')], encryptionKey: KEY });
  await rm(path.join(root, '.next'), { recursive: true });
  return { root, artifactDir, artifactId: '456', sha: SHA, encryptionKey: KEY, receiptDirectory: path.join(root, 'private-receipt'), env: context };
}
function authenticateSource(manifest: { provenance: { runId: string; attempt: string } }, artifactId: string) { return { artifactId, ...manifest.provenance }; }
async function install(aliases = false) { const args = await input(aliases); const receiptPath = await installQaBuild(args, { authenticateSource }); return { args, receiptPath }; }

describe('authenticated installed build', () => {
  it('installs only authenticated immutable bytes and validates its sealed receipt per run', async () => {
    const { args, receiptPath } = await install();
    expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toMatchObject({ format: 'proplane-installed-local-qa', version: 1 });
    expect(await readFile(receiptPath, 'utf8')).not.toContain('page.js');
    await expect(verifyInstalledQaBuild({ ...args, receiptPath })).resolves.toMatchObject({ sha: SHA, artifactId: '456', runId: '123', origin: context.NEXT_PUBLIC_APP_URL });
    await mkdir(path.join(args.root, '.next/cache'), { mode: 0o700 }); await writeFile(path.join(args.root, '.next/cache/runtime-cache'), 'mutable');
    await expect(verifyInstalledQaBuild({ ...args, receiptPath })).resolves.toMatchObject({ sha: SHA });
  });
  it('installs and receipt-verifies all three aliases through authenticated safe extraction', async () => {
    const { args, receiptPath } = await install(true);
    for (const packageName of ['pg', 'sharp', '@napi-rs/canvas']) {
      expect(await readlink(path.join(args.root, `.next/node_modules/${packageName}-0123456789abcdef`))).toBe(packageName.startsWith('@') ? `../../../node_modules/${packageName}` : `../../node_modules/${packageName}`);
    }
    await expect(verifyInstalledQaBuild({ ...args, receiptPath })).resolves.toMatchObject({ sha: SHA });
  });
  it.each(['target', 'missing', 'package-version', 'lock-version', 'sibling', 'empty-scope', 'scope-parent', 'dependency-scope', 'alias-root', 'metadata-link', 'metadata-hardlink'])('refuses installed canvas tampering: %s', async (kind) => {
    const { args, receiptPath } = await install(true);
    const scope = path.join(args.root, '.next/node_modules/@napi-rs'), alias = path.join(scope, 'canvas-0123456789abcdef');
    const pkg = path.join(args.root, 'node_modules/@napi-rs/canvas/package.json');
    if (kind === 'target' || kind === 'missing') await rm(alias);
    if (kind === 'target') await symlink('../../../node_modules/@napi-rs/./canvas', alias);
    if (kind === 'package-version') await writeFile(pkg, JSON.stringify({ name: '@napi-rs/canvas', version: 'different' }));
    if (kind === 'lock-version') await writeFile(path.join(args.root, 'package-lock.json'), '{}');
    if (kind === 'sibling') await writeFile(path.join(scope, 'unknown'), 'data');
    if (kind === 'empty-scope') await mkdir(path.join(args.root, '.next/node_modules/@unknown'));
    if (kind === 'metadata-link') { await rename(pkg, pkg + '-real'); await symlink(pkg + '-real', pkg); }
    if (kind === 'metadata-hardlink') { const { link } = await import('node:fs/promises'); await link(pkg, pkg + '-other'); }
    const parents: Record<string, string> = { 'scope-parent': scope, 'dependency-scope': path.join(args.root, 'node_modules/@napi-rs'), 'alias-root': path.dirname(scope) };
    if (parents[kind]) { await rename(parents[kind], parents[kind] + '-real'); await symlink(parents[kind] + '-real', parents[kind]); }
    await expect(verifyInstalledQaBuild({ ...args, receiptPath })).rejects.toThrow();
  });
  it('refuses changed alias dependencies before publishing any build', async () => {
    const args = await input(true);
    await writeFile(path.join(args.root, 'node_modules/@napi-rs/canvas/package.json'), JSON.stringify({ name: '@napi-rs/canvas', version: 'different' }));
    await expect(installQaBuild(args, { authenticateSource })).rejects.toThrow('refused');
    await expect(readFile(path.join(args.root, '.next/BUILD_ID'))).rejects.toThrow();
  });
  it.each(['wrong-key', 'forged-receipt', 'changed-bytes', 'extra-file', 'dirty-source', 'wrong-head', 'lockfile', 'origin', 'dev-url', 'anon-key', 'native-version'])('refuses %s before prebuilt execution', async (kind) => {
    const { args, receiptPath } = await install();
    if (kind === 'wrong-key') args.encryptionKey = 'cd'.repeat(32);
    if (kind === 'forged-receipt') await writeFile(receiptPath, JSON.stringify({ root: args.root, githubSha: SHA, verified: true }));
    if (kind === 'changed-bytes') await writeFile(path.join(args.root, '.next/server/page.js'), 'changed');
    if (kind === 'extra-file') await writeFile(path.join(args.root, '.next/server/extra.js'), 'extra');
    if (kind === 'dirty-source') gitState.dirty = ' M tracked-source.ts\n';
    if (kind === 'wrong-head') gitState.sha = 'b'.repeat(40);
    if (kind === 'lockfile') await writeFile(path.join(args.root, 'package-lock.json'), '{}');
    if (kind === 'native-version') await writeFile(path.join(args.root, 'node_modules/next/package.json'), JSON.stringify({ name: 'next', version: 'different' }));
    const env = { ...args.env };
    if (kind === 'origin') env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    if (kind === 'dev-url') env.NEXT_PUBLIC_SUPABASE_URL = 'https://wrong.invalid';
    if (kind === 'anon-key') env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'wrong-public-key';
    await expect(verifyInstalledQaBuild({ ...args, env, receiptPath })).rejects.toThrow();
  });
  it('refuses an existing build and never overwrites it', async () => {
    const args = await input(); await mkdir(path.join(args.root, '.next')); await writeFile(path.join(args.root, '.next/other-task'), 'keep');
    await expect(installQaBuild(args, { authenticateSource })).rejects.toThrow();
    expect(await readFile(path.join(args.root, '.next/other-task'), 'utf8')).toBe('keep');
  });
  it('refuses wrong source-run provenance before publishing the extracted build', async () => {
    const args = await input();
    await expect(installQaBuild(args, { authenticateSource: async () => { throw new Error('wrong source'); } })).rejects.toThrow('refused');
    await expect(readFile(path.join(args.root, '.next/BUILD_ID'))).rejects.toThrow();
  });
});

function tar(entries: { name: string; type?: string; body?: string }[]) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512), body = Buffer.from(entry.body ?? 'data');
    header.write(entry.name, 0, 100, 'ascii'); header.write('0000600\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124); header.write('00000000000\0', 136); header.fill(32, 148, 156);
    header.write(entry.type ?? '0', 156); header.write('ustar\0', 257); header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0); header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
async function extraction(entries: { name: string; type?: string; body?: string }[], limits = {}) {
  const root = await privateRoot(), archive = path.join(root, 'archive.gz'), destination = path.join(root, 'stage');
  await mkdir(destination, { mode: 0o700 }); await writeFile(archive, gzipSync(tar(entries)));
  return { archive, destination, ...limits };
}
describe('closed ustar extraction', () => {
  it('extracts ordinary files under a new private directory', async () => {
    const args = await extraction([{ name: '.next/BUILD_ID' }, { name: 'qa-manifest.json', body: '{}' }]);
    await expect(extractQaArchive(args)).resolves.toEqual(new Set(['.next/BUILD_ID', 'qa-manifest.json']));
    expect(await readFile(path.join(args.destination, '.next/BUILD_ID'), 'utf8')).toBe('data');
  });
  it.each([
    [{ name: '/absolute' }], [{ name: '.next/../outside' }], [{ name: '.next/a', type: '2' }], [{ name: '.next/a', type: '1' }],
    [{ name: '.next/a', type: '5' }], [{ name: '.next/a', type: 'x' }], [{ name: '.next/a', type: 'g' }],
    [{ name: '.next/a' }, { name: '.next/a' }], [{ name: '.next/cache/hidden' }], [{ name: '.next/node_modules/alias' }], [{ name: '.next/node_modules', type: '5' }], [{ name: '.next/node_modules/@napi-rs', type: '5' }], [{ name: 'unexpected' }],
  ])('refuses unsafe/link/special/duplicate/extension paths: %j', async (...entries) => {
    const args = await extraction(entries); await expect(extractQaArchive(args)).rejects.toThrow();
  });
  it('enforces entry/expanded bounds and complete footer', async () => {
    const entries = [{ name: '.next/a' }, { name: 'qa-manifest.json', body: '{}' }];
    await expect(extractQaArchive(await extraction(entries, { maxEntries: 1 }))).rejects.toThrow();
    await expect(extractQaArchive(await extraction(entries, { maxExpanded: 512 }))).rejects.toThrow();
    const args = await extraction(entries); await writeFile(args.archive, gzipSync(tar(entries).subarray(0, -1024)));
    await expect(extractQaArchive(args)).rejects.toThrow('Incomplete');
  });
  it('rejects a corrupt tar header even when gzip is valid', async () => {
    const args = await extraction([{ name: 'qa-manifest.json', body: '{}' }]); const bytes = tar([{ name: 'qa-manifest.json', body: '{}' }]); bytes[0] ^= 1; await writeFile(args.archive, gzipSync(bytes));
    await expect(extractQaArchive(args)).rejects.toThrow();
  });
});

describe('authenticated GitHub source binding', () => {
  const manifest = { githubSha: SHA, provenance: { repository: 'PrakritR/PropLane', ref: KEEPER_REF, runId: '123', attempt: '2' } };
  const runInfo = { id: 123, run_attempt: 2, repository: { full_name: 'PrakritR/PropLane' }, head_sha: SHA, head_branch: KEEPER_REF.slice(11), path: '.github/workflows/test.yml', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
  const artifact = { id: 456, expired: false, name: `local-qa-build-${SHA}`, workflow_run: { id: 123, head_sha: SHA } };
  it('requires exact completed successful source attempt and artifact', () => {
    const run = vi.fn((_command: string, args: string[], _options: object) => { void _command; void _options; return { status: 0, stdout: JSON.stringify(args[1].includes('/attempts/') ? runInfo : artifact) }; });
    expect(authenticatedGithubSource(manifest, '456', run)).toEqual({ artifactId: '456', runId: '123', attempt: '2' });
    expect(run.mock.calls[0][1]).toEqual(['api', 'repos/PrakritR/PropLane/actions/runs/123/attempts/2']);
  });
  it.each([{ status: 'in_progress' }, { run_attempt: 1 }, { head_sha: 'b'.repeat(40) }, { head_branch: 'main' }, { event: 'pull_request' }, { conclusion: 'failure' }, { path: '.github/workflows/other.yml' }])('rejects source drift: %j', (override) => {
    expect(() => authenticatedGithubSource(manifest, '456', () => ({ status: 0, stdout: JSON.stringify({ ...runInfo, ...override }) }))).toThrow();
  });
});

describe('signup runner prebuilt contract', () => {
  it('preserves the owned runner and verifies provenance before skipping compilation', async () => {
    const wrapper = await readFile('tests/e2e/support/signup-proof-server.mjs', 'utf8');
    const runner = await readFile('scripts/run-signup-proof-e2e.mjs', 'utf8');
    expect(wrapper).toContain('await verifyInstalledQaBuild(');
    expect(wrapper).toContain('"--max-old-space-size=512", "--import"');
    expect(wrapper).toContain('delete env.QA_ARTIFACT_ENCRYPTION_KEY_FILE');
    expect(wrapper).toContain('delete env.SIGNUP_PROOF_PREBUILT_RECEIPT');
    expect(wrapper).toContain('await preflightSignupCleanup()');
    expect(wrapper).toContain('await stopOwnedChild(child)');
    expect(wrapper).toContain('"server-stopped.json"');
    expect(runner).toContain("testArgs.indexOf('--prebuilt')");
    expect(runner).toContain('process.env.PLAYWRIGHT_SKIP_WEBSERVER');
    expect(runner).toContain('await finishOwnedProof(child');
    expect(runner).toContain('scripts/finalize-signup-proof.ts');
    expect(runner).toContain('scripts/package-signup-proof-recovery.ts');
  });
});
