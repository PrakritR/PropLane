import { RUNTIME_ALIAS_SPECS, MAX_RUNTIME_ALIASES, bindRuntimeAlias } from "./lib/local-qa-runtime-aliases.mjs";
import { decodeArtifactKey } from "./lib/qa-artifact-key.mjs";
/** Encrypted, SHA-bound local QA transport. This never deploys or loads runtime env files. */
import { constants, createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { pathToFileURL } from "node:url";

export const KEEPER_REF = "refs/heads/akhil/test-workspace-release-20260919";
export const QA_KEEPER_REFS = Object.freeze([KEEPER_REF, "refs/heads/agent/assistant-chrome-polish"]);
export const QA_REPOSITORY = "PrakritR/PropLane";
export const QA_DEV_URL = "https://emstjswhotsnyksqhqyf.supabase.co";
export const QA_ORIGIN = "http://localhost:3010";
export const ARTIFACT_FORMAT = "proplane-local-qa-build";
export const ARTIFACT_VERSION = 1;
export const ENCRYPTED_ARCHIVE_NAME = "next-build.tar.gz.enc";
export const ENVELOPE_NAME = "manifest.json";
const PRIVATE_MANIFEST_NAME = "qa-manifest.json";
export const ENCRYPTION_KEY_HEX_LENGTH = 64;
const NONCE_BYTES = 12;
const MAX_ENVELOPE_BYTES = 4096;
export const MAX_BYTES = 4 * 1024 ** 3;
export const MAX_ARCHIVE = 500 * 1024 ** 2;
export const MAX_FILES = 50000;
export const MAX_ENTRIES = MAX_FILES + 1;
const REFUSAL_CODES = new Set([
  "CONTEXT", "KEY_CONFIG", "PACKAGE_CONFIG", "SOURCE", "INVENTORY", "MARKERS",
  "SCANNER", "ARCHIVE", "OUTPUT", "ENCRYPTION", "UNEXPECTED",
]);

export const INVENTORY_DETAILS = Object.freeze([
  "ENTRY_LIMIT", "WALK_PATH_LIMIT", "FILE_LIMIT", "PATH_NON_ASCII", "PATH_USTAR_LENGTH",
  "PATH_USTAR_SPLIT", "PATH_INVALID_COMPONENT", "PATH_ENV_COMPONENT", "PATH_SECRET", "SYMLINK", "HARDLINK",
  "SPECIAL_FILE", "ALIAS_DIRECTORY_TYPE", "ALIAS_NAME", "ALIAS_DUPLICATE", "ALIAS_COUNT",
  "ALIAS_NOT_SYMLINK", "ALIAS_TARGET", "ALIAS_PACKAGE_TYPE", "ALIAS_PACKAGE_NAME",
  "ALIAS_PACKAGE_VERSION", "STAT", "READDIR", "READLINK", "PACKAGE_READ", "LOCK_READ",
]);
export const ARCHIVE_DETAILS = Object.freeze([
  "SOURCE_BYTES", "TAR_BYTES", "GZIP_BYTES", "TAR_SPAWN", "TAR_EXIT", "TAR_SIGNAL", "STREAM",
]);
const ARCHIVE_SIGNALS = ["SIGABRT", "SIGALRM", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGKILL", "SIGPIPE", "SIGQUIT", "SIGSEGV", "SIGTERM", "SIGUSR1", "SIGUSR2", "SIGXCPU", "SIGXFSZ"];
const boundedInteger = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max ? value : "UNKNOWN";
const diagnosticRecords = new WeakMap();
const enumValue = (value, allowed) => allowed.includes(value) ? value : "UNKNOWN";

export class ArtifactRefusal extends Error {
  constructor(code, message, detail = "UNKNOWN", metadata = {}) {
    super(message);
    this.code = code;
    const validCode = REFUSAL_CODES.has(code) ? code : "UNEXPECTED";
    const validDetail = code === "INVENTORY" ? enumValue(detail, INVENTORY_DETAILS) : code === "ARCHIVE" ? enumValue(detail, ARCHIVE_DETAILS) : "UNKNOWN";
    diagnosticRecords.set(this, {
      code: validDetail === "UNKNOWN" && ["INVENTORY", "ARCHIVE"].includes(code) ? "UNEXPECTED" : validCode,
      detail: validDetail,
      bytes: boundedInteger(metadata.bytes, MAX_BYTES * 2),
      limit: boundedInteger(metadata.limit, MAX_BYTES),
      exitCode: boundedInteger(metadata.exitCode, 255),
      signal: enumValue(metadata.signal, ARCHIVE_SIGNALS),
      phase: enumValue(metadata.phase, ["ROOT", "CACHE", "DEV", "ALIASES", "SERVER", "STATIC", "OTHER"]),
      kind: enumValue(metadata.kind, ["FILE", "DIRECTORY", "SYMLINK", "OTHER"]),
      alias: enumValue(metadata.alias, ["PG", "SHARP", "NAPI_SCOPE", "NAPI_CANVAS", "OTHER"]),
      target: enumValue(metadata.target, ["EXPECTED_RELATIVE", "ABSOLUTE", "OTHER_RELATIVE", "UNREADABLE"]),
      errno: enumValue(metadata.errno, ["MISSING", "PERMISSION", "OTHER"]),
      visited: Number.isSafeInteger(metadata.visited) && metadata.visited >= 0 && metadata.visited <= 100001 ? metadata.visited : "UNKNOWN",
      files: Number.isSafeInteger(metadata.files) && metadata.files >= 0 && metadata.files <= MAX_FILES ? metadata.files : "UNKNOWN",
      pathBytes: enumValue(metadata.pathBytes, ["LE100", "LE255", "LE2048", "GT2048"]),
    });
  }
}

function refuse(code, message, detail, metadata) {
  return new ArtifactRefusal(code, message, detail, metadata);
}

export function artifactRefusalCode(error) {
  return error instanceof ArtifactRefusal && REFUSAL_CODES.has(error.code) ? error.code : "UNEXPECTED";
}

export function formatArtifactRefusal(error) {
  const record = diagnosticRecords.get(error);
  const fields = record?.code === "INVENTORY"
    ? ` detail=${record.detail} phase=${record.phase} kind=${record.kind} alias=${record.alias} target=${record.target} errno=${record.errno} visited=${record.visited} files=${record.files} pathBytes=${record.pathBytes}`
    : record?.code === "ARCHIVE"
      ? ` detail=${record.detail} bytes=${record.bytes} limit=${record.limit} exitCode=${record.exitCode} signal=${record.signal}`
      : " detail=UNKNOWN";
  return `Local QA packaging refused [${record?.code ?? "UNEXPECTED"}]${fields}. No artifact is eligible for upload.`;
}

export function encryptionKeyBytes(value) {
  return decodeArtifactKey(value, (message) => refuse("KEY_CONFIG", message));
}

export function artifactAad(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid build artifact commit SHA.");
  return Buffer.from(`${ARTIFACT_FORMAT}/v${ARTIFACT_VERSION}/${sha}`, "utf8");
}

export function configuredSecrets(serviceRoleKey, encryptionKey) {
  if (typeof serviceRoleKey !== "string" || !serviceRoleKey || Buffer.byteLength(serviceRoleKey) > 1024 ** 2) {
    throw refuse("KEY_CONFIG", "Secret scan configuration is incomplete.");
  }
  const values = [Buffer.from(serviceRoleKey)];
  if (encryptionKey !== undefined) {
    encryptionKeyBytes(encryptionKey);
    values.push(Buffer.from(encryptionKey, "utf8"));
  }
  return values;
}

/** Carry an overlap so even a secret spanning two stream chunks is rejected. */
export function secretScanner(secrets) {
  const overlap = Math.max(0, ...secrets.map((secret) => secret.length - 1));
  let tail = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.concat([tail, chunk]);
      if (secrets.some((secret) => bytes.includes(secret))) {
        callback(refuse("SCANNER", "Build artifact contains a configured server-only secret."));
        return;
      }
      tail = overlap ? Buffer.from(bytes.subarray(-overlap)) : Buffer.alloc(0);
      callback(null, chunk);
    },
  });
}

