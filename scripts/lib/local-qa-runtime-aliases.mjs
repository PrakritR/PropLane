/** Closed Next runtime-alias contract. Never infer permissions from emitted paths. */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

export const RUNTIME_ALIAS_SPECS = Object.freeze([
  Object.freeze({ package: 'pg', pattern: /^\.next\/node_modules\/pg-[a-f0-9]{16}$(?![\s\S])/, target: '../../node_modules/pg', parents: Object.freeze(['.next', '.next/node_modules']), dependencyParents: Object.freeze(['node_modules', 'node_modules/pg']), diagnostic: 'PG' }),
  Object.freeze({ package: 'sharp', pattern: /^\.next\/node_modules\/sharp-[a-f0-9]{16}$(?![\s\S])/, target: '../../node_modules/sharp', parents: Object.freeze(['.next', '.next/node_modules']), dependencyParents: Object.freeze(['node_modules', 'node_modules/sharp']), diagnostic: 'SHARP' }),
  Object.freeze({ package: '@napi-rs/canvas', pattern: /^\.next\/node_modules\/@napi-rs\/canvas-[a-f0-9]{16}$(?![\s\S])/, target: '../../../node_modules/@napi-rs/canvas', parents: Object.freeze(['.next', '.next/node_modules', '.next/node_modules/@napi-rs']), dependencyParents: Object.freeze(['node_modules', 'node_modules/@napi-rs', 'node_modules/@napi-rs/canvas']), diagnostic: 'NAPI_CANVAS' }),
]);
export const MAX_RUNTIME_ALIASES = RUNTIME_ALIAS_SPECS.length;
export class RuntimeAliasRefusal extends Error {
  constructor(reason, errno) { super('QA runtime alias refused.'); this.reason = reason; this.code = errno; }
}
const refuse = (reason, error) => new RuntimeAliasRefusal(reason, error?.code);
export function runtimeAliasSpec(packageName) { return RUNTIME_ALIAS_SPECS.find((spec) => spec.package === packageName); }
export function validateRuntimeAliases(records) {
  if (!Array.isArray(records) || records.length > MAX_RUNTIME_ALIASES) throw refuse('ALIAS_COUNT');
  const packages = new Set(), paths = new Set();
  return Array.from(records, (record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record) || Reflect.ownKeys(record).length !== 4 ||
        !['package', 'path', 'target', 'version'].every((key) => Object.hasOwn(record, key))) throw refuse('ALIAS_NAME');
    const spec = runtimeAliasSpec(record.package);
    if (!spec || typeof record.path !== 'string' || !spec.pattern.test(record.path)) throw refuse('ALIAS_NAME');
    if (record.target !== spec.target) throw refuse('ALIAS_TARGET');
    if (typeof record.version !== 'string' || !record.version.length || record.version.length > 100) throw refuse('ALIAS_PACKAGE_VERSION');
    if (packages.has(record.package) || paths.has(record.path)) throw refuse('ALIAS_DUPLICATE');
    packages.add(record.package); paths.add(record.path);
    return { package: record.package, path: record.path, target: record.target, version: record.version };
  });
}
export async function realAliasDirectory(directory) {
  let info;
  try { info = await lstat(directory); } catch (error) { throw refuse('STAT', error); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw refuse('ALIAS_DIRECTORY_TYPE');
  return info;
}
async function metadata(file, reason) {
  let handle;
  try {
    const before = await lstat(file);
    if (!before.isFile() || before.nlink !== 1 || before.size > 64 * 1024 ** 2) throw new Error();
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error();
    const bytes = await handle.readFile();
    const after = await handle.stat(), current = await lstat(file);
    if (bytes.length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || current.ino !== opened.ino || current.dev !== opened.dev || current.isSymbolicLink() || current.nlink !== 1) throw new Error();
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) { throw refuse(reason, error); } finally { await handle?.close(); }
}
/** Parents may be absent during install/restore preflight; existing parents must be real. */
export async function bindRuntimeAlias({ root, alias, allowMissingAliasParents = false }) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw refuse('ALIAS_TARGET');
  const spec = runtimeAliasSpec(alias?.package);
  if (!spec || typeof alias.path !== 'string' || !spec.pattern.test(alias.path) || alias.target !== spec.target) throw refuse('ALIAS_NAME');
  const parents = [];
  for (const relative of spec.parents) {
    const directory = path.join(root, relative);
    try { parents.push([directory, await realAliasDirectory(directory)]); } catch (error) {
      if (!(allowMissingAliasParents && error.code === 'ENOENT')) throw error;
    }
  }
  for (const relative of spec.dependencyParents) parents.push([path.join(root, relative), await realAliasDirectory(path.join(root, relative))]);
  const dependency = path.join(root, ...spec.dependencyParents.at(-1).split('/'));
  if (path.resolve(path.dirname(path.join(root, alias.path)), alias.target) !== dependency) throw refuse('ALIAS_TARGET');
  const pkg = await metadata(path.join(dependency, 'package.json'), 'PACKAGE_READ');
  const lock = await metadata(path.join(root, 'package-lock.json'), 'LOCK_READ');
  if (pkg?.name !== spec.package) throw refuse('ALIAS_PACKAGE_NAME');
  if (typeof pkg.version !== 'string' || !pkg.version.length || pkg.version.length > 100 || pkg.version !== lock?.packages?.[`node_modules/${spec.package}`]?.version || (alias.version !== undefined && alias.version !== pkg.version)) throw refuse('ALIAS_PACKAGE_VERSION');
  for (const [directory, before] of parents) {
    const after = await realAliasDirectory(directory);
    if (after.ino !== before.ino || after.dev !== before.dev) throw refuse('ALIAS_DIRECTORY_TYPE');
  }
  return pkg.version;
}
