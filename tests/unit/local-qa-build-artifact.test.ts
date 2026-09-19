import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { assertArtifactContext, configuredSecrets, KEEPER_REF, packageBuild, secretScanner } from "../../scripts/package-local-qa-build.mjs";

const SHA = "a".repeat(40);
const SECRET = Buffer.from("server-secret-fixture-only");
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

describe("private local QA build transport", () => {
  it("requires private manual keeper context and an exact commit", () => {
    const env = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: KEEPER_REF, QA_REPOSITORY_PRIVATE: "true", GITHUB_SHA: SHA };
    expect(() => assertArtifactContext(env)).not.toThrow();
    for (const patch of [{ GITHUB_EVENT_NAME: "push" }, { GITHUB_REF: "refs/heads/main" }, { QA_REPOSITORY_PRIVATE: "false" }, { GITHUB_SHA: "short" }]) {
      expect(() => assertArtifactContext({ ...env, ...patch })).toThrow();
    }
  });

  it("scans the build's explicit server-only input without importing unrelated repository secrets", () => {
    const values = configuredSecrets(SECRET.toString());
    expect(values.map((value: Buffer) => value.toString())).toEqual([SECRET.toString()]);
    expect(() => configuredSecrets("")).toThrow();
  });

  it("rejects secret bytes split across stream boundaries", async () => {
    await expect(scan([SECRET.subarray(0, 7), SECRET.subarray(7)])).rejects.toThrow("configured server-only secret");
    await expect(scan([Buffer.from("safe"), Buffer.from(" output")])).resolves.toBeUndefined();
  });

  it("packages only production files with exact SHA, digest and sizes", async () => {
    const input = await fixture();
    await mkdir(path.join(input.root, ".next/cache"));
    await mkdir(path.join(input.root, ".next/dev"));
    await writeFile(path.join(input.root, ".next/cache/secret"), SECRET);
    await writeFile(path.join(input.root, ".next/dev/secret"), SECRET);
    const manifest = await packageBuild(input);
    const archive = await readFile(path.join(input.output, manifest.archive));
    expect(manifest.githubSha).toBe(SHA);
    expect(manifest.sha256).toBe(createHash("sha256").update(archive).digest("hex"));
    expect(manifest.archiveBytes).toBe(archive.length);
    expect(manifest.uncompressedTarBytes).toBeGreaterThan(manifest.fileBytes);
    expect(manifest.fileCount).toBe(3);
    const entries = execFileSync("tar", ["-tzf", path.join(input.output, manifest.archive)], { encoding: "utf8" }).trim().split("\n");
    expect(entries.sort()).toEqual([".next/BUILD_ID", ".next/required-server-files.json", ".next/server/page.js"]);
    expect(JSON.parse(await readFile(path.join(input.output, "manifest.json"), "utf8"))).toEqual(manifest);
  });

  it("rejects leaked secrets without publishing output", async () => {
    const input = await fixture();
    await writeFile(path.join(input.root, ".next/server/page.js"), SECRET);
    await expect(packageBuild(input)).rejects.toThrow("configured server-only secret");
    await expect(stat(input.output)).rejects.toThrow();
  });

  it.each(["symlink", "env", "control-path"])("rejects %s input", async (kind) => {
    const input = await fixture();
    if (kind === "symlink") await symlink("page.js", path.join(input.root, ".next/server/link"));
    else await writeFile(path.join(input.root, ".next/server", kind === "env" ? ".env.local" : "bad\nname"), "bad");
    await expect(packageBuild(input)).rejects.toThrow();
    await expect(stat(input.output)).rejects.toThrow();
  });

  it("enforces both expansion and compressed bounds and removes partial output", async () => {
    const input = await fixture();
    await expect(packageBuild({ ...input, maxBytes: 10 })).rejects.toThrow("byte limit");
    await expect(stat(input.output)).rejects.toThrow();
    await expect(packageBuild({ ...input, maxArchive: 10 })).rejects.toThrow("byte limit");
    await expect(stat(input.output)).rejects.toThrow();
  });

  it("refuses to replace existing output and requires completed build markers", async () => {
    const input = await fixture();
    await mkdir(input.output);
    await writeFile(path.join(input.output, "owned"), "keep");
    await expect(packageBuild(input)).rejects.toThrow();
    expect(await readFile(path.join(input.output, "owned"), "utf8")).toBe("keep");
    await rm(path.join(input.root, ".next/BUILD_ID"));
    await expect(packageBuild({ ...input, output: path.join(input.root, "new-output") })).rejects.toThrow("markers");
  });

  it("uploads only after successful manual private keeper builds without changing required checks", async () => {
    const workflow = parse(await readFile(".github/workflows/test.yml", "utf8"));
    const steps = workflow.jobs.build.steps;
    const buildIndex = steps.findIndex((step: { run?: string }) => step.run === "npm run build");
    const packageIndex = steps.findIndex((step: { run?: string }) => step.run === "node scripts/package-local-qa-build.mjs");
    const upload = steps[packageIndex + 1];
    expect(packageIndex).toBeGreaterThan(buildIndex);
    const gate = "success() && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/akhil/test-workspace-release-20260919' && github.event.repository.private";
    expect(steps[packageIndex].if).toBe(gate);
    expect(upload.if).toBe(gate);
    expect(upload.uses).toBe("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(upload.with["retention-days"]).toBe(1);
    expect(upload.with["if-no-files-found"]).toBe("error");
    expect(upload.with.name).toBe("local-qa-build-${{ github.sha }}");
    expect(steps[packageIndex].env).toEqual({
      QA_REPOSITORY_PRIVATE: "${{ github.event.repository.private }}",
      QA_BUILD_SERVICE_ROLE_KEY: "${{ secrets.TEST_SUPABASE_SERVICE_ROLE_KEY }}",
    });
    expect(JSON.stringify(steps[packageIndex])).not.toContain("toJSON(secrets)");
    expect(workflow.jobs.check.needs).toEqual(["unit", "lint", "build"]);
  });
});
