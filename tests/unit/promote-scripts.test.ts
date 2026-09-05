import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const integrateScript = readFileSync(
  "scripts/integrate-source-to-main-and-staging.sh",
  "utf8",
);

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

  it("keeps vercel.json deployed branches on the three-rung allowlist", () => {
    const raw = readFileSync("vercel.json", "utf8");
    const config = JSON.parse(raw) as {
      git?: { deploymentEnabled?: Record<string, boolean> };
    };
    expect(config.git?.deploymentEnabled).toEqual({
      "**": false,
      main: true,
      staging: true,
      production: true,
    });
  });
});
