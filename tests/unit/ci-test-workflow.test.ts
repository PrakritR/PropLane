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
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
};
type WorkflowJob = {
  "runs-on": string;
  "timeout-minutes"?: number;
  if?: string;
  env?: Record<string, unknown>;
  needs?: string[];
  steps: WorkflowStep[];
};
type WorkflowDocument = {
  on: { workflow_dispatch: { inputs: Record<string, unknown> } };
  jobs: Record<string, WorkflowJob>;
};
const workflowDocument = parse(workflow) as WorkflowDocument;
const jobs = workflowDocument.jobs;
const NORMAL_VALIDATION = "${{ !(github.event_name == 'workflow_dispatch' && (inputs.unit_only || (github.ref == 'refs/heads/akhil/test-workspace-release-20260919' && inputs.build_only == true))) }}";
const UPLOAD_ARTIFACT = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";
const BUILD_ONLY = "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/akhil/test-workspace-release-20260919' && inputs.build_only == true";
const NOT_BUILD_ONLY = `\${{ !(${BUILD_ONLY}) }}`;

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
  it("permits the unit-only shortcut exclusively through an opt-in manual dispatch", () => {
    const parsed = parse(workflow) as { on: Record<string, unknown> };
    expect(parsed.on.push).toEqual({ branches: ["main", "staging"] });
    expect(parsed.on).toHaveProperty("pull_request");
    expect(parsed.on.workflow_dispatch).toEqual({ inputs: {
      build_only: {
        description: "Run only the build and encrypted local QA artifact job on the exact release keeper",
        required: false, type: "boolean", default: false,
      },
      unit_only: {
        description: "Run only the unit job", required: false, type: "boolean", default: false,
      },
      e2e_scope: {
        description: "Scope the manual full E2E job", required: false, type: "choice",
        options: ["full", "conversation"], default: "full",
      },
    } });
    // Exact parsed conditions prevent a similarly named push/PR input or a
    // comment from disabling validation. Every bypass requires dispatch AND
    // the boolean input; false/default keeps all existing checks active.
    for (const name of ["integration", "release-cli-transaction", "lint"]) expect(jobConfig(name).if).toBe(NORMAL_VALIDATION);
    expect(jobConfig("build").if).toBe("${{ !(github.event_name == 'workflow_dispatch' && inputs.unit_only) }}");
    expect(jobConfig("check").if).toBe("${{ always() && !(github.event_name == 'workflow_dispatch' && (inputs.unit_only || (github.ref == 'refs/heads/akhil/test-workspace-release-20260919' && inputs.build_only == true))) }}");
    const unit = jobConfig("unit");
    expect(unit.if).toBe(NOT_BUILD_ONLY);
    const commands = unit.steps.filter(step => step.run?.includes("npm run test:unit"));
    expect(commands).toHaveLength(1);
    expect(commands[0].run).toBe("npm run test:unit");
    expect(commands[0].if).toBeUndefined();
    expect(unit.steps.some(step => step.run?.includes("vitest run"))).toBe(false);
  });

  it("always runs the new database guards in an owned loopback cluster under the gated unit job", () => {
    const unit = jobConfig("unit");
    const start = unit.steps.find(step => step.name === "Start isolated reconciliation PostgreSQL harness");
    const stop = unit.steps.find(step => step.name === "Stop isolated reconciliation PostgreSQL harness");
    expect(start?.if).toBeUndefined();
    expect(start?.run).toContain("--auth=trust -U reconciliation");
    expect(start?.run).toContain('-o "-p 5547 -h 127.0.0.1 -k $HARNESS_DATA"');
    expect(start?.run).toContain('cat "$RUNNER_TEMP/reconciliation-pg.log"');
    expect(start?.run).toContain('"RELEASE_RECONCILIATION_DISPOSABLE_PG=1" >> "$GITHUB_ENV"');
    expect(start?.run).toContain("postgresql://reconciliation@127.0.0.1:5547/postgres");
    expect(stop?.if).toBe("always()");
    expect(stop?.run).toContain('"$RUNNER_TEMP/reconciliation-pg/postmaster.pid"');
    expect(stop?.run).toContain('-D "$RUNNER_TEMP/reconciliation-pg" -m fast -w stop');
    expect(stop?.run).not.toContain("|| true");
    expect(JSON.stringify(unit)).not.toContain("secrets.");
    expect(jobConfig("check").needs).toContain("unit");
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
      "${{ (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && !(github.event_name == 'workflow_dispatch' && (inputs.unit_only || (github.ref == 'refs/heads/akhil/test-workspace-release-20260919' && inputs.build_only == true))) }}",
    );
    expect(full.steps).toContainEqual(expect.objectContaining({
      name: "Run full E2E suite",
      if: "${{ !(github.event_name == 'workflow_dispatch' && inputs.e2e_scope == 'conversation') }}",
      run: "npm run test:e2e",
    }));
    expect(full.steps).toContainEqual(expect.objectContaining({
      name: "Run conversation identity E2E",
      if: "${{ github.event_name == 'workflow_dispatch' && inputs.e2e_scope == 'conversation' }}",
      run: "npm run test:e2e -- tests/e2e/conversation-identity.spec.ts",
    }));
  });

  it("keeps the conversation scope as a fixed Playwright command", () => {
    const full = jobConfig("e2e-full");
    const conversation = full.steps.find((step) => step.name === "Run conversation identity E2E");
    expect(conversation?.run).toBe("npm run test:e2e -- tests/e2e/conversation-identity.spec.ts");
    expect(conversation?.run).not.toContain("${");
    expect(conversation?.run).not.toContain("inputs.");
    expect(conversation?.run).not.toContain("github.");
  });

  it("keeps the shared E2E auth and dev database environment on both scopes", () => {
    const env = jobConfig("e2e-full").env;
    expect(env).toEqual({
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      PLAYWRIGHT_BASE_URL: "http://localhost:3000",
      NEXT_PUBLIC_SUPABASE_URL: "${{ secrets.TEST_SUPABASE_URL }}",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "${{ secrets.TEST_SUPABASE_ANON_KEY }}",
      SUPABASE_SERVICE_ROLE_KEY: "${{ secrets.TEST_SUPABASE_SERVICE_ROLE_KEY }}",
      PROPLANE_PAYMENT_WAIVER_CODE: "FREE100",
      AXIS_ADMIN_REGISTER_KEY: "${{ secrets.TEST_AXIS_ADMIN_REGISTER_KEY }}",
      E2E_ADMIN_EMAIL: "${{ secrets.E2E_ADMIN_EMAIL }}",
      E2E_ADMIN_PASSWORD: "${{ secrets.E2E_ADMIN_PASSWORD }}",
      E2E_MANAGER_EMAIL: "${{ secrets.E2E_MANAGER_EMAIL }}",
      E2E_MANAGER_PASSWORD: "${{ secrets.E2E_MANAGER_PASSWORD }}",
      E2E_RESIDENT_EMAIL: "${{ secrets.E2E_RESIDENT_EMAIL }}",
      E2E_RESIDENT_PASSWORD: "${{ secrets.E2E_RESIDENT_PASSWORD }}",
      E2E_TESTS_ENABLED: "1",
      CRON_SECRET: "${{ secrets.CRON_SECRET }}",
    });
    for (const name of ["Run full E2E suite", "Run conversation identity E2E"]) {
      const step = jobConfig("e2e-full").steps.find((candidate) => candidate.name === name);
      expect(step?.env).toBeUndefined();
    }
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

    expect(check.needs).toEqual(["unit", "release-cli-transaction", "lint", "build"]);
    expect(check.if).toBe("${{ always() && !(github.event_name == 'workflow_dispatch' && (inputs.unit_only || (github.ref == 'refs/heads/akhil/test-workspace-release-20260919' && inputs.build_only == true))) }}");
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
      "release-cli-transaction": "ubuntu-24.04",
      integration: "ubuntu-latest",
      lint: "ubuntu-latest",
      build: "ubuntu-latest",
    } as const;

    for (const [name, runner] of Object.entries(runners)) {
      const job = jobConfig(name);
      expect(job["runs-on"]).toBe(runner);
      if (name === "unit") expect(job.if).toBe(NOT_BUILD_ONLY);
      else if (name === "build") expect(job.if).toBe("${{ !(github.event_name == 'workflow_dispatch' && inputs.unit_only) }}");
      else expect(job.if, `${name} skips only an explicit diagnostic dispatch`).toBe(NORMAL_VALIDATION);
    }
  });

  it("preserves both diagnostic modes without changing default release gates", () => {
    expect(workflowDocument.on.workflow_dispatch.inputs.build_only).toEqual({
      description: "Run only the build and encrypted local QA artifact job on the exact release keeper",
      required: false,
      type: "boolean",
      default: false,
    });
    expect(workflowDocument.on.workflow_dispatch.inputs.unit_only).toEqual({
      description: "Run only the unit job", required: false, type: "boolean", default: false,
    });
    expect(jobConfig("unit").if).toBe(NOT_BUILD_ONLY);
    for (const name of ["integration", "lint", "release-cli-transaction"]) {
      expect(jobConfig(name).if).toBe(NORMAL_VALIDATION);
    }
    expect(jobConfig("build").if).toBe("${{ !(github.event_name == 'workflow_dispatch' && inputs.unit_only) }}");
    expect(workflow).not.toContain("inputs.build_only != false");
  });

  it("proves the pinned CLI batch transaction on disposable PostgreSQL 16 and exact target 17.6", () => {
    const job = jobConfig("release-cli-transaction") as WorkflowJob & {
      strategy: { matrix: { include: Array<Record<string, string>> } };
      services: { postgres: { image: string; env: Record<string, string>; ports: string[] } };
    };
    expect(job["timeout-minutes"]).toBe(12);
    expect(job.strategy.matrix.include).toEqual([
      { postgres: "16.10", image: "16.10-bookworm", "server-version-num": "160010" },
      { postgres: "17.6", image: "17.6-bookworm", "server-version-num": "170006" },
    ]);
    expect(job.services.postgres.image).toBe("postgres:${{ matrix.image }}");
    expect(job.services.postgres.env).toEqual({ POSTGRES_PASSWORD: "postgres" });
    expect(job.services.postgres.ports).toEqual(["5432:5432"]);
    expect(JSON.stringify(job)).not.toContain("secrets.");

    const download = job.steps.find(step => step.name === "Download the official pinned Supabase CLI");
    expect(download?.run).toContain("v2.117.0/supabase_2.117.0_linux_amd64.tar.gz");
    expect(download?.run).toContain("afcec54b3b19d8c73957cafb4956bb10cb7493207c29df60cdcd9afe6317cdb0  checksums.txt");
    expect(download?.run).toContain("69c05f85b9e47ee706d30f1a6ca8a526b4e337bfd12c7ef1ef522d24e7280d24  supabase_2.117.0_linux_amd64.tar.gz");
    expect(download?.run).toContain("sha256sum --check --strict");

    const proof = job.steps.find(step => step.name === "Prove exact CLI transaction and history behavior");
    expect(proof?.run).toBe('node scripts/test-release-cli-transaction.mjs "$RELEASE_TRANSACTION_SUPABASE_CLI" "$RELEASE_TRANSACTION_PG_URL" "$EXPECTED_SERVER_VERSION_NUM"');
    expect(proof?.env).toEqual({
      RELEASE_TRANSACTION_PG_URL: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
      EXPECTED_SERVER_VERSION_NUM: "${{ matrix.server-version-num }}",
    });
    expect(jobConfig("check").needs).toContain("release-cli-transaction");
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
