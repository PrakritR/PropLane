/** Authenticated, bounded install and per-run verification. No local compilation. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { ARTIFACT_FORMAT, ARTIFACT_VERSION, QA_REPOSITORY, QA_KEEPER_REFS, QA_DEV_URL, QA_ORIGIN, encryptionKeyBytes } from './package-local-qa-build.mjs';
import { decryptArtifact, restoreRuntimeAliases } from './decrypt-local-qa-build.mjs';

const MAX_ENTRIES = 50001, MAX_EXPANDED = 1024 ** 3, MAX_RECEIPT = 16 * 1024 ** 2;
const RECEIPT_AAD = Buffer.from('proplane-installed-local-qa/v1');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function assert(ok, message = 'Authenticated local QA build refused.') { if (!ok) throw new Error(message); }
async function privatePath(value, directory) {
  const info = await lstat(value);
  assert(path.isAbsolute(value) && await realpath(value) === value && info.uid === process.getuid() && !info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile()) && (info.mode & 0o777) === (directory ? 0o700 : 0o600), 'Private artifact path refused.');
  return info;
}
function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 1024 * 1024 });
  assert(!result.error && result.status === 0, 'Worktree provenance unavailable.');
  return result.stdout.trim();
}
async function sourceIdentity(root, sha) {
  assert(path.isAbsolute(root) && await realpath(root) === root && /^[a-f0-9]{40}$/.test(sha) && git(root, ['rev-parse', 'HEAD']) === sha && git(root, ['status', '--porcelain', '--untracked-files=no']) === '', 'Clean exact source required.');
}
function safeEntry(name) {
  return name === 'qa-manifest.json' || (typeof name === 'string' && name.startsWith('.next/') && name.length <= 255 && !name.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.env')) && !/[\\\x00-\x1f\x7f]/.test(name) && !/^\.next\/(cache|dev|node_modules)(\/|$)/.test(name));
}
function octal(bytes) {
  const text = bytes.toString('ascii').replace(/\0.*$/, '').trim();
  assert(/^[0-7]+$/.test(text), 'Non-octal archive field refused.');
  const value = Number.parseInt(text, 8); assert(Number.isSafeInteger(value) && value >= 0); return value;
}
function tarString(bytes) {
  const end = bytes.indexOf(0); const value = bytes.subarray(0, end === -1 ? bytes.length : end);
  assert(!value.some((byte) => byte > 127), 'Non-ASCII archive path refused.'); return value.toString('ascii');
}
/** Accept only ustar regular files. No tar subprocess, extensions, links or directory entries. */
export async function extractQaArchive({ archive, destination, maxEntries = MAX_ENTRIES, maxExpanded = MAX_EXPANDED }) {
  assert(Number.isSafeInteger(maxEntries) && maxEntries > 0 && maxEntries <= MAX_ENTRIES && Number.isSafeInteger(maxExpanded) && maxExpanded > 0 && maxExpanded <= MAX_EXPANDED);
  await privatePath(destination, true); assert((await readdir(destination)).length === 0);
  const source = createReadStream(archive), gzip = createGunzip();
  source.on('error', (error) => gzip.destroy(error)); source.pipe(gzip);
  const seen = new Set(); let buffer = Buffer.alloc(0), expanded = 0, remaining = 0, padding = 0, ended = false, zeros = 0, file;
  try {
    for await (const chunk of gzip) {
      expanded += chunk.length; assert(expanded <= maxExpanded, 'Archive expansion bound exceeded.');
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (remaining) {
          const count = Math.min(remaining, buffer.length);
          await file.writeFile(buffer.subarray(0, count)); buffer = buffer.subarray(count); remaining -= count;
          if (!remaining) { await file.close(); file = undefined; }
          continue;
        }
        if (padding) { const count = Math.min(padding, buffer.length); assert(buffer.subarray(0, count).every((byte) => byte === 0)); buffer = buffer.subarray(count); padding -= count; continue; }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512); buffer = buffer.subarray(512);
        if (header.every((byte) => byte === 0)) { zeros++; if (zeros >= 2) ended = true; continue; }
        assert(!ended && zeros === 0 && seen.size < maxEntries, 'Archive tail/entry bound refused.');
        const expected = octal(header.subarray(148, 156));
        let sum = 0; for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index];
        assert(sum === expected && header.subarray(257, 263).toString('ascii') === 'ustar\0' && (header[156] === 0 || header[156] === 48), 'Only checksummed ustar regular files are accepted.');
        const prefix = tarString(header.subarray(345, 500)); const name = `${prefix ? `${prefix}/` : ''}${tarString(header.subarray(0, 100))}`;
        assert(safeEntry(name) && !seen.has(name), 'Unsafe or duplicate archive entry.'); seen.add(name);
        remaining = octal(header.subarray(124, 136)); padding = (512 - remaining % 512) % 512;
        assert(remaining <= MAX_EXPANDED && (name !== 'qa-manifest.json' || remaining <= MAX_RECEIPT), 'Archive entry size refused.');
        const target = path.join(destination, name); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        file = await open(target, 'wx', 0o600);
        if (!remaining) { await file.close(); file = undefined; }
      }
    }
    assert(ended && !remaining && !padding && buffer.every((byte) => byte === 0) && seen.has('qa-manifest.json'), 'Incomplete archive refused.');
    return seen;
  } finally { source.destroy(); gzip.destroy(); await file?.close(); }
}
async function fileDigest(file) {
  const info = await lstat(file); assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= MAX_EXPANDED);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); const hash = createHash('sha256'); let bytes = 0;
  try {
    const opened = await handle.stat(); assert(opened.ino === info.ino && opened.dev === info.dev && opened.size === info.size);
    for await (const chunk of handle.createReadStream({ autoClose: false })) { bytes += chunk.length; assert(bytes <= info.size); hash.update(chunk); }
    const after = await handle.stat(); assert(after.size === info.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs && bytes === info.size);
  } finally { await handle.close(); }
  return { bytes, sha256: hash.digest('hex') };
}
async function validateManifest(manifest, root, sha, env) {
  assert(manifest?.format === ARTIFACT_FORMAT && manifest.version === ARTIFACT_VERSION && manifest.purpose === 'local-dev-qa-only' && manifest.githubSha === sha && manifest.provenance?.repository === QA_REPOSITORY && QA_KEEPER_REFS.includes(manifest.provenance.ref) && /^[1-9]\d{0,19}$/.test(manifest.provenance.runId) && /^[1-9]\d{0,5}$/.test(manifest.provenance.attempt));
  assert(manifest.nodeMajor === 22 && process.versions.node.split('.')[0] === '22' && manifest.target?.supabaseUrl === QA_DEV_URL && manifest.target.origin === QA_ORIGIN && env.NEXT_PUBLIC_SUPABASE_URL === QA_DEV_URL && env.NEXT_PUBLIC_APP_URL === QA_ORIGIN && env.NEXT_PUBLIC_SUPABASE_ANON_KEY && manifest.target.anonKeySha256 === sha256(env.NEXT_PUBLIC_SUPABASE_ANON_KEY), 'Artifact runtime target refused.');
  const lockBytes = await readFile(path.join(root, 'package-lock.json')); const lock = JSON.parse(lockBytes);
  const localNext = JSON.parse(await readFile(path.join(root, 'node_modules/next/package.json'), 'utf8'));
  assert(manifest.lockfileSha256 === sha256(lockBytes) && typeof manifest.nextVersion === 'string' && manifest.nextVersion === localNext.version && localNext.name === 'next' && lock.packages?.['node_modules/next']?.version === manifest.nextVersion, 'Artifact dependency binding refused.');
  assert(Array.isArray(manifest.immutableFiles) && manifest.immutableFiles.length > 0 && manifest.immutableFiles.length <= MAX_ENTRIES - 1 && manifest.fileCount === manifest.immutableFiles.length && Array.isArray(manifest.runtimeAliases) && manifest.runtimeAliases.length <= 2);
  assert(JSON.stringify(manifest.excluded) === JSON.stringify(['.next/cache', '.next/dev', '.next/node_modules']) && manifest.runtime?.host === '127.0.0.1' && manifest.runtime.port === 3010 && manifest.runtime.maxOldSpaceSizeMiB === 512 && manifest.runtime.database === 'dev/test');
  let bytes = 0; const paths = new Set();
  for (const entry of manifest.immutableFiles) {
    assert(safeEntry(entry?.path) && entry.path !== 'qa-manifest.json' && !paths.has(entry.path) && /^[a-f0-9]{64}$/.test(entry.sha256) && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0);
    paths.add(entry.path); bytes += entry.bytes; assert(bytes <= MAX_EXPANDED);
  }
  assert(bytes === manifest.fileBytes && paths.has('.next/BUILD_ID') && paths.has('.next/required-server-files.json'));
}
async function verifyTree(root, manifest, allowAliases) {
  const expected = new Map(manifest.immutableFiles.map((entry) => [entry.path, entry]));
  const aliases = new Map();
  for (const alias of manifest.runtimeAliases) {
    assert(typeof alias?.path === 'string' && /^\.next\/node_modules\/(pg|sharp)-[a-f0-9]{16}$/.test(alias.path) && alias.path.split('/')[2].startsWith(`${alias.package}-`) && ['pg', 'sharp'].includes(alias.package) && alias.target === `../../node_modules/${alias.package}` && !aliases.has(alias.path)); aliases.set(alias.path, alias);
  }
  const expectedDirectories = new Set(['.next']);
  for (const name of [...expected.keys(), ...aliases.keys()]) {
    let parent = path.posix.dirname(name);
    while (parent !== '.') { expectedDirectories.add(parent); parent = path.posix.dirname(parent); }
  }
  const seen = new Set(); let count = 0;
  async function visit(relative) {
    assert(++count <= 100000);
    const target = path.join(root, relative), info = await lstat(target);
    if (allowAliases && aliases.has(relative)) {
      const alias = aliases.get(relative); assert(info.isSymbolicLink() && await readlink(target) === alias.target);
      const dependency = path.join(root, 'node_modules', alias.package); assert((await lstat(dependency)).isDirectory());
      const pkg = JSON.parse(await readFile(path.join(dependency, 'package.json'), 'utf8'));
      const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
      assert(pkg.name === alias.package && pkg.version === alias.version && lock.packages?.[`node_modules/${alias.package}`]?.version === alias.version); seen.add(relative); return;
    }
    assert(!info.isSymbolicLink() && (info.isDirectory() || info.isFile()), 'Installed build links or special files refused.');
    // Cache is runtime mutable, never part of the executable inventory. Still reject links/special files.
    if (relative === '.next/cache' || relative.startsWith('.next/cache/')) {
      if (info.isDirectory()) for (const name of await readdir(target)) await visit(`${relative}/${name}`);
      return;
    }
    if (info.isDirectory()) {
      assert(expectedDirectories.has(relative) || relative === '.next/node_modules' && allowAliases, 'Unexpected installed directory.');
      for (const name of await readdir(target)) await visit(`${relative}/${name}`);
      return;
    }
    const entry = expected.get(relative); assert(entry, 'Unexpected installed file.');
    const actual = await fileDigest(target); assert(actual.bytes === entry.bytes && actual.sha256 === entry.sha256, 'Installed immutable bytes changed.'); seen.add(relative);
  }
  await visit('.next');
  assert([...expected.keys()].every((key) => seen.has(key)) && (!allowAliases || [...aliases.keys()].every((key) => seen.has(key))), 'Installed inventory incomplete.');
}
export function authenticatedGithubSource(manifest, artifactId, run = spawnSync) {
  function api(endpoint) {
    const result = run('gh', ['api', `repos/${QA_REPOSITORY}/${endpoint}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 1024 * 1024 });
    assert(!result.error && result.status === 0, 'Authenticated artifact provenance unavailable.'); return JSON.parse(result.stdout);
  }
  assert(/^[1-9]\d{0,19}$/.test(artifactId));
  const p = manifest.provenance, runInfo = api(`actions/runs/${p.runId}/attempts/${p.attempt}`);
  assert(String(runInfo.id) === p.runId && String(runInfo.run_attempt) === p.attempt && runInfo.repository?.full_name === QA_REPOSITORY && runInfo.head_sha === manifest.githubSha && `refs/heads/${runInfo.head_branch}` === p.ref && runInfo.path === '.github/workflows/test.yml' && runInfo.event === 'workflow_dispatch' && runInfo.status === 'completed' && runInfo.conclusion === 'success', 'Completed exact source run required.');
  const artifact = api(`actions/artifacts/${artifactId}`);
  assert(String(artifact.id) === artifactId && artifact.expired === false && artifact.name === `local-qa-build-${manifest.githubSha}` && String(artifact.workflow_run?.id) === p.runId && artifact.workflow_run?.head_sha === manifest.githubSha, 'Exact source artifact required.');
  return { artifactId, runId: p.runId, attempt: p.attempt };
}
function seal(receipt, key) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKeyBytes(key), nonce); cipher.setAAD(RECEIPT_AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(receipt)), cipher.final()]);
  return JSON.stringify({ format: 'proplane-installed-local-qa', version: 1, nonce: nonce.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('base64') });
}
function unseal(raw, key) {
  assert(raw.length <= MAX_RECEIPT); const envelope = JSON.parse(raw);
  assert(envelope?.format === 'proplane-installed-local-qa' && envelope.version === 1 && /^[a-f0-9]{24}$/.test(envelope.nonce) && /^[a-f0-9]{32}$/.test(envelope.tag) && typeof envelope.ciphertext === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext));
  const decipher = createDecipheriv('aes-256-gcm', encryptionKeyBytes(key), Buffer.from(envelope.nonce, 'hex')); decipher.setAAD(RECEIPT_AAD); decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]));
}
export async function verifyInstalledQaBuild({ root, receiptPath, encryptionKey, env = process.env }) {
  await privatePath(path.dirname(receiptPath), true); const info = await privatePath(receiptPath, false); assert(info.size <= MAX_RECEIPT);
  const receipt = unseal(await readFile(receiptPath), encryptionKey);
  assert(receipt.root === root && /^[a-f0-9]{64}$/.test(receipt.ciphertextSha256) && /^[1-9]\d{0,19}$/.test(receipt.source?.artifactId));
  const manifest = receipt.manifest;
  assert(receipt.source.runId === manifest?.provenance?.runId && receipt.source.attempt === manifest?.provenance?.attempt);
  await sourceIdentity(root, manifest.githubSha); await validateManifest(manifest, root, manifest.githubSha, env); await verifyTree(root, manifest, true);
  return { sha: manifest.githubSha, origin: QA_ORIGIN, runId: manifest.provenance.runId, artifactId: receipt.source.artifactId };
}
export async function installQaBuild({ root, artifactDir, artifactId, sha, encryptionKey, receiptDirectory, env = process.env }, dependencies = {}) {
  await sourceIdentity(root, sha); await privatePath(path.dirname(receiptDirectory), true);
  await mkdir(receiptDirectory, { mode: 0o700 }); await privatePath(receiptDirectory, true);
  // One exclusive root-owned installation; never overwrite another .next or receipt directory.
  const lock = path.join(root, '.qa-build-install.lock'); await mkdir(lock, { mode: 0o700 });
  let stage, published = false, nextClaim;
  try {
    try { await lstat(path.join(root, '.next')); throw new Error('Existing build refuses installation.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    stage = await mkdtemp(path.join(receiptDirectory, 'staging-'));
    const archive = path.join(receiptDirectory, 'authenticated.tar.gz');
    await decryptArtifact({ artifactDir, sha, encryptionKey, output: archive });
    await extractQaArchive({ archive, destination: stage });
    const manifest = JSON.parse(await readFile(path.join(stage, 'qa-manifest.json'), 'utf8'));
    await validateManifest(manifest, root, sha, env);
    const source = await (dependencies.authenticateSource ?? authenticatedGithubSource)(manifest, artifactId);
    await verifyTree(stage, manifest, false); await sourceIdentity(root, sha);
    await mkdir(path.join(root, '.next'), { mode: 0o700 }); nextClaim = await lstat(path.join(root, '.next'));
    const current = await lstat(path.join(root, '.next')); assert(current.ino === nextClaim.ino && current.dev === nextClaim.dev && (await readdir(path.join(root, '.next'))).length === 0);
    await rename(path.join(stage, '.next'), path.join(root, '.next')); published = true;
    await restoreRuntimeAliases({ root, privateManifest: manifest }); await verifyTree(root, manifest, true);
    const envelope = JSON.parse(await readFile(path.join(artifactDir, 'manifest.json'), 'utf8'));
    const receiptPath = path.join(receiptDirectory, 'installed-build.json'); const handle = await open(receiptPath, 'wx', 0o600);
    try { await handle.writeFile(seal({ root, source, ciphertextSha256: envelope.ciphertextSha256, manifest }, encryptionKey)); await handle.sync(); } finally { await handle.close(); }
    const parent = await open(receiptDirectory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
    await verifyInstalledQaBuild({ root, receiptPath, encryptionKey, env });
    await rm(archive); await rm(stage, { recursive: true }); stage = undefined;
    return receiptPath;
  } catch {
    // Preserve failed staging/provenance privately. Published build remains refused without a valid receipt.
    throw new Error(published ? 'QA installation pending; preserve private receipt directory and task-owned build.' : 'QA installation refused; preserve private staging for diagnosis.');
  } finally { await rm(lock, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [artifactDir, artifactId, sha, receiptDirectory] = process.argv.slice(2);
    assert(process.argv.length === 6 && process.env.QA_ARTIFACT_ENCRYPTION_KEY_FILE, 'Use install-local-qa-build.mjs <artifact-dir> <artifact-id> <sha> <new-private-receipt-directory> with a private artifact key file.');
    const keyPath = process.env.QA_ARTIFACT_ENCRYPTION_KEY_FILE; await privatePath(path.dirname(keyPath), true); await privatePath(keyPath, false);
    const receiptPath = await installQaBuild({ root: await realpath(process.cwd()), artifactDir, artifactId, sha, receiptDirectory, encryptionKey: (await readFile(keyPath, 'utf8')).trim() });
    console.log(`Authenticated local QA receipt: ${receiptPath}`);
  } catch { console.error('Authenticated local QA install refused. No credentials or archive contents are logged.'); process.exitCode = 1; }
}
