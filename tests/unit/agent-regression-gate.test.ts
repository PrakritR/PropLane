import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * PRP-273 — the denied-proposal replay is wired in as a gate.
 *
 * Denied proposals are the primary eval set: every one is a case where a person looked at what
 * the assistant wanted to do and said no. Replaying them against the CURRENT prompts and tool
 * schemas is what catches a change that quietly reintroduces a rejected behaviour.
 *
 * Two properties are worth pinning, because getting either wrong is silent:
 *   - it must never BLOCK a promote, since it depends on a third-party service;
 *   - it must never report success when it did not actually run, since a green tick that proves
 *     nothing is worse than no suite at all — it gets trusted.
 */

const workflow = readFileSync(".github/workflows/agent-regression.yml", "utf8");
const preflight = readFileSync("scripts/ship-preflight.sh", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

describe("weekly agent regression workflow", () => {
  it("runs on a schedule and can be dispatched by hand", () => {
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("workflow_dispatch:");
  });

  it("refreshes the dataset before replaying it", () => {
    // The dataset grows as people deny more actions; replaying a stale copy measures the past.
    const sync = workflow.indexOf("langfuse:sync-eval-dataset");
    const run = workflow.indexOf("langfuse:run-regression");
    expect(sync).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(sync);
  });

  it("warns loudly instead of passing silently when credentials are missing", () => {
    expect(workflow).toContain("::warning::");
    expect(workflow).toContain("did not run");
    expect(workflow).toContain("steps.creds.outputs.configured == 'true'");
  });

  it("keeps the token-spending live mode opt-in", () => {
    // Schema mode costs nothing and still re-checks every rubric against today's tools.
    expect(workflow).toMatch(/inputs\.live == 'true'/);
  });

  it("stays out of the Test workflow's required check", () => {
    // `check` is the branch-protection status; adding a third-party dependency to it would
    // block merges on infrastructure rather than on code.
    const testWorkflow = readFileSync(".github/workflows/test.yml", "utf8");
    expect(testWorkflow).not.toContain("langfuse:run-regression");
  });
});

describe("ship preflight", () => {
  it("reports the regression result without failing the promote", () => {
    const section = preflight.slice(preflight.indexOf("-- agent regression --"));
    expect(section).toContain("langfuse:run-regression");
    // `note` is the WARN path; `bad` would fail the script and block a promote on an
    // observability provider being reachable.
    expect(section).toContain("note ");
    expect(section.slice(0, section.indexOf("Required before promote"))).not.toContain("bad ");
  });

  it("says plainly when it did not run, rather than staying quiet", () => {
    expect(preflight).toContain("agent regression not run");
  });
});

describe("the scripts it depends on", () => {
  it("are all declared", () => {
    for (const name of ["langfuse:run-regression", "langfuse:sync-eval-dataset", "langfuse:agent-health-report"]) {
      expect(pkg.scripts[name], name).toBeTruthy();
    }
  });
});
