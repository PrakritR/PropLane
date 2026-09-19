/** Private, SHA-bound local QA transport. This never deploys or loads runtime env files. */
import { constants, createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { pathToFileURL } from "node:url";

export const KEEPER_REF = "refs/heads/akhil/test-workspace-release-20260919";
const MAX_BYTES = 1024 ** 3;
const MAX_ARCHIVE = 500 * 1024 ** 2;
export function configuredSecrets(serviceRoleKey) {
  if (typeof serviceRoleKey !== "string" || !serviceRoleKey || Buffer.byteLength(serviceRoleKey) > 1024 ** 2) {
    throw new Error("Secret scan configuration is incomplete.");
  }
  return [Buffer.from(serviceRoleKey)];
}

/** Carry an overlap so even a secret spanning two stream chunks is rejected. */
export function secretScanner(secrets) {
  const overlap = Math.max(0, ...secrets.map((secret) => secret.length - 1));
  let tail = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.concat([tail, chunk]);
      if (secrets.some((secret) => bytes.includes(secret))) {
        callback(new Error("Build artifact contains a configured server-only secret."));
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
      if (count > max) return callback(new Error("Build artifact exceeds its byte limit."));
      onBytes(count);
      callback(null, chunk);
    },
  });
}

export function assertArtifactContext(env) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_REF !== KEEPER_REF ||
      env.QA_REPOSITORY_PRIVATE !== "true" || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "")) {
    throw new Error("Local QA artifacts require a private manual keeper run and exact commit SHA.");
  }
}

export async function packageBuild({ root, output, sha, secrets, maxBytes = MAX_BYTES, maxArchive = MAX_ARCHIVE }) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !secrets.length || secrets.some((s) => !Buffer.isBuffer(s) || !s.length)) {
    throw new Error("Invalid build artifact configuration.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BYTES ||
      !Number.isSafeInteger(maxArchive) || maxArchive <= 0 || maxArchive > MAX_ARCHIVE) {
    throw new Error("Invalid build artifact limits.");
  }
  const source = path.join(root, ".next");
  if (!(await lstat(source)).isDirectory()) throw new Error("Expected a regular build directory.");
  const stage = await mkdtemp(path.join(tmpdir(), "proplane-qa-build-"));
  let createdOutput = false;
  try {
    const files = [];
    let fileBytes = 0;
    let entries = 0;
    async function visit(relative) {
      entries += 1;
      if (entries > 100000 || relative.length > 2048) throw new Error("Build artifact inventory is too large.");
      const src = path.join(root, relative);
      const stat = await lstat(src);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) {
        throw new Error("Build artifact links and special files are forbidden.");
      }
      if (relative === ".next/cache" || relative === ".next/dev") return;
      if (stat.isDirectory()) {
        for (const name of (await readdir(src)).sort()) {
          if (!name || name === "." || name === ".." || /[\\/\x00-\x1f\x7f]/.test(name) || name.startsWith(".env")) {
            throw new Error("Unexpected build artifact path.");
          }
          await visit(`${relative}/${name}`);
        }
        return;
      }
      if (files.length >= 50000 || relative.length > 2048) throw new Error("Build artifact inventory is too large.");
      if (secrets.some((secret) => Buffer.from(relative).includes(secret))) throw new Error("Unsafe build artifact path.");
      const destination = path.join(stage, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      const handle = await open(src, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev) {
          throw new Error("Build artifact changed while being packaged.");
        }
        const before = fileBytes;
        await pipeline(handle.createReadStream({ autoClose: false }), secretScanner(secrets),
          byteLimit(maxBytes - before, (size) => { fileBytes = before + size; }),
          createWriteStream(destination, { flags: "wx", mode: 0o600 }));
      } finally {
        await handle.close();
      }
      files.push(relative);
    }
    await visit(".next");
    if (!files.includes(".next/BUILD_ID") || !files.includes(".next/required-server-files.json")) {
      throw new Error("Completed Next.js build markers are missing.");
    }
    await mkdir(output); // Refuse to replace any existing local files.
    createdOutput = true;
    const list = path.join(stage, "files.list");
    await writeFile(list, `${files.join("\0")}\0`, { mode: 0o600 });
    const archiveName = "next-build.tar.gz";
    const tar = spawn("tar", ["--format=posix", "--no-recursion", "-cf", "-", "-C", stage, "--null", "-T", list],
      { stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH, LANG: "C" } });
    const done = new Promise((resolve, reject) => {
      tar.once("error", () => reject(new Error("Build archive creation failed.")));
      tar.once("close", (code) => code === 0 ? resolve() : reject(new Error("Build archive creation failed.")));
    });
    // Attach immediately, including when the stream fails before the child exits.
    const settled = done.then(() => null, (error) => error);
    let tarBytes = 0;
    let archiveBytes = 0;
    try {
      await pipeline(tar.stdout, byteLimit(maxBytes, (n) => { tarBytes = n; }), createGzip(),
        byteLimit(maxArchive, (n) => { archiveBytes = n; }),
        createWriteStream(path.join(output, archiveName), { flags: "wx", mode: 0o600 }));
    } catch (error) {
      if (tar.exitCode === null) tar.kill("SIGKILL");
      await settled;
      throw error;
    }
    const archiveError = await settled;
    if (archiveError) throw archiveError;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path.join(output, archiveName))) hash.update(chunk);
    const manifest = { version: 1, purpose: "local-dev-qa-only", githubSha: sha,
      archive: archiveName, sha256: hash.digest("hex"), archiveBytes, uncompressedTarBytes: tarBytes,
      fileBytes, fileCount: files.length, maxUncompressedBytes: maxBytes, maxArchiveBytes: maxArchive,
      excluded: [".next/cache", ".next/dev"], runtime: { host: "127.0.0.1", port: 3010, maxOldSpaceSizeMiB: 512, database: "dev/test" } };
    await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return manifest;
  } catch (error) {
    if (createdOutput) await rm(output, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    assertArtifactContext(process.env);
    await packageBuild({ root: process.cwd(), output: path.resolve("local-qa-build-artifact"),
      sha: process.env.GITHUB_SHA, secrets: configuredSecrets(process.env.QA_BUILD_SERVICE_ROLE_KEY ?? "") });
    console.log("Private local QA build packaged and scanned.");
  } catch {
    // Never echo filenames, child diagnostics, env values, or secret-containing bytes.
    console.error("Local QA packaging refused. No artifact is eligible for upload.");
    process.exitCode = 1;
  }
}
