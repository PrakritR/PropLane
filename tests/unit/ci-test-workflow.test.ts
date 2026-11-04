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
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  "continue-on-error"?: boolean | string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
};
type WorkflowJob = {
  "runs-on": string;
  "timeout-minutes"?: number;
  if?: string;
  needs?: string[];
  "continue-on-error"?: boolean | string;
  env?: Record<string, unknown>;
  steps: WorkflowStep[];
};
type WorkflowDocument = {
  env?: Record<string, unknown>;
  on: { workflow_dispatch: { inputs: Record<string, { type: string; required: boolean; default: boolean | string; options?: string[] }> } };
  jobs: Record<string, WorkflowJob>;
};
const workflowDocument = parse(workflow) as WorkflowDocument;
const jobs = workflowDocument.jobs;
const UPLOAD_ARTIFACT = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";
const BUILD_ONLY = "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/akhil/test-workspace-release-20260919' && inputs.build_only == true";
const NOT_BUILD_ONLY = `\${{ !(${BUILD_ONLY}) }}`;
const E2E_ENV = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  PLAYWRIGHT_BASE_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_URL: "${{ secrets.TEST_SUPABASE_URL }}",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "${{ secrets.TEST_SUPABASE_ANON_KEY }}",
  SUPABASE_SERVICE_ROLE_KEY: "${{ secrets.TEST_SUPABASE_SERVICE_ROLE_KEY }}",
  E2E_TESTS_ENABLED: "1",
};

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

function assertBrowserBuildGate(document: WorkflowDocument): void {
  const workflowJobs = document.jobs;
  for (const name of ["e2e", "e2e-full"]) {
    expect(workflowJobs[name]?.needs, `${name} must wait for the same-run build`).toEqual(["build"]);
    expect(workflowJobs[name]?.if ?? "", `${name} must retain normal needs success gating`).not.toContain("always()");
    expect(workflowJobs[name]?.["continue-on-error"], `${name} failures must not be ignored`).toBeUndefined();
  }

  const build = workflowJobs.build;
  expect(build, "build must remain an unconditional job").toBeDefined();
  expect(build.if, "build cannot be gated behind another validation job").toBeUndefined();
  expect(build.needs, "build must remain independently triggered").toBeUndefined();
  expect(build["continue-on-error"], "build failures must not be ignored").toBeUndefined();

  const typecheckIndex = build.steps.findIndex((step) => step.name === "Type-check (the gate the build below no longer repeats)");
  const buildIndex = build.steps.findIndex((step) => step.run === "bash scripts/ci-observe-build.sh");
  expect(typecheckIndex, "build must keep the separate typecheck step").toBeGreaterThanOrEqual(0);
  expect(buildIndex, "build command must remain present").toBeGreaterThan(typecheckIndex);
  const typecheck = build.steps[typecheckIndex];
  expect(typecheck.run).toBe("npm run typecheck");
  expect(typecheck.if, "typecheck must run unconditionally").toBeUndefined();
  expect(typecheck["continue-on-error"], "typecheck failures must fail the job").toBeUndefined();
  const buildStep = build.steps[buildIndex];
  expect(buildStep.if, "build command must run after successful typecheck without a conditional bypass").toBeUndefined();
  expect(buildStep["continue-on-error"], "build failures must fail the job").toBeUndefined();

  // The flag is permitted only on the existing build invocation and the three
  // named browser invocations. Job/global configuration would silently widen it.
  expect(document.env ?? {}).not.toHaveProperty("PROPLANE_TYPECHECK_SEPARATELY");
  const allowed = new Set([
    "build:bash scripts/ci-observe-build.sh",
    "e2e:npm run test:e2e:smoke",
    "e2e-full:npm run test:e2e",
    "e2e-full:npx playwright test tests/e2e/property-metadata-omission-preservation.spec.ts",
  ]);
  const flagSteps: string[] = [];
  for (const [jobName, job] of Object.entries(workflowJobs)) {
    expect(job.env ?? {}, `${jobName} job must not set the typecheck flag`).not.toHaveProperty("PROPLANE_TYPECHECK_SEPARATELY");
    for (const step of job.steps) {
      if (step.env && "PROPLANE_TYPECHECK_SEPARATELY" in step.env) {
        flagSteps.push(`${jobName}:${step.run ?? ""}`);
        expect(step.env.PROPLANE_TYPECHECK_SEPARATELY).toBe("1");
        expect(allowed.has(`${jobName}:${step.run ?? ""}`), "flag is limited to build and the three browser commands").toBe(true);
        expect(step["continue-on-error"], "flagged build and browser commands must fail normally").toBeUndefined();
      }
    }
  }
  expect(flagSteps.sort()).toEqual([...allowed].sort());
  for (const [name, script] of Object.entries(pkg.scripts)) {
    expect(script, `${name} must not enable a separate typecheck as a global default`).not.toContain("PROPLANE_TYPECHECK_SEPARATELY");
  }

  // Each job checks out the workflow event's default ref. A ref override could
  // make the build prerequisite validate different source than the browser job.
  const checkoutAction = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
  for (const name of ["build", "e2e", "e2e-full"]) {
    const checkouts = workflowJobs[name].steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts, `${name} must have one checkout of the workflow SHA`).toHaveLength(1);
    const checkout = checkouts[0];
    expect(checkout.uses, `${name} must use the pinned checkout action`).toBe(checkoutAction);
    expect(checkout.with?.ref, `${name} must use checkout's same-run default ref`).toBeUndefined();
    expect(checkout.with?.repository, `${name} cannot checkout a foreign repository`).toBeUndefined();
    expect(checkout.with?.path, `${name} cannot source validation from a foreign checkout path`).toBeUndefined();
    expect(workflowJobs[name].steps.some((step) => step.uses?.startsWith("actions/download-artifact@")),
      `${name} cannot consume build evidence from another run`).toBe(false);
  }
}

