import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, readlink, rm, symlink, stat, link, lstat, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { parse } from "yaml";
import { gunzipSync } from "node:zlib";
import { MAX_BYTES, MAX_ARCHIVE, ArtifactRefusal, INVENTORY_DETAILS, ARCHIVE_DETAILS, formatArtifactRefusal, artifactRefusalCode, assertArtifactContext, configuredSecrets, encryptionKeyBytes, KEEPER_REF, QA_KEEPER_REFS, packageBuild, secretScanner } from "../../scripts/package-local-qa-build.mjs";
import { decryptArtifact, restoreRuntimeAliases } from "../../scripts/decrypt-local-qa-build.mjs";

import { RUNTIME_ALIAS_SPECS, validateRuntimeAliases } from "../../scripts/lib/local-qa-runtime-aliases.mjs";
const restoreFault = vi.hoisted(() => ({ remaining: 0 }));
const archiveFault = vi.hoisted(() => ({ gzip: false }));
vi.mock("node:zlib", async (original) => {
  const actual = await original<typeof import("node:zlib")>();
  return { ...actual, createGzip: (...args: Parameters<typeof actual.createGzip>) => {
    if (archiveFault.gzip) throw new Error("/private/secret-stream-failure");
    return actual.createGzip(...args);
  } };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, symlink: vi.fn(async (...args: Parameters<typeof actual.symlink>) => {
    if (restoreFault.remaining && --restoreFault.remaining === 0) throw new Error('simulated later creation failure');
    return actual.symlink(...args);
  }) };
});
const SHA = "a".repeat(40);
const SECRET = Buffer.from("server-secret-fixture-only");
const KEY = "ab".repeat(32);
const WRONG_KEY = "cd".repeat(32);
const roots: string[] = [];
const context = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: KEEPER_REF, GITHUB_SHA: SHA, GITHUB_REPOSITORY: 'PrakritR/PropLane', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', NEXT_PUBLIC_SUPABASE_URL: 'https://emstjswhotsnyksqhqyf.supabase.co', NEXT_PUBLIC_APP_URL: 'http://localhost:3010', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-fixture-anon' };
afterEach(async () => { restoreFault.remaining = 0; archiveFault.gzip = false; vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "qa-artifact-test-"));
  roots.push(root);
  await mkdir(path.join(root, ".next/server"), { recursive: true });
  await writeFile(path.join(root, ".next/BUILD_ID"), "build-id");
  await writeFile(path.join(root, ".next/required-server-files.json"), "{}");
  await writeFile(path.join(root, ".next/server/page.js"), "module.exports = 'clean';");
  await mkdir(path.join(root, 'node_modules/next'), { recursive: true });
  await writeFile(path.join(root, 'node_modules/next/package.json'), JSON.stringify({ name: 'next', version: '16.0.0' }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/next': { version: '16.0.0' } } }));
  return { root, output: path.join(root, "artifact"), sha: SHA, secrets: [SECRET], context };
}

async function addAliases(root: string, packages = ['pg', 'sharp', '@napi-rs/canvas']) {
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const records = [];
  for (const packageName of packages) {
    const spec = RUNTIME_ALIAS_SPECS.find((value: { package: string }) => value.package === packageName)!;
    const aliasPath = `.next/node_modules/${packageName}-0123456789abcdef`;
    await mkdir(path.dirname(path.join(root, aliasPath)), { recursive: true });
    await mkdir(path.join(root, 'node_modules', packageName), { recursive: true });
    await writeFile(path.join(root, 'node_modules', packageName, 'package.json'), JSON.stringify({ name: packageName, version: '1.0.9' }));
    lock.packages[`node_modules/${packageName}`] = { version: '1.0.9' };
    await symlink(spec.target, path.join(root, aliasPath));
    records.push({ package: packageName, path: aliasPath, target: spec.target, version: '1.0.9' });
  }
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  return records;
}

function scan(chunks: Buffer[]) {
  return pipeline(Readable.from(chunks), secretScanner([SECRET]), new Writable({ write(_chunk, _encoding, done) { done(); } }));
}

describe("encrypted local QA build transport", () => {
  it("formats every closed reason and never reflects untrusted error properties", () => {
    const sentinel = "/private/secret-token-never-print";
    for (const detail of INVENTORY_DETAILS) {
      const error = new ArtifactRefusal("INVENTORY", sentinel, detail, {
        phase: "ALIASES", kind: "SYMLINK", alias: "PG", target: "EXPECTED_RELATIVE", errno: "OTHER",
        visited: 5, files: 2, pathBytes: "LE100", ignored: sentinel,
      });
      error.stack = sentinel;
      expect(formatArtifactRefusal(error)).toBe(`Local QA packaging refused [INVENTORY] detail=${detail} phase=ALIASES kind=SYMLINK alias=PG target=EXPECTED_RELATIVE errno=OTHER visited=5 files=2 pathBytes=LE100. No artifact is eligible for upload.`);
      Object.assign(error, { code: sentinel, detail: sentinel, metadata: sentinel });
      expect(formatArtifactRefusal(error)).not.toContain(sentinel);
    }
    const unknown = "Local QA packaging refused [UNEXPECTED] detail=UNKNOWN. No artifact is eligible for upload.";
    for (const error of [new Error(sentinel), { code: "INVENTORY", detail: "SYMLINK", message: sentinel }, new ArtifactRefusal("INVENTORY", sentinel, sentinel), new ArtifactRefusal(sentinel, sentinel), null, undefined, sentinel]) {
      expect(formatArtifactRefusal(error)).toBe(unknown);
    }
    const error = new ArtifactRefusal("INVENTORY", sentinel, "ALIAS_TARGET", {
      phase: sentinel, kind: sentinel, alias: sentinel, target: sentinel, errno: sentinel,
      visited: Number.MAX_SAFE_INTEGER, files: -1, pathBytes: sentinel,
    });
    expect(formatArtifactRefusal(error)).toBe("Local QA packaging refused [INVENTORY] detail=ALIAS_TARGET phase=UNKNOWN kind=UNKNOWN alias=UNKNOWN target=UNKNOWN errno=UNKNOWN visited=UNKNOWN files=UNKNOWN pathBytes=UNKNOWN. No artifact is eligible for upload.");
    const hostile = Object.create(null, { code: { get() { throw new Error(sentinel); } } });
    expect(formatArtifactRefusal(hostile)).toBe(unknown);
  });

  it("closes archive diagnostics over fixed details and bounded metadata", () => {
    const sentinel = "/private/secret-token-never-print";
    for (const detail of ARCHIVE_DETAILS) {
      const error = new ArtifactRefusal("ARCHIVE", sentinel, detail, { bytes: 1024, limit: 512, exitCode: 7, signal: "SIGTERM", ignored: sentinel });
      expect(formatArtifactRefusal(error)).toBe(`Local QA packaging refused [ARCHIVE] detail=${detail} bytes=1024 limit=512 exitCode=7 signal=SIGTERM. No artifact is eligible for upload.`);
      Object.assign(error, { code: sentinel, detail: sentinel, stack: sentinel, message: sentinel });
      expect(formatArtifactRefusal(error)).not.toContain(sentinel);
    }
    for (const [field, max] of [["bytes", MAX_BYTES * 2], ["limit", MAX_BYTES], ["exitCode", 255]] as const) {
      for (const value of [0, max]) expect(formatArtifactRefusal(new ArtifactRefusal("ARCHIVE", sentinel, "STREAM", { [field]: value }))).toContain(`${field}=${value}`);
      for (const value of [-1, max + 1, 1.5, NaN, Infinity, "123", sentinel]) expect(formatArtifactRefusal(new ArtifactRefusal("ARCHIVE", sentinel, "STREAM", { [field]: value }))).toContain(`${field}=UNKNOWN`);
    }
    expect(formatArtifactRefusal(new ArtifactRefusal("ARCHIVE", sentinel, "STREAM", { signal: sentinel }))).toContain("signal=UNKNOWN");
    expect(formatArtifactRefusal(new ArtifactRefusal("ARCHIVE", sentinel, sentinel))).toBe("Local QA packaging refused [UNEXPECTED] detail=UNKNOWN. No artifact is eligible for upload.");
  });

  it.each([
    `.next/server/${"x".repeat(101)}`,
    `.next/${"x".repeat(150)}/${"y".repeat(94)}/z`,
  ])("refuses an unrepresentable USTAR path before publication: %s", async (relative) => {
    const input = await fixture();
    await mkdir(path.dirname(path.join(input.root, relative)), { recursive: true });
    await writeFile(path.join(input.root, relative), "clean");
    const error = await packageBuild({ ...input, encryptionKey: KEY }).catch((error: unknown) => error);
    expect(formatArtifactRefusal(error)).toContain("[INVENTORY] detail=PATH_USTAR_SPLIT ");
    expect(formatArtifactRefusal(error)).not.toContain(relative);
    await expect(stat(input.output)).rejects.toThrow();
  });

  it("round trips USTAR name and prefix boundaries without silently omitting files", async () => {
    const input = await fixture();
    const paths = [`.next/server/${"x".repeat(100)}`, `.next/${"y".repeat(149)}/${"z".repeat(99)}`];
    for (const relative of paths) {
      await mkdir(path.dirname(path.join(input.root, relative)), { recursive: true });
      await writeFile(path.join(input.root, relative), `content:${relative}`);
    }
    await packageBuild({ ...input, encryptionKey: KEY });
    const archive = path.join(input.root, "private/build.tar.gz");
    await decryptArtifact({ artifactDir: input.output, sha: SHA, encryptionKey: KEY, output: archive });
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
    for (const relative of paths) {
      expect(entries).toContain(relative);
      expect(execFileSync("tar", ["-xOf", archive, relative], { encoding: "utf8" })).toBe(`content:${relative}`);
    }
    const manifest = JSON.parse(execFileSync("tar", ["-xOf", archive, "qa-manifest.json"], { encoding: "utf8" }));
    expect(manifest.maxUncompressedBytes).toBe(4 * 1024 ** 3);
    expect(manifest.maxArchiveBytes).toBe(500 * 1024 ** 2);
    expect(MAX_ARCHIVE).toBe(500 * 1024 ** 2);
    expect(manifest.immutableFiles.map((file: { path: string }) => file.path).sort()).toEqual(entries.filter((entry) => entry !== "qa-manifest.json").sort());
  });

  it("keeps stream failures private and does not report its cleanup kill as the cause", async () => {
    const input = await fixture();
    archiveFault.gzip = true;
    const error = await packageBuild({ ...input, encryptionKey: KEY }).catch((error: unknown) => error);
    expect(formatArtifactRefusal(error)).toBe("Local QA packaging refused [ARCHIVE] detail=STREAM bytes=UNKNOWN limit=UNKNOWN exitCode=UNKNOWN signal=UNKNOWN. No artifact is eligible for upload.");
    await expect(stat(input.output)).rejects.toThrow();
  });

  it.each(["spawn", "exit", "signal"])("diagnoses tar %s without reflecting child stderr", async (kind) => {
    const input = await fixture();
    const bin = path.join(input.root, "bin");
    await mkdir(bin);
    if (kind !== "spawn") await writeFile(path.join(bin, "tar"), `#!/bin/sh\necho /private/secret-child-token >&2\n${kind === "exit" ? "exit 7" : "kill -TERM $$"}\n`, { mode: 0o700 });
    vi.stubEnv("PATH", bin);
    const error = await packageBuild({ ...input, encryptionKey: KEY }).catch((error: unknown) => error);
    expect(formatArtifactRefusal(error)).toContain(`detail=TAR_${kind.toUpperCase()} `);
    if (kind === "exit") expect(formatArtifactRefusal(error)).toContain("exitCode=7");
    if (kind === "signal") expect(formatArtifactRefusal(error)).toContain("signal=SIGTERM");
    expect(formatArtifactRefusal(error)).not.toContain("private");
    expect(formatArtifactRefusal(error)).not.toContain(input.root);
    await expect(stat(input.output)).rejects.toThrow();
  });

  it("formats each allowed metadata enum and validates numeric boundaries", () => {
    const enums = {
      phase: ["ROOT", "CACHE", "DEV", "ALIASES", "SERVER", "STATIC", "OTHER"],
      kind: ["FILE", "DIRECTORY", "SYMLINK", "OTHER"],
      alias: ["PG", "SHARP", "NAPI_SCOPE", "NAPI_CANVAS", "OTHER"],
      target: ["EXPECTED_RELATIVE", "ABSOLUTE", "OTHER_RELATIVE", "UNREADABLE"],
      errno: ["MISSING", "PERMISSION", "OTHER"],
      pathBytes: ["LE100", "LE255", "LE2048", "GT2048"],
    };
    for (const [field, values] of Object.entries(enums)) {
      for (const value of values) {
        expect(formatArtifactRefusal(new ArtifactRefusal("INVENTORY", "private", "STAT", { [field]: value }))).toContain(`${field}=${value}`);
      }
    }
    for (const [field, max] of [["visited", 100001], ["files", 50000]] as const) {
      for (const value of [0, max]) {
        expect(formatArtifactRefusal(new ArtifactRefusal("INVENTORY", "private", "ENTRY_LIMIT", { [field]: value }))).toContain(`${field}=${value}`);
      }
      for (const value of [-1, max + 1, 1.5, NaN, Infinity, "123", "/private/token"]) {
        expect(formatArtifactRefusal(new ArtifactRefusal("INVENTORY", "private", "FILE_LIMIT", { [field]: value }))).toContain(`${field}=UNKNOWN`);
      }
    }
  });

  it.each(["symlink", "cache-link", "dev-link", "hardlink", "special", "env", "control", "non-ascii", "long", "secret", "alias-directory", "unknown-alias", "scope-alias", "alias-file", "alias-target", "missing-package", "package-name", "package-version", "package-json", "lock-json"])("diagnoses %s without publishing paths or secrets", async (kind) => {
    const input = await fixture();
    let detail = "";
    if (["symlink", "cache-link", "dev-link"].includes(kind)) {
      await symlink("server", path.join(input.root, ".next", kind === "symlink" ? "private-link" : kind === "cache-link" ? "cache" : "dev"));
      detail = "SYMLINK";
    } else if (kind === "hardlink") {
      await link(path.join(input.root, ".next/server/page.js"), path.join(input.root, ".next/server/private-hardlink"));
      detail = "HARDLINK";
    } else if (kind === "special") {
      execFileSync("mkfifo", [path.join(input.root, ".next/server/private-fifo")]);
      detail = "SPECIAL_FILE";
    } else if (["env", "control", "non-ascii", "long", "secret"].includes(kind)) {
      const names: Record<string, string> = { env: ".env.private", control: "private\nname", "non-ascii": "private-é", long: "x".repeat(245), secret: SECRET.toString() };
      await writeFile(path.join(input.root, ".next/server", names[kind]), "clean");
      detail = ({ env: "PATH_ENV_COMPONENT", control: "PATH_INVALID_COMPONENT", "non-ascii": "PATH_NON_ASCII", long: "PATH_USTAR_LENGTH", secret: "PATH_SECRET" } as Record<string, string>)[kind];
    } else if (kind === "alias-directory") {
      await writeFile(path.join(input.root, ".next/node_modules"), "clean");
      detail = "ALIAS_DIRECTORY_TYPE";
    } else {
      await mkdir(path.join(input.root, ".next/node_modules"));
      const name = kind === "unknown-alias" ? "private-unknown" : kind === "scope-alias" ? "@napi-rs" : "pg-0123456789abcdef";
      const aliasPath = path.join(input.root, ".next/node_modules", name);
      if (kind === "scope-alias") await mkdir(aliasPath);
      else if (kind === "alias-file") await writeFile(aliasPath, "clean");
      else await symlink(kind === "alias-target" ? "/private/secret-target" : "../../node_modules/pg", aliasPath);
      const details: Record<string, string> = { "unknown-alias": "ALIAS_NAME", "scope-alias": "ALIAS_NAME", "alias-file": "ALIAS_NOT_SYMLINK", "alias-target": "ALIAS_TARGET", "missing-package": "STAT", "package-name": "ALIAS_PACKAGE_NAME", "package-version": "ALIAS_PACKAGE_VERSION", "package-json": "PACKAGE_READ", "lock-json": "LOCK_READ" };
      detail = details[kind];
      if (["package-name", "package-version", "package-json", "lock-json"].includes(kind)) {
        await mkdir(path.join(input.root, "node_modules/pg"));
        await writeFile(path.join(input.root, "node_modules/pg/package.json"), kind === "package-json" ? "invalid" : JSON.stringify({ name: kind === "package-name" ? "private-name" : "pg", version: "8.22.0" }));
        await writeFile(path.join(input.root, "package-lock.json"), kind === "lock-json" ? "invalid" : JSON.stringify({ packages: { "node_modules/pg": { version: kind === "package-version" ? "wrong" : "8.22.0" } } }));
      }
    }
    let caught: unknown;
    try { await packageBuild({ ...input, encryptionKey: KEY }); } catch (error) { caught = error; }
    expect(artifactRefusalCode(caught)).toBe("INVENTORY");
    const diagnostic = formatArtifactRefusal(caught);
    expect(diagnostic).toContain(`detail=${detail} `);
    expect(diagnostic).not.toContain(input.root);
    expect(diagnostic).not.toContain("private");
    expect(diagnostic).not.toContain(SECRET.toString());
    if (kind === "scope-alias") expect(diagnostic).toContain("alias=NAPI_SCOPE");
    if (kind === "alias-target") expect(diagnostic).toContain("target=ABSOLUTE");
    if (kind === "missing-package") expect(diagnostic).toContain("errno=MISSING");
    if (kind === "cache-link") expect(diagnostic).toContain("phase=CACHE");
    if (kind === "dev-link") expect(diagnostic).toContain("phase=DEV");
    await expect(stat(input.output)).rejects.toThrow();
  });

  it("uses only the safe diagnostic line in the actual CLI", async () => {
    const input = await fixture();
    await symlink("/private/secret-cli-target", path.join(input.root, ".next/cache"));
    const result = spawnSync(process.execPath, [path.resolve("scripts/package-local-qa-build.mjs")], {
      cwd: input.root, encoding: "utf8", env: { ...process.env, ...context, QA_ARTIFACT_ENCRYPTION_KEY: KEY, QA_BUILD_SERVICE_ROLE_KEY: SECRET.toString() },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^Local QA packaging refused \[INVENTORY\] detail=SYMLINK phase=CACHE kind=SYMLINK alias=UNKNOWN target=UNKNOWN errno=UNKNOWN visited=3 files=1 pathBytes=LE100\. No artifact is eligible for upload\.\n$/);
    expect(result.stderr).not.toContain(input.root);
    expect(result.stderr).not.toContain("private");
    expect(result.stderr).not.toContain(SECRET.toString());
    expect(result.stderr).not.toContain(KEY);
  });

  it("requires manual keeper context and an exact commit", () => {
    const env = context;
    expect(() => assertArtifactContext(env)).not.toThrow();
    expect(QA_KEEPER_REFS).toEqual([KEEPER_REF, 'refs/heads/agent/assistant-chrome-polish']);
    expect(() => assertArtifactContext({ ...env, GITHUB_REF: QA_KEEPER_REFS[1] })).not.toThrow();
    for (const patch of [{ GITHUB_EVENT_NAME: "push" }, { GITHUB_REF: "refs/heads/main" }, { GITHUB_REF: 'refs/heads/production' }, { GITHUB_SHA: "short" }, { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_RUN_ID: '' }, { GITHUB_RUN_ATTEMPT: '' }, { NEXT_PUBLIC_SUPABASE_URL: 'https://production.invalid' }, { NEXT_PUBLIC_APP_URL: 'http://localhost:3000' }]) {
      expect(() => assertArtifactContext({ ...env, ...patch })).toThrow();
    }
  });

  it("requires a valid encryption key and scans the explicit server-only inputs", () => {
    const values = configuredSecrets(SECRET.toString(), KEY);
    expect(values.map((value: Buffer) => value.toString())).toEqual([SECRET.toString(), KEY]);
    expect(() => configuredSecrets("")).toThrow();
    expect(() => encryptionKeyBytes("AB".repeat(32))).toThrow();
    expect(() => encryptionKeyBytes("ab".repeat(31))).toThrow();
    try {
      encryptionKeyBytes("invalid");
    } catch (error) {
      expect(artifactRefusalCode(error)).toBe("KEY_CONFIG");
    }
    expect(artifactRefusalCode(new Error("private path or secret"))).toBe("UNEXPECTED");
  });

  it("rejects secret bytes split across stream boundaries", async () => {
    await expect(scan([SECRET.subarray(0, 7), SECRET.subarray(7)])).rejects.toThrow("configured server-only secret");
    await expect(scan([Buffer.from("safe"), Buffer.from(" output")])).resolves.toBeUndefined();
  });

  it("round-trips a bounded encrypted archive without plaintext in the upload directory", async () => {
    const input = await fixture();
    await mkdir(path.join(input.root, ".next/cache"));
    await mkdir(path.join(input.root, ".next/dev"));
    await writeFile(path.join(input.root, ".next/cache/secret"), SECRET);
    await writeFile(path.join(input.root, ".next/dev/secret"), SECRET);
    const envelope = await packageBuild({ ...input, encryptionKey: KEY });
    const ciphertext = await readFile(path.join(input.output, "next-build.tar.gz.enc"));
    expect(envelope.githubSha).toBe(SHA);
    expect(envelope.ciphertextSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.ciphertextBytes).toBe(ciphertext.length);
    expect(await readdir(input.output)).toEqual(["manifest.json", "next-build.tar.gz.enc"]);
    expect(ciphertext.includes(Buffer.from("module.exports"))).toBe(false);
    expect(JSON.stringify(envelope)).not.toContain("page.js");

    const decrypted = path.join(input.root, "private", "next-build.tar.gz");
    await decryptArtifact({ artifactDir: input.output, sha: SHA, encryptionKey: KEY, output: decrypted });
    const entries = execFileSync("tar", ["-tzf", decrypted], { encoding: "utf8" }).trim().split("\n");
    expect(entries.sort()).toEqual([".next/BUILD_ID", ".next/required-server-files.json", ".next/server/page.js", "qa-manifest.json"]);
    const privateManifest = JSON.parse(execFileSync("tar", ["-xOf", decrypted, "qa-manifest.json"], { encoding: "utf8" }));
    expect(privateManifest).toMatchObject({ githubSha: SHA, fileBytes: expect.any(Number), fileCount: 3, runtime: { port: 3010, database: "dev/test" } });
    expect(privateManifest).toMatchObject({ provenance: { repository: 'PrakritR/PropLane', ref: KEEPER_REF, runId: '123', attempt: '1' }, nodeMajor: 22, nextVersion: '16.0.0', lockfileSha256: expect.stringMatching(/^[a-f0-9]{64}$/), target: { supabaseUrl: context.NEXT_PUBLIC_SUPABASE_URL, origin: context.NEXT_PUBLIC_APP_URL, anonKeySha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(privateManifest.immutableFiles).toHaveLength(3);
    expect(privateManifest.immutableFiles.every((file: { sha256: string; bytes: number }) => /^[a-f0-9]{64}$/.test(file.sha256) && Number.isSafeInteger(file.bytes))).toBe(true);
    expect(JSON.parse(await readFile(path.join(input.output, "manifest.json"), "utf8"))).toEqual(envelope);
  });

  it.each([["pg"], ["sharp"], ["@napi-rs/canvas"], ["pg", "sharp", "@napi-rs/canvas"]])("round trips closed aliases %j without archiving their tree", async (...packages) => {
    const input = await fixture();
    const records = await addAliases(input.root, packages);
    await packageBuild({ ...input, encryptionKey: KEY });
    const archive = path.join(input.root, "private/build.tar.gz");
    await decryptArtifact({ artifactDir: input.output, sha: SHA, encryptionKey: KEY, output: archive });
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
    expect(entries.every((entry) => !entry.includes('node_modules'))).toBe(true);
    const privateManifest = JSON.parse(execFileSync("tar", ["-xOf", archive, "qa-manifest.json"], { encoding: "utf8" }));
    expect(privateManifest.runtimeAliases).toEqual(expect.arrayContaining(records));
    expect(privateManifest.runtimeAliases).toHaveLength(packages.length);
    await rm(path.join(input.root, '.next/node_modules'), { recursive: true });
    await expect(restoreRuntimeAliases({ root: input.root, privateManifest })).resolves.toBe(packages.length);
    for (const record of records) expect(await readlink(path.join(input.root, record.path))).toBe(record.target);
  });

  it("rejects unknown or retargeted Next.js runtime aliases", async () => {
    for (const [name, target] of [["other-0123456789abcdef", "../../node_modules/other"], ["pg-0123456789abcdef", "../../node_modules/sharp"]]) {
      const input = await fixture();
      await mkdir(path.join(input.root, ".next/node_modules"));
      await symlink(target, path.join(input.root, ".next/node_modules", name), "dir");
      await expect(packageBuild({ ...input, encryptionKey: KEY })).rejects.toThrow("runtime alias");
      await expect(stat(input.output)).rejects.toThrow();
    }
  });

  it("rejects duplicate aliases for one runtime package before publishing", async () => {
    const input = await fixture();
    const version = "8.22.0";
    await mkdir(path.join(input.root, ".next/node_modules"));
    await mkdir(path.join(input.root, "node_modules/pg"), { recursive: true });
    await writeFile(path.join(input.root, "node_modules/pg/package.json"), JSON.stringify({ name: "pg", version }));
    await writeFile(path.join(input.root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/pg": { version } } }));
    await symlink("../../node_modules/pg", path.join(input.root, ".next/node_modules/pg-0123456789abcdef"), "dir");
    await symlink("../../node_modules/pg", path.join(input.root, ".next/node_modules/pg-fedcba9876543210"), "dir");
    await expect(packageBuild({ ...input, encryptionKey: KEY })).rejects.toThrow("Duplicate Next.js runtime alias");
    await expect(stat(input.output)).rejects.toThrow();
  });

  it('validates every record before restoration writes, including duplicates and strict fields', async () => {
    const input = await fixture(), [record] = await addAliases(input.root, ['@napi-rs/canvas']);
    await rm(path.join(input.root, '.next/node_modules'), { recursive: true });
    const malformed = [
      [{ ...record, extra: true }], [{ ...record, version: '' }], [{ ...record, package: '@other/canvas' }],
      [{ ...record, path: record.path.toUpperCase() }], [{ ...record, path: record.path + 'a' }], [{ ...record, path: record.path + '\n' }],
      [{ ...record, path: record.path + '/nested' }], [{ ...record, path: record.path.replace('@napi-rs/', '') }],
      [{ ...record, path: '/'+record.path }], [{ ...record, path: record.path.replace('/', '\\') }],
      [{ ...record, target: '../../../node_modules/@napi-rs/./canvas' }], [record, record],
      [record, { ...record, path: record.path.replace('0123456789abcdef', 'fedcba9876543210') }],
      [record, record, record, record], [record, null], Array(1),
    ];
    expect(validateRuntimeAliases([])).toEqual([]);
    for (const runtimeAliases of malformed) {
      expect(() => validateRuntimeAliases(runtimeAliases)).toThrow();
      await expect(restoreRuntimeAliases({ root: input.root, privateManifest: { runtimeAliases } })).rejects.toThrow();
      await expect(lstat(path.join(input.root, '.next/node_modules'))).rejects.toThrow();
    }
  });

  it.each(['empty', 'sibling', 'duplicate', 'nested', 'uppercase', 'short', 'scope-link', 'leaf-file', 'leaf-directory', 'absolute', 'escaping', 'deep', 'wrong-package', 'equivalent', 'alias-root', 'dependency-root', 'dependency-scope', 'dependency-leaf', 'metadata-link', 'metadata-hardlink', 'lock-link', 'lock-hardlink', 'missing', 'wrong-name', 'wrong-version', 'wrong-lock'])('refuses canvas %s before publishing', async (kind) => {
    const input = await fixture(), [record] = await addAliases(input.root, ['@napi-rs/canvas']);
    const leaf = path.join(input.root, record.path), scope = path.dirname(leaf), dependency = path.join(input.root, 'node_modules/@napi-rs/canvas');
    if (['empty', 'nested', 'uppercase', 'short', 'leaf-file', 'leaf-directory', 'absolute', 'escaping', 'deep', 'wrong-package', 'equivalent'].includes(kind)) await rm(leaf);
    if (kind === 'sibling') await symlink(record.target, path.join(scope, 'other-0123456789abcdef'));
    if (kind === 'duplicate') await symlink(record.target, path.join(scope, 'canvas-fedcba9876543210'));
    if (kind === 'nested') await mkdir(path.join(leaf, 'nested'), { recursive: true });
    if (kind === 'uppercase' || kind === 'short') await symlink(record.target, kind === 'uppercase' ? path.join(scope, 'canvas-0123456789ABCDEF') : leaf.slice(0, -1));
    if (kind === 'leaf-file') await writeFile(leaf, 'data');
    if (kind === 'leaf-directory') await mkdir(leaf);
    const targets: Record<string, string> = { absolute: dependency, escaping: '../../../../outside', deep: '../../../../node_modules/@napi-rs/canvas', 'wrong-package': '../../../node_modules/pg', equivalent: '../../../node_modules/@napi-rs/./canvas' };
    if (targets[kind]) await symlink(targets[kind], leaf);
    const parents: Record<string, string> = { 'scope-link': scope, 'alias-root': path.join(input.root, '.next/node_modules'), 'dependency-root': path.join(input.root, 'node_modules'), 'dependency-scope': path.dirname(dependency), 'dependency-leaf': dependency };
    if (parents[kind]) { await rename(parents[kind], parents[kind] + '-real'); await symlink(parents[kind] + '-real', parents[kind]); }
    const metadata = kind.startsWith('lock-') ? path.join(input.root, 'package-lock.json') : path.join(dependency, 'package.json');
    if (kind.endsWith('-link') && !parents[kind]) { await rename(metadata, metadata + '-real'); await symlink(metadata + '-real', metadata); }
    if (kind.endsWith('-hardlink')) await link(metadata, metadata + '-other');
    if (kind === 'missing') await rm(dependency, { recursive: true });
    if (kind === 'wrong-name' || kind === 'wrong-version') await writeFile(path.join(dependency, 'package.json'), JSON.stringify({ name: kind === 'wrong-name' ? 'pg' : record.package, version: kind === 'wrong-version' ? 'different' : record.version }));
    if (kind === 'wrong-lock') await writeFile(path.join(input.root, 'package-lock.json'), '{}');
    await expect(packageBuild({ ...input, encryptionKey: KEY })).rejects.toThrow();
    await expect(lstat(input.output)).rejects.toThrow();
  });

  it.each(['.next/node_modules', '.next/node_modules/@napi-rs', 'node_modules', 'node_modules/@napi-rs', 'node_modules/@napi-rs/canvas'])('restoration refuses linked parent %s without following it', async (relative) => {
    const input = await fixture(), records = await addAliases(input.root, ['@napi-rs/canvas']);
    await rm(path.join(input.root, records[0].path));
    const parent = path.join(input.root, relative);
    await rename(parent, parent + '-real'); await symlink(parent + '-real', parent);
    await expect(restoreRuntimeAliases({ root: input.root, privateManifest: { runtimeAliases: records } })).rejects.toThrow();
    expect((await lstat(parent)).isSymbolicLink()).toBe(true);
    await expect(lstat(path.join(input.root, records[0].path))).rejects.toThrow();
  });

  it.each(['file', 'link', 'directory'])('preserves an existing alias destination %s', async (kind) => {
    const input = await fixture(), [record] = await addAliases(input.root, ['@napi-rs/canvas']);
    const leaf = path.join(input.root, record.path); await rm(leaf);
    if (kind === 'file') await writeFile(leaf, 'keep');
    if (kind === 'link') await symlink('keep-target', leaf);
    if (kind === 'directory') await mkdir(leaf);
    const before = await lstat(leaf);
    await expect(restoreRuntimeAliases({ root: input.root, privateManifest: { runtimeAliases: [record] } })).rejects.toThrow();
    expect((await lstat(leaf)).ino).toBe(before.ino);
  });

  it.each([false, true])('rolls back created links and scoped parents on later failure; existing root=%s', async (existing) => {
    const input = await fixture(), records = await addAliases(input.root, ['@napi-rs/canvas', 'pg']);
    await rm(path.join(input.root, '.next/node_modules'), { recursive: true });
    if (existing) await mkdir(path.join(input.root, '.next/node_modules'));
    restoreFault.remaining = 2;
    await expect(restoreRuntimeAliases({ root: input.root, privateManifest: { runtimeAliases: records } })).rejects.toThrow('simulated');
    if (existing) expect(await readdir(path.join(input.root, '.next/node_modules'))).toEqual([]);
    else await expect(lstat(path.join(input.root, '.next/node_modules'))).rejects.toThrow();
    expect(await readFile(path.join(input.root, '.next/BUILD_ID'), 'utf8')).toBe('build-id');
  });

  it("rejects leaked secrets without publishing output", async () => {
    const input = await fixture();
    await writeFile(path.join(input.root, ".next/server/page.js"), SECRET);
    await expect(packageBuild({ ...input, encryptionKey: KEY })).rejects.toThrow("configured server-only secret");
    await expect(stat(input.output)).rejects.toThrow();
  });

  it("scans the encryption key and cleans up failed decryptions", async () => {
    const input = await fixture();
    await expect(packageBuild(input)).rejects.toThrow("encryption key");
    const keyFile = path.join(input.root, ".next/server/page.js");
    await writeFile(keyFile, KEY);
    await expect(packageBuild({ ...input, encryptionKey: KEY })).rejects.toThrow("configured server-only secret");
    await writeFile(keyFile, "module.exports = 'clean';");
    const cleanOutput = path.join(input.root, "clean-artifact");
    await packageBuild({ ...input, encryptionKey: KEY, output: cleanOutput });
    const decrypted = path.join(input.root, "private", "wrong.tar.gz");
    await expect(decryptArtifact({ artifactDir: cleanOutput, sha: SHA, encryptionKey: WRONG_KEY, output: decrypted })).rejects.toThrow();
    await expect(stat(decrypted)).rejects.toThrow();
    const existing = path.join(input.root, "private", "existing.tar.gz");
    await mkdir(path.dirname(existing), { recursive: true });
    await writeFile(existing, "keep");
    await expect(decryptArtifact({ artifactDir: cleanOutput, sha: SHA, encryptionKey: WRONG_KEY, output: existing })).rejects.toThrow();
    expect(await readFile(existing, "utf8")).toBe("keep");
  });

  it.each(["ciphertext", "tag", "aad"])("rejects %s tampering before extraction", async (kind) => {
    const input = await fixture();
    await packageBuild({ ...input, encryptionKey: KEY });
    const envelopePath = path.join(input.output, "manifest.json");
    const envelope = JSON.parse(await readFile(envelopePath, "utf8"));
    if (kind === "ciphertext") {
      const bytes = await readFile(path.join(input.output, "next-build.tar.gz.enc"));
      bytes[0] ^= 1;
      await writeFile(path.join(input.output, "next-build.tar.gz.enc"), bytes);
    } else if (kind === "tag") {
      envelope.authTag = `${envelope.authTag.slice(0, -1)}${envelope.authTag.endsWith("0") ? "1" : "0"}`;
      await writeFile(envelopePath, `${JSON.stringify(envelope)}\n`);
    } else {
      envelope.githubSha = "b".repeat(40);
      await writeFile(envelopePath, `${JSON.stringify(envelope)}\n`);
    }
    const decrypted = path.join(input.root, "private", `${kind}.tar.gz`);
    await expect(decryptArtifact({ artifactDir: input.output, sha: kind === "aad" ? "b".repeat(40) : SHA, encryptionKey: KEY, output: decrypted })).rejects.toThrow();
    await expect(stat(decrypted)).rejects.toThrow();
  });

  it.each(["symlink", "env", "control-path"])("rejects %s input", async (kind) => {
    const input = await fixture();
    if (kind === "symlink") await symlink("page.js", path.join(input.root, ".next/server/link"));
    else await writeFile(path.join(input.root, ".next/server", kind === "env" ? ".env.local" : "bad\nname"), "bad");
    try {
      await packageBuild({ ...input, encryptionKey: KEY });
      throw new Error("expected packaging refusal");
    } catch (error) {
      expect(artifactRefusalCode(error)).toBe("INVENTORY");
    }
    await expect(stat(input.output)).rejects.toThrow();
  });

  it.each([
    { maxBytes: 10, detail: "SOURCE_BYTES", limit: 10 },
    { maxBytes: 100, detail: "TAR_BYTES", limit: 100 },
    { maxArchive: 10, detail: "GZIP_BYTES", limit: 10 },
  ])("diagnoses $detail and removes partial output", async ({ detail, limit, ...bounds }) => {
    const input = await fixture();
    const error = await packageBuild({ ...input, encryptionKey: KEY, ...bounds }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ArtifactRefusal);
    const diagnostic = formatArtifactRefusal(error);
    expect(diagnostic).toMatch(new RegExp(`\\[ARCHIVE\\] detail=${detail} bytes=[0-9]+ limit=${limit} exitCode=UNKNOWN signal=UNKNOWN`));
    expect(diagnostic).not.toContain(input.root);
    await expect(stat(input.output)).rejects.toThrow();
  });

  it.each([
    { maxBytes: MAX_BYTES + 1 }, { maxBytes: Number.MAX_SAFE_INTEGER + 1 }, { maxBytes: 0 },
    { maxArchive: MAX_ARCHIVE + 1 }, { maxArchive: 0 }, { maxArchive: 1.5 },
  ])("refuses configured limits above shared ceilings or unsafe values: %j", async (bounds) => {
    const input = await fixture();
    const error = await packageBuild({ ...input, encryptionKey: KEY, ...bounds }).catch((error: unknown) => error);
    expect(artifactRefusalCode(error)).toBe("PACKAGE_CONFIG");
    await expect(stat(input.output)).rejects.toThrow();
  });

  it("enforces the complete raw tar boundary including manifest, padding and footer", async () => {
    const input = await fixture();
    await packageBuild({ ...input, encryptionKey: KEY });
    const archive = path.join(input.root, "boundary.tar.gz");
    await decryptArtifact({ artifactDir: input.output, sha: SHA, encryptionKey: KEY, output: archive });
    const rawBytes = gunzipSync(await readFile(archive)).length;
    await rm(input.output, { recursive: true });
    await expect(packageBuild({ ...input, encryptionKey: KEY, maxBytes: rawBytes })).resolves.toBeDefined();
    await rm(input.output, { recursive: true });
    const error = await packageBuild({ ...input, encryptionKey: KEY, maxBytes: rawBytes - 1 }).catch((error: unknown) => error);
    expect(formatArtifactRefusal(error)).toContain(`detail=TAR_BYTES bytes=${rawBytes} limit=${rawBytes - 1}`);
    await expect(stat(input.output)).rejects.toThrow();
  });

  it("refuses to replace existing output and requires completed build markers", async () => {
    const input = await fixture();
    await mkdir(input.output);
    await writeFile(path.join(input.output, "owned"), "keep");
    await expect(packageBuild({ ...input, encryptionKey: KEY })).rejects.toThrow();
    expect(await readFile(path.join(input.output, "owned"), "utf8")).toBe("keep");
    await rm(path.join(input.root, ".next/BUILD_ID"));
    await expect(packageBuild({ ...input, encryptionKey: KEY, output: path.join(input.root, "new-output") })).rejects.toThrow("markers");
  });

  it("uploads only after successful manual keeper builds without changing required checks", async () => {
    const workflow = parse(await readFile(".github/workflows/test.yml", "utf8"));
    const steps = workflow.jobs.build.steps;
    const buildIndex = steps.findIndex((step: { run?: string }) => step.run === "bash scripts/ci-observe-build.sh");
    const packageIndex = steps.findIndex((step: { run?: string }) => step.run === "node scripts/package-local-qa-build.mjs");
    const upload = steps[packageIndex + 1];
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(packageIndex).toBeGreaterThan(buildIndex);
    const gate = "success() && github.event_name == 'workflow_dispatch' && (github.ref == 'refs/heads/akhil/test-workspace-release-20260919' || github.ref == 'refs/heads/agent/assistant-chrome-polish')";
    expect(steps[packageIndex].if).toBe(gate);
    expect(upload.if).toBe(gate);
    expect(upload.uses).toBe("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(upload.with["retention-days"]).toBe(1);
    expect(upload.with["if-no-files-found"]).toBe("error");
    expect(upload.with.name).toBe("local-qa-build-${{ github.sha }}");
    expect(steps[packageIndex].env).toEqual({
      QA_BUILD_SERVICE_ROLE_KEY: "${{ secrets.TEST_SUPABASE_SERVICE_ROLE_KEY }}",
      QA_ARTIFACT_ENCRYPTION_KEY: "${{ secrets.PROPLANE_LOCAL_QA_ARTIFACT_KEY }}",
      NEXT_PUBLIC_SUPABASE_URL: "${{ secrets.TEST_SUPABASE_URL }}",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "${{ secrets.TEST_SUPABASE_ANON_KEY }}",
    });
    expect(JSON.stringify(steps[packageIndex])).not.toContain("toJSON(secrets)");
    expect(JSON.stringify(steps[packageIndex])).not.toContain("QA_REPOSITORY_PRIVATE");
    expect(workflow.jobs.check.needs).toEqual(["unit", "lint", "build"]);
    for (const job of ['unit', 'lint', 'integration', 'e2e-full', 'check']) {
      expect(workflow.jobs[job].if).not.toContain('agent/assistant-chrome-polish');
    }
    const recovery = workflow.jobs['e2e-full'].steps.find((step: { name?: string }) => step.name === 'Upload encrypted signup reconciliation');
    expect(recovery.with['retention-days']).toBe(14);
    const browser = workflow.jobs['e2e-full'].steps.find((step: { with?: { name?: string } }) => step.with?.name === 'e2e-full-test-results');
    expect(browser.with['retention-days']).toBe(5);
  });
});
