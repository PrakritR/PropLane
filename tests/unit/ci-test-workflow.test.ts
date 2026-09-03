import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/test.yml"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("Test workflow resource budget", () => {
  it("keeps the main E2E gate bounded and the full suite scheduled/manual", () => {
    expect(pkg.scripts["test:e2e:smoke"]).toContain("--no-deps --retries=0");
    expect(pkg.scripts["test:e2e:smoke"]).toContain("public-tours.spec.ts");
    expect(workflow).toMatch(/e2e:\n[\s\S]*?timeout-minutes: 15[\s\S]*?npm run test:e2e:smoke/);
    expect(workflow).toMatch(
      /e2e-full:\n[\s\S]*?github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'[\s\S]*?--retries=0/,
    );
  });

  it("does not duplicate unit and build work inside the required check job", () => {
    const checkStart = workflow.indexOf("\n  check:\n");
    const nextJobStart = workflow.indexOf("\n  build:\n", checkStart);
    const checkJob = workflow.slice(checkStart, nextJobStart);

    expect(checkStart).toBeGreaterThanOrEqual(0);
    expect(nextJobStart).toBeGreaterThan(checkStart);
    expect(checkJob).toContain("- run: npm run lint");
    expect(checkJob).not.toContain("- run: npm run check");
    expect(checkJob).not.toContain("- run: npm run test:unit");
    expect(checkJob).not.toContain("- run: npm run build");
  });
});
