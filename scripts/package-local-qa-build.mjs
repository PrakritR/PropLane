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
export const ARTIFACT_FORMAT = "proplane-local-qa-build";
export const ARTIFACT_VERSION = 1;
export const ENCRYPTED_ARCHIVE_NAME = "next-build.tar.gz.enc";
export const ENVELOPE_NAME = "manifest.json";
const PRIVATE_MANIFEST_NAME = "qa-manifest.json";
export const ENCRYPTION_KEY_HEX_LENGTH = 64;
const NONCE_BYTES = 12;
const MAX_ENVELOPE_BYTES = 4096;
const MAX_BYTES = 1024 ** 3;
const MAX_ARCHIVE = 500 * 1024 ** 2;
const REFUSAL_CODES = new Set([
  "CONTEXT", "KEY_CONFIG", "PACKAGE_CONFIG", "SOURCE", "INVENTORY", "MARKERS",
  "SCANNER", "ARCHIVE", "OUTPUT", "ENCRYPTION", "UNEXPECTED",
]);

class ArtifactRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function refuse(code, message) {
  return new ArtifactRefusal(code, message);
}

export function artifactRefusalCode(error) {
  return error instanceof ArtifactRefusal && REFUSAL_CODES.has(error.code) ? error.code : "UNEXPECTED";
}

export function encryptionKeyBytes(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw refuse("KEY_CONFIG", "QA artifact encryption key must be exactly 64 lowercase hexadecimal characters.");
  }
  const bytes = Buffer.from(value, "hex");
  if (bytes.length !== 32) throw refuse("KEY_CONFIG", "QA artifact encryption key must be 32 bytes.");
  return bytes;
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

function byteLimit(max, onBytes) {
  let count = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      count += chunk.length;
      if (count > max) return callback(refuse("ARCHIVE", "Build artifact exceeds its byte limit."));
      onBytes(count);
      callback(null, chunk);
    },
  });
}

export function assertArtifactContext(env) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_REF !== KEEPER_REF ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "")) {
    throw refuse("CONTEXT", "Local QA artifacts require a manual keeper run and exact commit SHA.");
  }
}

