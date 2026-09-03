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
    expect(e2e).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(e2e).toContain("timeout-minutes: 15");
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

  it("keeps globalTimeout under the widest CI job budget that governs it", () => {
    const globalTimeout = playwrightConfig.match(/globalTimeout: (\d+) \* 60_000/);
    expect(globalTimeout).not.toBeNull();

    const budget = jobTimeoutMinutes("e2e-full");
    expect(Number(globalTimeout![1])).toBeLessThan(budget);
    // Headroom for the job's checkout / npm ci / browser install, which run
    // before Playwright starts and so are not covered by globalTimeout.
    expect(budget - Number(globalTimeout![1])).toBeGreaterThanOrEqual(5);
  });

  it("makes the required check job an aggregator that cannot pass on a failed dependency", () => {
    const check = jobBody("check");

    expect(check).toContain("needs: [unit, integration, lint, build]");
    expect(check).toContain("if: always()");
    expect(check).toContain('if [ "$result" != "success" ]');
    // e2e is skipped on pull requests, so depending on it would make the
    // required status permanently red on every PR.
    expect(check).not.toContain("e2e");
    // It duplicates no work the dimension jobs already do.
    expect(check).not.toContain("- run: npm run check");
    expect(check).not.toContain("- run: npm run test:unit");
    expect(check).not.toContain("- run: npm run build");
    expect(check).not.toContain("- run: npm run lint");
  });

  it("keeps every job the required check depends on defined and independently triggered", () => {
    for (const name of ["unit", "integration", "lint", "build"]) {
      const body = jobBody(name);
      expect(body).toContain("runs-on: ubuntu-latest");
      expect(body, `${name} must not be event-gated`).not.toContain("if: github.event_name");
    }
  });
});
