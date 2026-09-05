import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/test.yml"), "utf8");
const playwrightConfig = fs.readFileSync(path.join(ROOT, "playwright.config.ts"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

// A `[\s\S]*?` match happily spans job boundaries, so it can "prove" a fact
// about a job using a line that belongs to a different one. Slice the job first,
// then assert only against its own body.
function jobBody(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name} not found`).toBeGreaterThanOrEqual(0);
  const nextJob = workflow.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  const body = nextJob === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + nextJob);
  // Trailing blank/comment lines introduce the NEXT job, not this one.
  return body
    .split("\n")
    .reduceRight<string[]>(
      (kept, line) =>
        kept.length === 0 && (line.trim() === "" || line.trim().startsWith("#"))
          ? kept
          : [line, ...kept],
      [],
    )
    .join("\n");
}

function jobTimeoutMinutes(name: string): number {
  const match = jobBody(name).match(/timeout-minutes: (\d+)/);
  expect(match, `job ${name} has no timeout-minutes`).not.toBeNull();
  return Number(match![1]);
}

describe("Test workflow resource budget", () => {
  it("keeps the main E2E gate a bounded smoke", () => {
    expect(pkg.scripts["test:e2e:smoke"]).toContain("--no-deps");
    expect(pkg.scripts["test:e2e:smoke"]).toContain("public-tours.spec.ts");

    const e2e = jobBody("e2e");
    expect(e2e).toContain(// The deploy ladder added a staging rung, so the bounded smoke now also
    // guards pushes to staging. Still bounded — still not the full suite.
    "if: github.event_name == 'push' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/staging')");
    expect(jobTimeoutMinutes("e2e")).toBeLessThanOrEqual(20);
    expect(e2e).toContain("- run: npm run test:e2e:smoke");
  });

  it("keeps the full suite on schedule/manual dispatch only", () => {
    const full = jobBody("e2e-full");
    expect(full).toContain(
      "if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
    );
    expect(full).toContain("- run: npm run test:e2e\n");
  });

  it("sets retries exactly once, in the Playwright config", () => {
    expect(playwrightConfig).toContain("retries: 0,");
    expect(workflow).not.toContain("--retries");
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
      const body = jobBody(name);
      expect(body, `${name} must upload its Playwright output`).toContain(
        "uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2",
      );
      expect(body).toContain("path: test-results/");
      // A step that only runs on success uploads nothing for the failure it
      // exists to explain.
      expect(body.slice(body.indexOf("upload-artifact"))).toContain("if: always()");
    }
  });

  it("makes the required check job an aggregator that cannot pass on a failed dependency", () => {
    const check = jobBody("check");

    expect(check).toContain("needs: [unit, lint, build]");
    expect(check).toContain("if: always()");
    expect(check).toContain('if [ "$result" != "success" ]');
    // `e2e` is skipped on pull requests, and `integration` needs live Supabase
    // credentials a fork PR never receives — depending on either would make the
    // required status permanently red rather than gating on code.
    expect(check).not.toContain("e2e");
    expect(check).not.toContain("integration");
    // It duplicates no work the dimension jobs already do.
    expect(check).not.toContain("- run: npm run check");
    expect(check).not.toContain("- run: npm run test:unit");
    expect(check).not.toContain("- run: npm run build");
    expect(check).not.toContain("- run: npm run lint");
  });

  it("keeps every non-browser validation job defined and independently triggered", () => {
    // `integration` is not in `check`'s needs, but it must still run on every
    // push and PR so its signal stays visible next to the required status.
    for (const name of ["unit", "integration", "lint", "build"]) {
      const body = jobBody(name);
      expect(body).toContain("runs-on: ubuntu-latest");
      expect(body, `${name} must not be event-gated`).not.toContain("if: github.event_name");
    }
  });
});
