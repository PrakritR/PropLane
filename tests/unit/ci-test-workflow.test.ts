import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.resolve(__dirname, "../..");
const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/test.yml"), "utf8");
const playwrightConfig = fs.readFileSync(path.join(ROOT, "playwright.config.ts"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

type WorkflowStep = {
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
};
type WorkflowJob = {
  "runs-on": string;
  "timeout-minutes"?: number;
  if?: string;
  needs?: string[];
  steps: WorkflowStep[];
};
const jobs = (parse(workflow) as { jobs: Record<string, WorkflowJob> }).jobs;
const UPLOAD_ARTIFACT = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";

// Parse active YAML: comments cannot satisfy a gate, and all upload requirements
// must belong to the same executable step in the same job.
function jobConfig(name: string): WorkflowJob {
  expect(jobs[name], `job ${name} not found`).toBeDefined();
  return jobs[name];
}

function hasRecoverableDiagnostics(steps: WorkflowStep[]): boolean {
  return steps.some((step) => step.uses === UPLOAD_ARTIFACT &&
    step.if === "always()" && step.with?.path === "test-results/");
}

function jobTimeoutMinutes(name: string): number {
  const timeout = jobConfig(name)["timeout-minutes"];
  expect(timeout, `job ${name} has no numeric timeout-minutes`).toBeTypeOf("number");
  return timeout!;
}

describe("Test workflow resource budget", () => {
  it("keeps the main E2E gate a bounded smoke", () => {
    expect(pkg.scripts["test:e2e:smoke"]).toContain("--no-deps");
    expect(pkg.scripts["test:e2e:smoke"]).toContain("public-tours.spec.ts");

    const e2e = jobConfig("e2e");
    // The deploy ladder added a staging rung, so the bounded smoke now also
    // guards pushes to staging. Still bounded — still not the full suite.
    expect(e2e.if).toBe("github.event_name == 'push' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/staging')");
    expect(jobTimeoutMinutes("e2e")).toBeLessThanOrEqual(20);
    expect(e2e.steps).toContainEqual(expect.objectContaining({ run: "npm run test:e2e:smoke" }));
  });

  it("keeps the full suite on schedule/manual dispatch only", () => {
    const full = jobConfig("e2e-full");
    expect(full.if).toBe(
      "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
    );
    expect(full.steps).toContainEqual(expect.objectContaining({ run: "npm run test:e2e" }));
  });

  it("sets retries exactly once, in the Playwright config", () => {
    expect(playwrightConfig).toContain("retries: 0,");
    for (const job of Object.values(jobs)) {
      for (const step of job.steps) expect(step.run ?? "").not.toContain("--retries");
    }
    for (const [name, script] of Object.entries(pkg.scripts)) {
      expect(script, `${name} must not override config retries`).not.toContain("--retries");
    }
  });

  it("keeps every CI job's Playwright global timeout under that job's own budget", () => {
    // Headroom, in minutes, for the checkout / npm ci / browser install steps,
    // which run before Playwright starts and so are not covered by globalTimeout.
    // `npm ci` on this dependency tree plus `playwright install --with-deps`
    // (which apt-installs system libraries) commonly totals 4+ minutes on
    // ubuntu-latest; anything less than this and a genuinely hung suite is killed
    // by GitHub before Playwright's cap can abort and produce a report.
    const HEADROOM = 5;

    const configured = playwrightConfig.match(/globalTimeout: (\d+) \* 60_000/);
    expect(configured).not.toBeNull();
    const fullBudget = jobTimeoutMinutes("e2e-full");
    expect(fullBudget - Number(configured![1])).toBeGreaterThanOrEqual(HEADROOM);

    // The smoke job's budget is far tighter than the config default, so without
    // its own override GitHub would kill the runner before Playwright could
    // report anything at all.
    const smokeOverride = pkg.scripts["test:e2e:smoke"].match(/--global-timeout=(\d+)/);
    expect(smokeOverride, "test:e2e:smoke must set its own --global-timeout").not.toBeNull();
    const smokeMinutes = Number(smokeOverride![1]) / 60_000;
    expect(jobTimeoutMinutes("e2e") - smokeMinutes).toBeGreaterThanOrEqual(HEADROOM);
  });

  it("keeps failure diagnostics recoverable at zero retries", () => {
    // `on-first-retry` never fires when retries are 0.
    expect(playwrightConfig.match(/^\s*trace: .*$/m)?.[0]).toContain('"retain-on-failure"');
    // Artifacts written on the runner are lost with it unless uploaded. EVERY
    // browser job needs this, not just the nightly: `e2e` is the only per-push
    // browser signal on `main`, so a smoke failure with no upload leaves exactly
    // the reporter-text-only debugging this config is meant to prevent.
    for (const name of ["e2e", "e2e-full"]) {
      expect(hasRecoverableDiagnostics(jobConfig(name).steps),
        `${name} must always upload test-results/ through the approved pinned action`).toBe(true);
    }
  });

  it("makes the required check job an aggregator that cannot pass on a failed dependency", () => {
    const check = jobConfig("check");

    expect(check.needs).toEqual(["unit", "lint", "build"]);
    expect(check.if).toBe("always()");
    expect(check.steps.some((step) => step.run?.includes('if [ "$result" != "success" ]'))).toBe(true);
    // `e2e` is skipped on pull requests, and `integration` needs live Supabase
    // credentials a fork PR never receives — depending on either would make the
    // required status permanently red rather than gating on code.
    expect(check.needs).not.toContain("e2e");
    expect(check.needs).not.toContain("integration");
    // It duplicates no work the dimension jobs already do.
    for (const step of check.steps) {
      for (const command of ["check", "test:unit", "build", "lint"]) {
        expect(step.run ?? "").not.toContain(`npm run ${command}`);
      }
    }
  });

  it("keeps every non-browser validation job defined and independently triggered", () => {
    // `integration` is not in `check`'s needs, but it must still run on every
    // push and PR so its signal stays visible next to the required status.
    for (const name of ["unit", "integration", "lint", "build"]) {
      const job = jobConfig(name);
      expect(job["runs-on"]).toBe("ubuntu-latest");
      expect(job.if ?? "", `${name} must not be event-gated`).not.toContain("github.event_name");
    }
  });

  it("rejects a commented-out diagnostics upload even when its full contract appears in YAML", () => {
    const fixture = parse(`steps:
  - run: npm run test:e2e
  # - uses: ${UPLOAD_ARTIFACT} # v4.6.2
  #   if: always()
  #   with:
  #     path: test-results/
`) as { steps: WorkflowStep[] };
    expect(hasRecoverableDiagnostics(fixture.steps)).toBe(false);
  });

  it("rejects diagnostics settings split across steps or attached to a mutable action", () => {
    expect(hasRecoverableDiagnostics([
      { uses: UPLOAD_ARTIFACT, if: "success()", with: { path: "test-results/" } },
      { run: "echo diagnostics", if: "always()", with: { path: "test-results/" } },
    ])).toBe(false);
    expect(hasRecoverableDiagnostics([
      { uses: "actions/upload-artifact@v4", if: "always()", with: { path: "test-results/" } },
    ])).toBe(false);
  });
});