export async function packageBuild({ root, output, sha, secrets, encryptionKey, maxBytes = MAX_BYTES, maxArchive = MAX_ARCHIVE }) {
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
    const runtimeAliases = [];
    let fileBytes = 0;
    let entries = 0;
    async function captureRuntimeAliases(directory) {
      const seenPackages = new Set();
      for (const name of (await readdir(directory)).sort()) {
        const match = /^(pg|sharp)-([a-f0-9]{16})$/.exec(name);
        if (!match) throw refuse("INVENTORY", "Unexpected Next.js runtime alias.");
        const packageName = match[1];
        if (seenPackages.has(packageName) || runtimeAliases.length >= 2) {
          throw refuse("INVENTORY", "Duplicate Next.js runtime alias.");
        }
        seenPackages.add(packageName);
        const aliasPath = path.join(directory, name);
        const aliasStat = await lstat(aliasPath);
        const target = await readlink(aliasPath).catch(() => null);
        if (!aliasStat.isSymbolicLink() || target !== `../../node_modules/${packageName}` ||
            path.resolve(directory, target) !== path.join(root, "node_modules", packageName)) {
          throw refuse("INVENTORY", "Unexpected Next.js runtime alias.");
        }
        const packageDirectory = path.join(root, "node_modules", packageName);
        const packageStat = await lstat(packageDirectory);
        const packageJson = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8"));
        const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
        const lockedVersion = lock.packages?.[`node_modules/${packageName}`]?.version;
        if (!packageStat.isDirectory() || packageJson.name !== packageName ||
            typeof packageJson.version !== "string" || packageJson.version.length > 100 ||
            packageJson.version !== lockedVersion) {
          throw refuse("INVENTORY", "Next.js runtime alias package binding changed.");
        }
        runtimeAliases.push({ path: `${relativePath(directory)}/${name}`, target, package: packageName, version: packageJson.version });
      }
    }
    function relativePath(value) {
      return path.relative(root, value).split(path.sep).join("/");
    }
    async function visit(relative) {
      entries += 1;
      if (entries > 100000 || relative.length > 2048) throw refuse("INVENTORY", "Build artifact inventory is too large.");
      const src = path.join(root, relative);
      const stat = await lstat(src);
      if (relative === ".next/node_modules") {
        if (!stat.isDirectory()) throw refuse("INVENTORY", "Unexpected Next.js runtime alias directory.");
        await captureRuntimeAliases(src);
        return;
      }
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) {
        throw refuse("INVENTORY", "Build artifact links and special files are forbidden.");
      }
      if (relative === ".next/cache" || relative === ".next/dev") return;
      if (stat.isDirectory()) {
        for (const name of (await readdir(src)).sort()) {
          if (!name || name === "." || name === ".." || /[\\/\x00-\x1f\x7f]/.test(name) || name.startsWith(".env")) {
            throw refuse("INVENTORY", "Unexpected build artifact path.");
          }
          await visit(`${relative}/${name}`);
        }
        return;
      }
      if (files.length >= 50000 || relative.length > 2048) throw refuse("INVENTORY", "Build artifact inventory is too large.");
      if (scanSecrets.some((secret) => Buffer.from(relative).includes(secret))) throw refuse("INVENTORY", "Unsafe build artifact path.");
      const destination = path.join(stage, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      const handle = await open(src, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev) {
          throw refuse("SOURCE", "Build artifact changed while being packaged.");
        }
        const before = fileBytes;
        await pipeline(handle.createReadStream({ autoClose: false }), secretScanner(scanSecrets),
          byteLimit(maxBytes - before, (size) => { fileBytes = before + size; }),
          createWriteStream(destination, { flags: "wx", mode: 0o600 }));
      } finally {
        await handle.close();
      }
      files.push(relative);
    }
    await visit(".next");
    if (!files.includes(".next/BUILD_ID") || !files.includes(".next/required-server-files.json")) {
      throw refuse("MARKERS", "Completed Next.js build markers are missing.");
    }
    const privateManifest = { format: ARTIFACT_FORMAT, version: ARTIFACT_VERSION, purpose: "local-dev-qa-only",
      githubSha: sha, fileBytes, fileCount: files.length, maxUncompressedBytes: maxBytes,
      maxArchiveBytes: maxArchive, excluded: [".next/cache", ".next/dev", ".next/node_modules"], runtimeAliases,
      runtime: { host: "127.0.0.1", port: 3010, maxOldSpaceSizeMiB: 512, database: "dev/test" } };
    await writeFile(path.join(stage, PRIVATE_MANIFEST_NAME), `${JSON.stringify(privateManifest, null, 2)}\n`, { mode: 0o600 });
    const list = path.join(stage, "files.list");
    await writeFile(list, `${[...files, PRIVATE_MANIFEST_NAME].join("\0")}\0`, { mode: 0o600 });
    const stagedArchive = path.join(stage, "next-build.tar.gz");
    const tar = spawn("tar", ["--format=posix", "--no-recursion", "-cf", "-", "-C", stage, "--null", "-T", list],
      { stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH, LANG: "C" } });
    const done = new Promise((resolve, reject) => {
      tar.once("error", () => reject(refuse("ARCHIVE", "Build archive creation failed.")));
      tar.once("close", (code) => code === 0 ? resolve() : reject(refuse("ARCHIVE", "Build archive creation failed.")));
    });
    // Attach immediately, including when the stream fails before the child exits.
    const settled = done.then(() => null, (error) => error);
    try {
      await pipeline(tar.stdout, byteLimit(maxBytes, () => {}), createGzip(),
        byteLimit(maxArchive, () => {}),
        createWriteStream(stagedArchive, { flags: "wx", mode: 0o600 }));
    } catch (error) {
      if (tar.exitCode === null) tar.kill("SIGKILL");
      await settled;
      throw error;
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
    console.error(`Local QA packaging refused [${artifactRefusalCode(error)}]. No artifact is eligible for upload.`);
    process.exitCode = 1;
  }
}
