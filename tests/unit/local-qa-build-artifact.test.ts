import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { assertArtifactContext, configuredSecrets, encryptionKeyBytes, KEEPER_REF, packageBuild, secretScanner } from "../../scripts/package-local-qa-build.mjs";
import { decryptArtifact } from "../../scripts/decrypt-local-qa-build.mjs";

const SHA = "a".repeat(40);
const SECRET = Buffer.from("server-secret-fixture-only");
const KEY = "ab".repeat(32);
const WRONG_KEY = "cd".repeat(32);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "qa-artifact-test-"));
  roots.push(root);
  await mkdir(path.join(root, ".next/server"), { recursive: true });
  await writeFile(path.join(root, ".next/BUILD_ID"), "build-id");
  await writeFile(path.join(root, ".next/required-server-files.json"), "{}");
  await writeFile(path.join(root, ".next/server/page.js"), "module.exports = 'clean';");
  return { root, output: path.join(root, "artifact"), sha: SHA, secrets: [SECRET] };
}

function scan(chunks: Buffer[]) {
  return pipeline(Readable.from(chunks), secretScanner([SECRET]), new Writable({ write(_chunk, _encoding, done) { done(); } }));
}

describe("encrypted local QA build transport", () => {
  it("requires manual keeper context and an exact commit", () => {
    const env = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: KEEPER_REF, GITHUB_SHA: SHA };
    expect(() => assertArtifactContext(env)).not.toThrow();
    for (const patch of [{ GITHUB_EVENT_NAME: "push" }, { GITHUB_REF: "refs/heads/main" }, { GITHUB_SHA: "short" }]) {
      expect(() => assertArtifactContext({ ...env, ...patch })).toThrow();
    }
  });

  it("requires a valid encryption key and scans the explicit server-only inputs", () => {
    const values = configuredSecrets(SECRET.toString(), KEY);
    expect(values.map((value: Buffer) => value.toString())).toEqual([SECRET.toString(), KEY]);
    expect(() => configuredSecrets("")).toThrow();
    expect(() => encryptionKeyBytes("AB".repeat(32))).toThrow();
    expect(() => encryptionKeyBytes("ab".repeat(31))).toThrow();
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
    expect(JSON.parse(await readFile(path.join(input.output, "manifest.json"), "utf8"))).toEqual(envelope);
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
    await expect(packageBuild({ ...input, encryptionKey: KEY })).rejects.toThrow();
    await expect(stat(input.output)).rejects.toThrow();
  });

  it("enforces both expansion and compressed bounds and removes partial output", async () => {
    const input = await fixture();
    await expect(packageBuild({ ...input, encryptionKey: KEY, maxBytes: 10 })).rejects.toThrow("byte limit");
    await expect(stat(input.output)).rejects.toThrow();
    await expect(packageBuild({ ...input, encryptionKey: KEY, maxArchive: 10 })).rejects.toThrow("byte limit");
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
    const buildIndex = steps.findIndex((step: { run?: string }) => step.run === "npm run build");
    const packageIndex = steps.findIndex((step: { run?: string }) => step.run === "node scripts/package-local-qa-build.mjs");
    const upload = steps[packageIndex + 1];
    expect(packageIndex).toBeGreaterThan(buildIndex);
    const gate = "success() && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/akhil/test-workspace-release-20260919'";
    expect(steps[packageIndex].if).toBe(gate);
    expect(upload.if).toBe(gate);
    expect(upload.uses).toBe("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(upload.with["retention-days"]).toBe(1);
    expect(upload.with["if-no-files-found"]).toBe("error");
    expect(upload.with.name).toBe("local-qa-build-${{ github.sha }}");
    expect(steps[packageIndex].env).toEqual({
      QA_BUILD_SERVICE_ROLE_KEY: "${{ secrets.TEST_SUPABASE_SERVICE_ROLE_KEY }}",
      QA_ARTIFACT_ENCRYPTION_KEY: "${{ secrets.PROPLANE_LOCAL_QA_ARTIFACT_KEY }}",
    });
    expect(JSON.stringify(steps[packageIndex])).not.toContain("toJSON(secrets)");
    expect(JSON.stringify(steps[packageIndex])).not.toContain("QA_REPOSITORY_PRIVATE");
    expect(workflow.jobs.check.needs).toEqual(["unit", "lint", "build"]);
  });
});