function byteLimit(max, onBytes, detail, before = 0) {
  let count = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      count += chunk.length;
      if (count > max) return callback(refuse("ARCHIVE", "Build artifact exceeds its byte limit.", detail, { bytes: before + count, limit: before + max }));
      onBytes(count);
      callback(null, chunk);
    },
  });
}

export function assertArtifactContext(env) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" || !QA_KEEPER_REFS.includes(env.GITHUB_REF) ||
      env.GITHUB_REPOSITORY !== QA_REPOSITORY || !/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID ?? "") || !/^[1-9]\d{0,5}$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
      env.NEXT_PUBLIC_SUPABASE_URL !== QA_DEV_URL || env.NEXT_PUBLIC_APP_URL !== QA_ORIGIN || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "")) {
    throw refuse("CONTEXT", "Local QA artifacts require a manual keeper run and exact commit SHA.");
  }
}

export async function packageBuild({ root, output, sha, secrets, encryptionKey, context = process.env, maxBytes = MAX_BYTES, maxArchive = MAX_ARCHIVE }) {
  assertArtifactContext(context);
  if (context.GITHUB_SHA !== sha || process.versions.node.split(".")[0] !== "22") throw refuse("CONTEXT", "Exact source and Node 22 required.");
  if (!/^[a-f0-9]{40}$/.test(sha) || !secrets.length || secrets.some((s) => !Buffer.isBuffer(s) || !s.length)) {
    throw refuse("PACKAGE_CONFIG", "Invalid build artifact configuration.");
  }
  const key = encryptionKeyBytes(encryptionKey);
  const scanSecrets = [...secrets, Buffer.from(encryptionKey, "utf8")];
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BYTES ||
      !Number.isSafeInteger(maxArchive) || maxArchive <= 0 || maxArchive > MAX_ARCHIVE) {
    throw refuse("PACKAGE_CONFIG", "Invalid build artifact limits.");
  }
  const source = path.join(root, ".next");
  if (!(await lstat(source)).isDirectory()) throw refuse("SOURCE", "Expected a regular build directory.");
  const stage = await mkdtemp(path.join(tmpdir(), "proplane-qa-build-"));
  let createdOutput = false;
  const createdOutputFiles = [];
  try {
    const files = [];
    const immutableFiles = [];
    const runtimeAliases = [];
    let fileBytes = 0;
    let entries = 0;
    function inventoryRefusal(detail, relative, stat, extra = {}) {
      const phase = relative === ".next" ? "ROOT" :
        [["cache", "CACHE"], ["dev", "DEV"], ["node_modules", "ALIASES"], ["server", "SERVER"], ["static", "STATIC"]]
          .find(([name]) => relative === `.next/${name}` || relative.startsWith(`.next/${name}/`))?.[1] ?? "OTHER";
      const bytes = Buffer.byteLength(relative);
      const message = detail === "ALIAS_DUPLICATE" ? "Duplicate Next.js runtime alias." : detail.startsWith("ALIAS_") ? "Unexpected Next.js runtime alias." : "Build artifact inventory refused.";
      return refuse("INVENTORY", message, detail, {
        phase, kind: stat ? stat.isSymbolicLink() ? "SYMLINK" : stat.isDirectory() ? "DIRECTORY" : stat.isFile() ? "FILE" : "OTHER" : "UNKNOWN",
        visited: entries, files: files.length,
        pathBytes: bytes <= 100 ? "LE100" : bytes <= 255 ? "LE255" : bytes <= 2048 ? "LE2048" : "GT2048", ...extra,
      });
    }
    async function inventoryOperation(operation, relative, action, stat, extra) {
      try { return await action(); } catch (error) {
        const errno = ["ENOENT", "ENOTDIR"].includes(error?.code) ? "MISSING" : ["EACCES", "EPERM"].includes(error?.code) ? "PERMISSION" : "OTHER";
        throw inventoryRefusal(operation, relative, stat, { ...extra, errno });
      }
    }
    async function captureRuntimeAliases(directory) {
      const seenPackages = new Set();
      function countEntry(relative, extra) {
        if (++entries > 100000) throw inventoryRefusal("ENTRY_LIMIT", relative, undefined, extra);
      }
      async function leaf(relative, aliasPath, spec, extra) {
        if (!spec) throw inventoryRefusal("ALIAS_NAME", relative, undefined, extra);
        if (seenPackages.has(spec.package)) throw inventoryRefusal("ALIAS_DUPLICATE", relative, undefined, extra);
        if (runtimeAliases.length >= MAX_RUNTIME_ALIASES) throw inventoryRefusal("ALIAS_COUNT", relative, undefined, extra);
        seenPackages.add(spec.package);
        const aliasStat = await inventoryOperation("STAT", relative, () => lstat(aliasPath), undefined, extra);
        const target = await readlink(aliasPath).catch(() => null);
        extra.target = target === null ? "UNREADABLE" : target === spec.target ? "EXPECTED_RELATIVE" : path.isAbsolute(target) ? "ABSOLUTE" : "OTHER_RELATIVE";
        if (!aliasStat.isSymbolicLink()) throw inventoryRefusal("ALIAS_NOT_SYMLINK", relative, aliasStat, extra);
        if (target === null) throw inventoryRefusal("READLINK", relative, aliasStat, extra);
        if (target !== spec.target) throw inventoryRefusal("ALIAS_TARGET", relative, aliasStat, extra);
        const record = { path: relative, target, package: spec.package };
        try { record.version = await bindRuntimeAlias({ root, alias: record }); } catch (error) {
          const errno = ["ENOENT", "ENOTDIR"].includes(error.code) ? "MISSING" : ["EACCES", "EPERM"].includes(error.code) ? "PERMISSION" : "OTHER";
          throw inventoryRefusal(error.reason ?? "STAT", relative, aliasStat, { ...extra, errno });
        }
        runtimeAliases.push(record);
      }
      const names = await inventoryOperation("READDIR", relativePath(directory), () => readdir(directory));
      for (const name of names.sort()) {
        const relative = `${relativePath(directory)}/${name}`;
        const spec = RUNTIME_ALIAS_SPECS.find((candidate) => candidate.pattern.test(relative));
        const extra = { alias: spec?.diagnostic ?? (name === "@napi-rs" ? "NAPI_SCOPE" : /^canvas-[a-f0-9]{16}$/.test(name) ? "NAPI_CANVAS" : "OTHER") };
        countEntry(relative, extra);
        if (name === "@napi-rs") {
          const scope = path.join(directory, name);
          const info = await inventoryOperation("STAT", relative, () => lstat(scope), undefined, extra);
          if (!info.isDirectory() || info.isSymbolicLink()) throw inventoryRefusal("ALIAS_DIRECTORY_TYPE", relative, info, extra);
          const children = await inventoryOperation("READDIR", relative, () => readdir(scope), info, extra);
          if (!children.length) throw inventoryRefusal("ALIAS_NAME", relative, info, extra);
          for (const child of children.sort()) {
            const childRelative = `${relative}/${child}`;
            const childSpec = RUNTIME_ALIAS_SPECS.find((candidate) => candidate.pattern.test(childRelative));
            const childExtra = { alias: childSpec ? "NAPI_CANVAS" : "NAPI_SCOPE" };
            countEntry(childRelative, childExtra);
            await leaf(childRelative, path.join(scope, child), childSpec, childExtra);
          }
        } else await leaf(relative, path.join(directory, name), spec, extra);
      }
    }
    function relativePath(value) {
      return path.relative(root, value).split(path.sep).join("/");
    }
    async function visit(relative) {
      entries += 1;
      if (entries > 100000) throw inventoryRefusal("ENTRY_LIMIT", relative);
      if (relative.length > 2048) throw inventoryRefusal("WALK_PATH_LIMIT", relative);
      const src = path.join(root, relative);
      const stat = await inventoryOperation("STAT", relative, () => lstat(src));
      if (relative === ".next/node_modules") {
        if (!stat.isDirectory()) throw inventoryRefusal("ALIAS_DIRECTORY_TYPE", relative, stat);
        await captureRuntimeAliases(src);
        return;
      }
      if (stat.isSymbolicLink()) throw inventoryRefusal("SYMLINK", relative, stat);
      if (!stat.isDirectory() && !stat.isFile()) throw inventoryRefusal("SPECIAL_FILE", relative, stat);
      if (stat.isFile() && stat.nlink !== 1) throw inventoryRefusal("HARDLINK", relative, stat);
      if (relative === ".next/cache" || relative === ".next/dev") return;
      if (/[^\x20-\x7e]/.test(relative)) throw inventoryRefusal("PATH_NON_ASCII", relative, stat);
      if (relative.length > 255) throw inventoryRefusal("PATH_USTAR_LENGTH", relative, stat);
      if (stat.isDirectory()) {
        for (const name of (await inventoryOperation("READDIR", relative, () => readdir(src), stat)).sort()) {
          if (!name || name === "." || name === ".." || /[\\/\x00-\x1f\x7f]/.test(name)) {
            throw inventoryRefusal("PATH_INVALID_COMPONENT", `${relative}/${name}`, stat);
          }
          if (name.startsWith(".env")) throw inventoryRefusal("PATH_ENV_COMPONENT", `${relative}/${name}`, stat);
          await visit(`${relative}/${name}`);
        }
        return;
      }
      // USTAR needs either a name of 100 bytes or a slash separating a
      // prefix of 155 bytes and a name of 100 bytes. Full length alone is insufficient.
      if (relative.length > 100 && ![...relative].some((char, index) =>
        char === "/" && index <= 155 && relative.length - index - 1 <= 100)) {
        throw inventoryRefusal("PATH_USTAR_SPLIT", relative, stat);
      }
      if (files.length >= MAX_FILES) throw inventoryRefusal("FILE_LIMIT", relative, stat);
      if (relative.length > 2048) throw inventoryRefusal("WALK_PATH_LIMIT", relative, stat);
      if (scanSecrets.some((secret) => Buffer.from(relative).includes(secret))) throw inventoryRefusal("PATH_SECRET", relative, stat);
      const destination = path.join(stage, relative);
      const fileHash = createHash("sha256");
      await mkdir(path.dirname(destination), { recursive: true });
      const handle = await open(src, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev) {
          throw refuse("SOURCE", "Build artifact changed while being packaged.");
        }
        const before = fileBytes;
        await pipeline(handle.createReadStream({ autoClose: false }), secretScanner(scanSecrets),
          byteLimit(maxBytes - before, (size) => { fileBytes = before + size; }, "SOURCE_BYTES", before),
          new Transform({ transform(chunk, _encoding, callback) { fileHash.update(chunk); callback(null, chunk); } }),
          createWriteStream(destination, { flags: "wx", mode: 0o600 }));
      } finally {
        await handle.close();
      }
      files.push(relative);
      immutableFiles.push({ path: relative, bytes: (await lstat(destination)).size, sha256: fileHash.digest("hex") });
    }
    await visit(".next");
    if (!files.includes(".next/BUILD_ID") || !files.includes(".next/required-server-files.json")) {
      throw refuse("MARKERS", "Completed Next.js build markers are missing.");
    }
    const privateManifest = { format: ARTIFACT_FORMAT, version: ARTIFACT_VERSION, purpose: "local-dev-qa-only",
      provenance: { repository: QA_REPOSITORY, ref: context.GITHUB_REF, runId: context.GITHUB_RUN_ID, attempt: context.GITHUB_RUN_ATTEMPT },
      lockfileSha256: createHash("sha256").update(await readFile(path.join(root, "package-lock.json"))).digest("hex"),
      nodeMajor: 22, nextVersion: JSON.parse(await readFile(path.join(root, "node_modules/next/package.json"), "utf8")).version,
      target: { supabaseUrl: QA_DEV_URL, origin: QA_ORIGIN, anonKeySha256: createHash("sha256").update(context.NEXT_PUBLIC_SUPABASE_ANON_KEY).digest("hex") },
      immutableFiles,
      githubSha: sha, fileBytes, fileCount: files.length, maxUncompressedBytes: maxBytes,
      maxArchiveBytes: maxArchive, excluded: [".next/cache", ".next/dev", ".next/node_modules"], runtimeAliases,
      runtime: { host: "127.0.0.1", port: 3010, maxOldSpaceSizeMiB: 512, database: "dev/test" } };
    await writeFile(path.join(stage, PRIVATE_MANIFEST_NAME), `${JSON.stringify(privateManifest, null, 2)}\n`, { mode: 0o600 });
    const list = path.join(stage, "files.list");
    await writeFile(list, `${[...files, PRIVATE_MANIFEST_NAME].join("\0")}\0`, { mode: 0o600 });
    const stagedArchive = path.join(stage, "next-build.tar.gz");
    let tar;
    try {
      tar = spawn("tar", ["--format=ustar", "--no-recursion", "-cf", "-", "-C", stage, "--null", "-T", list],
        { stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH, LANG: "C" } });
    } catch {
      throw refuse("ARCHIVE", "Build archive creation failed.", "TAR_SPAWN");
    }
    const done = new Promise((resolve, reject) => {
      tar.once("error", () => reject(refuse("ARCHIVE", "Build archive creation failed.", "TAR_SPAWN")));
      tar.once("close", (code, signal) => code === 0 ? resolve() : reject(
        refuse("ARCHIVE", "Build archive creation failed.", signal ? "TAR_SIGNAL" : "TAR_EXIT", { exitCode: code, signal })));
    });
    // Attach immediately, including when the stream fails before the child exits.
    const settled = done.then(() => null, (error) => error);
    try {
      await pipeline(tar.stdout, byteLimit(maxBytes, () => {}, "TAR_BYTES"), createGzip(),
        byteLimit(maxArchive, () => {}, "GZIP_BYTES"),
        createWriteStream(stagedArchive, { flags: "wx", mode: 0o600 }));
    } catch (error) {
      const originalRefusal = diagnosticRecords.has(error);
      const childAlreadyExited = tar.exitCode !== null || tar.signalCode !== null;
      if (!childAlreadyExited) tar.kill("SIGKILL");
      const childError = await settled;
      // A limit/scanner refusal caused the kill, so its diagnostic takes priority.
      if (originalRefusal) throw error;
      if (childError && (childAlreadyExited || diagnosticRecords.get(childError)?.detail === "TAR_SPAWN")) throw childError;
      throw refuse("ARCHIVE", "Build archive stream failed.", "STREAM");
    }
    const archiveError = await settled;
    if (archiveError) throw archiveError;

    await mkdir(output); // Refuse to replace any existing local files.
    createdOutput = true;
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(artifactAad(sha));
    const ciphertextHash = createHash("sha256");
    let ciphertextBytes = 0;
    const ciphertextDigest = new Transform({
      transform(chunk, _encoding, callback) {
        ciphertextBytes += chunk.length;
        ciphertextHash.update(chunk);
        callback(null, chunk);
      },
    });
    const ciphertextPath = path.join(output, ENCRYPTED_ARCHIVE_NAME);
    const ciphertextHandle = await open(ciphertextPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    createdOutputFiles.push(ciphertextPath);
    await pipeline(createReadStream(stagedArchive), secretScanner(scanSecrets), cipher, ciphertextDigest,
      ciphertextHandle.createWriteStream({ autoClose: true }));
    const envelope = { format: ARTIFACT_FORMAT, version: ARTIFACT_VERSION, githubSha: sha,
      ciphertextSha256: ciphertextHash.digest("hex"), ciphertextBytes,
      nonce: nonce.toString("hex"), authTag: cipher.getAuthTag().toString("hex") };
    const envelopeBytes = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
    if (envelopeBytes.length > MAX_ENVELOPE_BYTES) throw refuse("ENCRYPTION", "QA artifact envelope exceeds its byte limit.");
    const envelopePath = path.join(output, ENVELOPE_NAME);
    const envelopeHandle = await open(envelopePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    createdOutputFiles.push(envelopePath);
    try {
      await envelopeHandle.writeFile(envelopeBytes);
    } finally {
      await envelopeHandle.close();
    }
    return envelope;
  } catch (error) {
    for (const file of createdOutputFiles) await rm(file, { force: true });
    if (createdOutput) await rmdir(output).catch(() => undefined);
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    assertArtifactContext(process.env);
    const encryptionKey = process.env.QA_ARTIFACT_ENCRYPTION_KEY ?? "";
    await packageBuild({ root: process.cwd(), output: path.resolve("local-qa-build-artifact"),
      sha: process.env.GITHUB_SHA, encryptionKey,
      secrets: configuredSecrets(process.env.QA_BUILD_SERVICE_ROLE_KEY ?? "", encryptionKey) });
    console.log("Encrypted local QA build packaged and scanned.");
  } catch (error) {
    // Never echo filenames, child diagnostics, env values, or secret-containing bytes.
    console.error(formatArtifactRefusal(error));
    process.exitCode = 1;
  }
}
