import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/test.yml"), "utf8");
const playwrightConfig = fs.readFileSync(path.join(ROOT, "playwright.config.ts"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

function jobBody(name: string) {
  const header = `\n  ${name}:\n`;
  const start = workflow.indexOf(header);
  expect(start, `workflow job ${name}`).toBeGreaterThanOrEqual(0);

  const bodyStart = start + header.length;
  const remainder = workflow.slice(bodyStart);
  const nextHeader = remainder.search(/\n  [a-zA-Z][a-zA-Z0-9-]*:\n/);
  const body = nextHeader < 0 ? remainder : remainder.slice(0, nextHeader);

  // Comments introducing the next job belong to that job conceptually, even
  // though YAML permits them before its key. Exclude that trailing block from
  // string guards without removing comments inside the selected job.
  const trailingComment = body.lastIndexOf("\n\n  #");
  return trailingComment < 0 ? body : body.slice(0, trailingComment);
}

function timeoutMinutes(job: string) {
  const value = job.match(/timeout-minutes:\s*(\d+)/)?.[1];
  expect(value).toBeDefined();
  return Number(value);
}

describe("Test workflow resource budget", () => {
  it("keeps the main smoke and complete suite in their intended trigger lanes", () => {
    const smoke = jobBody("e2e");
    const full = jobBody("e2e-full");

    expect(smoke).toContain("timeout-minutes: 15");
    expect(smoke).toContain("github.event_name == 'push'");
    expect(smoke).not.toContain("schedule");
    expect(smoke).toContain("npm run test:e2e:smoke");

    expect(full).toContain("timeout-minutes: 50");
    expect(full).toContain("github.event_name == 'schedule'");
    expect(full).toContain("github.event_name == 'workflow_dispatch'");
    expect(full).toContain("npm run test:e2e");
    expect(full).toContain("if: always()");
    expect(full).toContain("actions/upload-artifact@v4");
  });

  it("keeps Playwright reporting inside each browser job's outer budget", () => {
    const smokeTimeoutMs = Number(
      pkg.scripts["test:e2e:smoke"].match(/--global-timeout=(\d+)/)?.[1],
    );
    const fullTimeoutMinutes = Number(
      playwrightConfig.match(/globalTimeout:\s*(\d+)\s*\*\s*60_000/)?.[1],
    );

    expect(smokeTimeoutMs).toBeGreaterThan(0);
    expect(smokeTimeoutMs).toBeLessThanOrEqual((timeoutMinutes(jobBody("e2e")) - 3) * 60_000);
    expect(fullTimeoutMinutes).toBeLessThanOrEqual(timeoutMinutes(jobBody("e2e-full")) - 5);
  });

  it("centralizes zero retries and retains first-failure diagnostics", () => {
    expect(playwrightConfig).toMatch(/retries:\s*0/);
    expect(playwrightConfig).toContain('trace: "retain-on-failure"');
    expect(Object.values(pkg.scripts).join("\n")).not.toMatch(/--retries(?:=|\s)/);
    expect(workflow).not.toMatch(/--retries(?:=|\s)/);
  });

  it("keeps check as the stable aggregate without duplicating validation", () => {
    const lint = jobBody("lint");
    const check = jobBody("check");

    expect(lint).toContain("npm run lint");
    expect(check).toContain("needs: [unit, lint, build]");
    expect(check).not.toContain("integration");
    expect(check).toContain("if: always()");
    expect(check).toContain("join(needs.*.result");
    expect(check).not.toContain("npm ci");
    expect(check).not.toContain("npm run check");
    expect(check).not.toContain("npm run test:unit");
    expect(check).not.toContain("npm run build");
  });
});
