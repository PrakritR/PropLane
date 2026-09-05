import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("promote scripts", () => {
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
