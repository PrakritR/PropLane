/** Verify and decrypt a local QA artifact into a private archive file. This never extracts files. */
import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rm, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { Writable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import {
  ARTIFACT_FORMAT,
  ARTIFACT_VERSION,
  ENCRYPTED_ARCHIVE_NAME,
  ENVELOPE_NAME,
  artifactAad,
  encryptionKeyBytes,
} from "./package-local-qa-build.mjs";

const MAX_ARCHIVE = 500 * 1024 ** 2;
const MAX_ENVELOPE_BYTES = 4096;
const NONCE_HEX_LENGTH = 24;
const AUTH_TAG_HEX_LENGTH = 32;

function hex(value, length, label) {
  if (typeof value !== "string" || value.length !== length || !/^[a-f0-9]+$/.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return Buffer.from(value, "hex");
}

async function regularFile(file, label, maxBytes) {
  const info = await lstat(file);
  if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw new Error(`Invalid ${label}.`);
  return info;
}

async function readEnvelope(artifactDir) {
  const envelopePath = path.join(artifactDir, ENVELOPE_NAME);
  const info = await regularFile(envelopePath, "QA artifact envelope", MAX_ENVELOPE_BYTES);
  const raw = await readFile(envelopePath);
  if (raw.length !== info.size) throw new Error("QA artifact envelope changed while being read.");
  let envelope;
  try {
    envelope = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Invalid QA artifact envelope.");
  }
  const expectedKeys = ["format", "version", "githubSha", "ciphertextSha256", "ciphertextBytes", "nonce", "authTag"];
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
      Object.keys(envelope).sort().join("\0") !== expectedKeys.sort().join("\0") ||
      envelope.format !== ARTIFACT_FORMAT || envelope.version !== ARTIFACT_VERSION ||
      !/^[a-f0-9]{40}$/.test(envelope.githubSha) ||
      !/^[a-f0-9]{64}$/.test(envelope.ciphertextSha256) ||
      !Number.isSafeInteger(envelope.ciphertextBytes) || envelope.ciphertextBytes <= 0 ||
      envelope.ciphertextBytes > MAX_ARCHIVE) {
    throw new Error("Invalid QA artifact envelope.");
  }
  envelope.nonce = hex(envelope.nonce, NONCE_HEX_LENGTH, "QA artifact nonce");
  envelope.authTag = hex(envelope.authTag, AUTH_TAG_HEX_LENGTH, "QA artifact authentication tag");
  return envelope;
}

async function verifyCiphertext(artifactDir, envelope) {
  const ciphertextPath = path.join(artifactDir, ENCRYPTED_ARCHIVE_NAME);
  const info = await regularFile(ciphertextPath, "QA artifact ciphertext", MAX_ARCHIVE);
  if (info.size !== envelope.ciphertextBytes) throw new Error("QA artifact ciphertext size mismatch.");
  const handle = await open(ciphertextPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const digest = createHash("sha256");
  let bytes = 0;
  const digestStream = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE) {
        callback(new Error("QA artifact ciphertext exceeds its byte limit."));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== envelope.ciphertextBytes) {
      throw new Error("QA artifact ciphertext changed while being read.");
    }
    await pipeline(handle.createReadStream({ autoClose: false }), digestStream,
      new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
  } finally {
    await handle.close();
  }
  if (bytes !== envelope.ciphertextBytes ||
      !timingSafeEqual(Buffer.from(digest.digest("hex"), "utf8"), Buffer.from(envelope.ciphertextSha256, "utf8"))) {
    throw new Error("QA artifact ciphertext digest mismatch.");
  }
  return ciphertextPath;
}

export async function decryptArtifact({ artifactDir, sha, encryptionKey, output }) {
  if (typeof artifactDir !== "string" || typeof output !== "string" || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error("Invalid QA artifact decryption configuration.");
  }
  const key = encryptionKeyBytes(encryptionKey);
  const envelope = await readEnvelope(artifactDir);
  if (envelope.githubSha !== sha) throw new Error("QA artifact commit SHA mismatch.");
  const ciphertextPath = await verifyCiphertext(artifactDir, envelope);
  const parent = path.dirname(output);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  let createdOutput = false;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce);
    decipher.setAAD(artifactAad(sha));
    decipher.setAuthTag(envelope.authTag);
    let plaintextBytes = 0;
    const boundedPlaintext = new Transform({
      transform(chunk, _encoding, callback) {
        plaintextBytes += chunk.length;
        if (plaintextBytes > MAX_ARCHIVE) {
          callback(new Error("QA artifact plaintext exceeds its byte limit."));
          return;
        }
        callback(null, chunk);
      },
    });
    const ciphertextHandle = await open(ciphertextPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await ciphertextHandle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.size !== envelope.ciphertextBytes) {
        throw new Error("QA artifact ciphertext changed before decryption.");
      }
      const destinationHandle = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      createdOutput = true;
      await pipeline(ciphertextHandle.createReadStream({ autoClose: false }), decipher, boundedPlaintext,
        destinationHandle.createWriteStream({ autoClose: true }));
    } finally {
      await ciphertextHandle.close();
    }
    return output;
  } catch (error) {
    if (createdOutput) await rm(output, { force: true });
    throw error;
  }
}

