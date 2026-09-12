import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function normalized(source: string): string {
  return source.replaceAll("`", "").replace(/\s+/g, " ");
}

const rootInstructions = read("AGENTS.md");
const akhilInstructions = read("docs/agents/AGENTS-akhil.md");
const deploymentWorkflow = read("docs/agents/deployment-workflow.md");
const shipGate = read("docs/ship-gate.md");
const activeShipRule = read(".cursor/rules/ship-and-review-gate.mdc");
const activeReviewRule = read(".cursor/rules/sandbox-open-feature-review.mdc");
const shipPreflight = read("scripts/ship-preflight.sh");
const temporaryPolicy = JSON.parse(
  read("docs/agents/temporary-direct-production-policy.json"),
) as Record<string, unknown>;

describe("developer-specific release routing", () => {
  it("lets Akhil ship only after an explicit request and keeps the staging rung", () => {
    const routingSources = [
      akhilInstructions,
      deploymentWorkflow,
      shipGate,
      activeShipRule,
      activeReviewRule,
    ];
    for (const source of routingSources) {
      const compact = normalized(source);
      expect(compact).toContain("explicit Akhil ship request");
      expect(compact).toMatch(/keeper → main(?: → staging → production)?/);
      expect(source).toContain("`staging`");
      expect(source).toContain("`production`");
    }
    expect(normalized(rootInstructions)).toContain("agents working for Akhil after his explicit ship request");

    expect(rootInstructions).not.toContain(
      "Agents never merge to `prakrit`, `main`, `staging`, or `production`.",
    );
  });

  it("retains Prakrit's captain integration path", () => {
    for (const source of [rootInstructions, deploymentWorkflow, shipGate, activeShipRule]) {
      expect(source).toContain("`prakrit`");
      expect(source.toLowerCase()).toContain("captain");
    }
    expect(deploymentWorkflow).toContain("npm run ship:to-prakrit");
  });

  it("keeps ordinary Akhil work on a keeper with a Review URL", () => {
    expect(akhilInstructions).toContain(
      "Absent an explicit Akhil ship request, hand off on the keeper with a Review URL.",
    );
    expect(activeReviewRule).toContain(
      "Akhil's process defaults to keeper handoff plus the Review URL.",
    );
  });

  it("names the verified live Vercel project and branch-scoped staging environment", () => {
    expect(rootInstructions).toContain("Vercel project `proplane`");
    expect(deploymentWorkflow).toContain("`prj_rupckw3T2v0oXVg2nTLVCYePKDUc`");
    expect(deploymentWorkflow).toContain("`staging` branch-scoped variables");
    expect(deploymentWorkflow).not.toContain("Vercel project** `axis-2`");
  });

  it("keeps the temporary direct-production exception dated and consistently linked", () => {
    expect(temporaryPolicy).toEqual({
      version: 1,
      kind: "temporary-direct-production-release",
      authorizedDeveloper: "Akhil",
      source: "origin/main",
      target: "origin/production",
      expiresAt: "2026-09-15T04:00:00Z",
    });
    for (const source of [
      rootInstructions,
      akhilInstructions,
      deploymentWorkflow,
      shipGate,
    ]) {
      expect(source).toContain("temporary-direct-production-policy.json");
      expect(source).toContain("2026-09-15T04:00:00Z");
    }
    expect(shipPreflight).toContain(
      "exception: docs/agents/temporary-direct-production-policy.json",
    );
    expect(shipPreflight).toContain("staging + production by default");
  });
});
