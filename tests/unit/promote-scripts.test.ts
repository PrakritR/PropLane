import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const integrateScript = readFileSync(
  "scripts/integrate-source-to-main-and-staging.sh",
  "utf8",
);

const directProductionPolicy = {
  version: 1,
  kind: "temporary-direct-production-release",
  authorizedDeveloper: "Akhil",
  source: "origin/main",
  target: "origin/production",
  expiresAt: "2026-09-15T04:00:00Z",
};

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function writePromotionFixture(policy = directProductionPolicy) {
  const root = mkdtempSync(join(tmpdir(), "proplane-promote-"));
  const remote = join(root, "origin.git");
  const repo = join(root, "repo");
  git(root, ["init", "--bare", remote]);
  git(root, ["clone", remote, repo]);
  git(repo, ["config", "user.email", "tests@prop-lane.space"]);
  git(repo, ["config", "user.name", "Promotion test"]);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { "ship:preflight": "true" } }));
  writeFileSync(join(repo, "README.md"), "base\\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["branch", "-M", "main"]);
  git(repo, ["push", "origin", "main"]);
  git(repo, ["branch", "production"]);
  git(repo, ["push", "origin", "production"]);
  git(repo, ["branch", "staging"]);
  git(repo, ["push", "origin", "staging"]);

  git(repo, ["checkout", "main"]);
  writeFileSync(join(repo, "main.txt"), "main candidate\\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "main candidate"]);
  git(repo, ["push", "origin", "main"]);

  git(repo, ["checkout", "staging"]);
  writeFileSync(join(repo, "staging.txt"), "staging candidate\\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "staging candidate"]);
  git(repo, ["push", "origin", "staging"]);

  mkdirSync(join(repo, "scripts"));
  mkdirSync(join(repo, "docs", "agents"), { recursive: true });
  cpSync("scripts/promote-staging-to-production.sh", join(repo, "scripts", "promote-staging-to-production.sh"));
  writeFileSync(join(repo, "docs", "agents", "temporary-direct-production-policy.json"), `${JSON.stringify(policy)}\\n`);
  return { root, repo };
}

function runPromotion(repo: string, ...args: string[]) {
  return spawnSync("bash", ["scripts/promote-staging-to-production.sh", ...args], {
    cwd: repo,
    encoding: "utf8",
  });
}

function remoteRef(repo: string, ref: string) {
  return execFileSync("git", ["rev-parse", ref], { cwd: repo, encoding: "utf8" }).trim();
}

describe("promote scripts", () => {
  it("ships integrate via npm and chains main → staging", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["ship:integrate"]).toBe(
      "bash scripts/integrate-source-to-main-and-staging.sh",
    );
    expect(integrateScript).toMatch(/promote-main-to-staging\.sh/);
    expect(integrateScript).toMatch(/--source/);
  });

  it("refuses the retired main → production shortcut", () => {
    try {
      execFileSync("bash", ["scripts/promote-main-to-production.sh"], { stdio: "pipe" });
      expect.fail("retired promote script should exit 1");
    } catch (error) {
      const err = error as { status?: number; stderr?: Buffer };
      expect(err.status).toBe(1);
      expect(String(err.stderr)).toMatch(/staging/i);
    }
  });

  it("deploys staging and production while keeping main local", () => {
    const raw = readFileSync("vercel.json", "utf8");
    const config = JSON.parse(raw) as {
      git?: { deploymentEnabled?: Record<string, boolean> };
    };
    expect(config.git?.deploymentEnabled).toEqual({
      "**": false,
      main: false,
      staging: true,
      production: true,
    });
  });

  it("defaults to the staging candidate", () => {
    const fixture = writePromotionFixture();
    try {
      const result = runPromotion(fixture.repo);
      expect(result.status).toBe(0);
      expect(remoteRef(fixture.repo, "origin/production")).toBe(remoteRef(fixture.repo, "origin/staging"));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("selects main only with the explicit temporary exception", () => {
    const fixture = writePromotionFixture();
    try {
      expect(readFileSync(join(fixture.repo, "docs", "agents", "temporary-direct-production-policy.json"), "utf8")).toContain("temporary-direct-production-release");
      const result = runPromotion(fixture.repo, "--skip-staging");
      expect(result.status, result.stderr).toBe(0);
      expect(remoteRef(fixture.repo, "origin/production")).toBe(remoteRef(fixture.repo, "origin/main"));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed for a missing, malformed, or expired direct-release policy", () => {
    const cases: Array<{ name: string; policy?: unknown }> = [
      { name: "missing", policy: undefined },
      { name: "malformed", policy: { ...directProductionPolicy, target: "origin/main" } },
      { name: "expired at the fixed authorization boundary", policy: { ...directProductionPolicy, expiresAt: "2026-09-15T04:00:00.001Z" } },
    ];

    for (const testCase of cases) {
      const fixture = writePromotionFixture(testCase.policy ?? directProductionPolicy);
      try {
        const policyPath = join(fixture.repo, "docs", "agents", "temporary-direct-production-policy.json");
        if (testCase.policy === undefined) rmSync(policyPath);
        const result = runPromotion(fixture.repo, "--skip-staging");
        expect(result.status, testCase.name).toBe(1);
        expect(result.stderr, testCase.name).toMatch(/policy|authorization/i);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it("rejects unexpected arguments before mutating refs", () => {
    const fixture = writePromotionFixture();
    try {
      const before = remoteRef(fixture.repo, "origin/production");
      const result = runPromotion(fixture.repo, "--skip-staging", "--now=never");
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/usage/i);
      expect(remoteRef(fixture.repo, "origin/production")).toBe(before);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses a non-fast-forward candidate", () => {
    const fixture = writePromotionFixture();
    try {
      git(fixture.repo, ["checkout", "production"]);
      writeFileSync(join(fixture.repo, "production-only.txt"), "diverged\\n");
      git(fixture.repo, ["add", "."]);
      git(fixture.repo, ["commit", "-m", "production-only"]);
      git(fixture.repo, ["push", "origin", "production"]);
      const result = runPromotion(fixture.repo);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/not an ancestor/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