/** Recreate only authenticated Next.js external aliases after the caller safely extracts the archive. */
export async function restoreRuntimeAliases({ root, privateManifest }) {
  if (typeof root !== "string" || !path.isAbsolute(root) || !privateManifest ||
      !Array.isArray(privateManifest.runtimeAliases) || privateManifest.runtimeAliases.length > 2) {
    throw new Error("Invalid QA runtime alias manifest.");
  }
  const nextDirectory = path.join(root, ".next");
  if (!(await lstat(nextDirectory)).isDirectory()) throw new Error("Invalid extracted Next.js directory.");
  const aliasDirectory = path.join(nextDirectory, "node_modules");
  await mkdir(aliasDirectory, { mode: 0o700 }).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  if (!(await lstat(aliasDirectory)).isDirectory()) throw new Error("Invalid Next.js runtime alias directory.");
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const created = [];
  const seen = new Set();
  try {
    for (const alias of privateManifest.runtimeAliases) {
      const keys = alias && typeof alias === "object" ? Object.keys(alias).sort().join("\0") : "";
      const match = typeof alias?.path === "string"
        ? /^\.next\/node_modules\/(pg|sharp)-[a-f0-9]{16}$/.exec(alias.path)
        : null;
      const packageName = match?.[1];
      if (keys !== "package\0path\0target\0version" || !packageName || alias.package !== packageName ||
          alias.target !== `../../node_modules/${packageName}` || typeof alias.version !== "string" ||
          alias.version.length > 100 || seen.has(packageName)) {
        throw new Error("Invalid QA runtime alias manifest.");
      }
      seen.add(packageName);
      const destination = path.join(root, ...alias.path.split("/"));
      if (path.dirname(destination) !== aliasDirectory) throw new Error("Invalid QA runtime alias path.");
      const packageDirectory = path.join(root, "node_modules", packageName);
      const packageStat = await lstat(packageDirectory);
      const packageJson = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8"));
      if (!packageStat.isDirectory() || packageJson.name !== packageName ||
          packageJson.version !== alias.version || lock.packages?.[`node_modules/${packageName}`]?.version !== alias.version) {
        throw new Error("QA runtime dependency does not match the authenticated manifest.");
      }
      await symlink(alias.target, destination, "dir");
      created.push(destination);
    }
    return privateManifest.runtimeAliases.length;
  } catch (error) {
    for (const destination of created.reverse()) await unlink(destination).catch(() => undefined);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [artifactDir, sha, output] = process.argv.slice(2);
  let encryptionKey = process.env.QA_ARTIFACT_ENCRYPTION_KEY;
  if (!encryptionKey && process.env.QA_ARTIFACT_ENCRYPTION_KEY_FILE) {
    try {
      encryptionKey = (await readFile(process.env.QA_ARTIFACT_ENCRYPTION_KEY_FILE, "utf8")).trim();
    } catch {
      encryptionKey = undefined;
    }
  }
  if (!artifactDir || !sha || !output || !encryptionKey) {
    console.error("Usage: QA_ARTIFACT_ENCRYPTION_KEY=<key> node scripts/decrypt-local-qa-build.mjs <artifact-dir> <commit-sha> <private-output>");
    process.exitCode = 2;
  } else {
    try {
      await decryptArtifact({ artifactDir, sha, encryptionKey, output });
      console.log("Encrypted local QA build verified and decrypted to the requested private archive.");
    } catch {
      console.error("Local QA artifact decryption refused. No archive is available.");
      process.exitCode = 1;
    }
  }
}