describe("Test workflow resource budget", () => {
  it("gates browser jobs on the unconditional same-SHA build and scopes the typecheck flag", () => {
    assertBrowserBuildGate(workflowDocument);
    expect(playwrightConfig).toContain('stdout: "pipe",');

    // Mutation checks keep the safety assertions meaningful: dropping the
    // dependency, type gate, or moving/gating that gate must be rejected.
    const missingDependency = structuredClone(workflowDocument);
    missingDependency.jobs.e2e.needs = [];
    expect(() => assertBrowserBuildGate(missingDependency)).toThrow();

    const missingTypecheck = structuredClone(workflowDocument);
    missingTypecheck.jobs.build.steps = missingTypecheck.jobs.build.steps.filter(
      (step) => step.name !== "Type-check (the gate the build below no longer repeats)",
    );
    expect(() => assertBrowserBuildGate(missingTypecheck)).toThrow();

    const gatedTypecheck = structuredClone(workflowDocument);
    const typecheck = gatedTypecheck.jobs.build.steps.find(
      (step) => step.name === "Type-check (the gate the build below no longer repeats)",
    );
    if (typecheck) typecheck.if = "success()";
    expect(() => assertBrowserBuildGate(gatedTypecheck)).toThrow();

    const ignoredTypecheck = structuredClone(workflowDocument);
    const ignoredTypecheckStep = ignoredTypecheck.jobs.build.steps.find(
      (step) => step.name === "Type-check (the gate the build below no longer repeats)",
    );
    if (ignoredTypecheckStep) ignoredTypecheckStep["continue-on-error"] = true;
    expect(() => assertBrowserBuildGate(ignoredTypecheck)).toThrow();

    const globalFlag = structuredClone(workflowDocument);
    globalFlag.env = { ...globalFlag.env, PROPLANE_TYPECHECK_SEPARATELY: "1" };
    expect(() => assertBrowserBuildGate(globalFlag)).toThrow();

    const reorderedTypecheck = structuredClone(workflowDocument);
    const steps = reorderedTypecheck.jobs.build.steps;
    const typecheckIndex = steps.findIndex((step) => step.name === "Type-check (the gate the build below no longer repeats)");
    const buildIndex = steps.findIndex((step) => step.run === "bash scripts/ci-observe-build.sh");
    if (typecheckIndex >= 0 && buildIndex >= 0) {
      [steps[typecheckIndex], steps[buildIndex]] = [steps[buildIndex], steps[typecheckIndex]];
    }
    expect(() => assertBrowserBuildGate(reorderedTypecheck)).toThrow();
  });

  it("uses only the reviewed observer command and bounded static-generation opt-in", () => {
    expect(workflowDocument.env).toEqual({ PROPLANE_CI_SERIAL_STATIC_GENERATION: "1" });
    const observer = fs.readFileSync(path.join(ROOT, "scripts/ci-observe-build.sh"), "utf8");
    expect(observer.trim().endsWith("npm run build")).toBe(true);
    expect(observer).not.toContain("continue-on-error");
    expect(observer).not.toMatch(/(?:printenv|set -x|ps .*args|ps .*command)/);
  });

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
      `github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && !(github.ref == 'refs/heads/akhil/test-workspace-release-20260919' && inputs.build_only == true))`,
    );
    expect(full.steps).toContainEqual(expect.objectContaining({
      name: "Run full E2E suite",
      if: "github.event_name != 'workflow_dispatch' || inputs.e2e_scope == 'full'",
      run: "npm run test:e2e",
    }));
    expect(full.steps).toContainEqual(expect.objectContaining({
      name: "Run property metadata E2E scope",
      if: "github.event_name == 'workflow_dispatch' && inputs.e2e_scope == 'property_metadata'",
      run: "npx playwright test tests/e2e/property-metadata-omission-preservation.spec.ts",
    }));
    for (const name of ["Run full E2E suite", "Run property metadata E2E scope"]) {
      const step = full.steps.find((candidate) => candidate.name === name);
      expect(step?.env, `${name} must use the dev/test E2E environment`).toMatchObject(E2E_ENV);
    }
  });

  it("keeps property metadata preflight limited to its manual dispatch scope", () => {
    expect(workflowDocument.on.workflow_dispatch.inputs.e2e_scope).toEqual({
      description: "Select the manual browser scope",
      required: false,
      type: "choice",
      default: "full",
      options: ["full", "property_metadata"],
    });
    expect(jobConfig("build").steps).toContainEqual(expect.objectContaining({
      name: "Run property metadata ship preflight",
      if: "success() && github.event_name == 'workflow_dispatch' && inputs.e2e_scope == 'property_metadata'",
      run: "npm run ship:preflight",
    }));
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
    // Minutes the three smoke specs need after the webServer is up. They run
    // serially at a 60s per-test timeout, so this is a floor, not a target.
    const SPEC_RUN_FLOOR = 5;

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

    // `webServer.timeout` is spent INSIDE that cap: Playwright builds and starts the
    // server as part of the run. A webServer timeout that eats the whole cap aborts
    // the suite mid-build with no report at all — the exact failure these pins exist
    // to prevent — so the specs themselves must keep a floor of their own.
    const webServerBlock = playwrightConfig.slice(
      playwrightConfig.indexOf("webServer:"),
      playwrightConfig.indexOf("projects:"),
    );
    const webServerTimeout = webServerBlock.match(/timeout: ([\d_]+),/);
    expect(webServerTimeout, "webServer must declare its own timeout").not.toBeNull();
    const webServerMinutes = Number(webServerTimeout![1].replace(/_/g, "")) / 60_000;
    expect(smokeMinutes - webServerMinutes).toBeGreaterThanOrEqual(SPEC_RUN_FLOOR);
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
    expect(check.if).toBe(`\${{ always() && !(${BUILD_ONLY}) }}`);
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
    const runners = {
      unit: "ubuntu-24.04",
      integration: "ubuntu-latest",
      lint: "ubuntu-latest",
      build: "ubuntu-latest",
    } as const;

    for (const [name, runner] of Object.entries(runners)) {
      const job = jobConfig(name);
      expect(job["runs-on"]).toBe(runner);
      expect(job.needs, `${name} must remain independent of other validation jobs`).toBeUndefined();
      if (name === "build") expect(job.if).toBeUndefined();
      else expect(job.if).toBe(NOT_BUILD_ONLY);
    }
  });

  it("allows build-only dispatch only on the exact keeper without changing default gates", () => {
    expect(workflowDocument.on.workflow_dispatch.inputs.build_only).toEqual({
      description: "Run only the build and encrypted local QA artifact job on the exact release keeper",
      required: false,
      type: "boolean",
      default: false,
    });
    for (const name of ["unit", "integration", "lint"]) expect(jobConfig(name).if).toBe(NOT_BUILD_ONLY);
    expect(jobConfig("check").if).toBe(`\${{ always() && !(${BUILD_ONLY}) }}`);
    expect(jobConfig("e2e-full").if).toContain(`!(${BUILD_ONLY.replace("github.event_name == 'workflow_dispatch' && ", "")})`);
    expect(jobConfig("build").if).toBeUndefined();
    expect(workflow).not.toContain("inputs.build_only != false");
  });

  it("keeps the unit harness provisioned with PostgreSQL 16 and OpenSSL before its unconditional command", () => {
    const unit = jobConfig("unit");
    const provisioningIndex = unit.steps.findIndex(
      (step) => step.name === "Provision PostgreSQL 16 harness tools",
    );
    const unitCommandIndex = unit.steps.findIndex((step) => step.run === "npm run test:unit");

    expect(provisioningIndex).toBeGreaterThanOrEqual(0);
    expect(unitCommandIndex).toBeGreaterThan(provisioningIndex);
    expect(unit.steps[provisioningIndex].if).toBeUndefined();

    const provisioningLines = unit.steps[provisioningIndex].run
      ?.split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(provisioningLines).toContain(
      "sudo apt-get install --yes postgresql-16 postgresql-client-16 openssl",
    );
    expect(provisioningLines).toContain('echo "/usr/lib/postgresql/16/bin" >> "$GITHUB_PATH"');
    expect(unit.steps[unitCommandIndex].if).toBeUndefined();
  });

  it("checks out full history for the immutable migration source verification", () => {
    const unit = jobConfig("unit");
    const checkout = unit.steps.find((step) => step.uses === "actions/checkout@11d5960a326750d5838078e36cf38b85af677262");

    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    for (const [name, job] of Object.entries(jobs)) {
      if (name === "unit") continue;
      for (const step of job.steps.filter((candidate) => candidate.uses?.startsWith("actions/checkout@"))) {
        expect(step.with?.["fetch-depth"], `${name} checkout should keep the default shallow history`).toBeUndefined();
      }
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
