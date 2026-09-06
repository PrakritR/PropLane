import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function ignoreExit(ref: string): number {
  try {
    execFileSync("bash", ["scripts/vercel-should-build.sh"], {
      env: { ...process.env, VERCEL_GIT_COMMIT_REF: ref },
      stdio: "pipe",
    });
    return 0;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (typeof status === "number") return status;
    throw error;
  }
}

describe("vercel-should-build.sh", () => {
  it("builds staging and production", () => {
    // Vercel ignoreCommand: exit 1 = proceed with the build.
    expect(ignoreExit("staging")).toBe(1);
    expect(ignoreExit("production")).toBe(1);
  });

  it("skips every other branch", () => {
    expect(ignoreExit("cursor-1")).toBe(0);
    expect(ignoreExit("feat/anything")).toBe(0);
    expect(ignoreExit("prakrit")).toBe(0);
  });
});
    expect(ignoreExit("main")).toBe(0);
    expect(ignoreExit("")).toBe(0);
    expect(ignoreExit("unknown")).toBe(0);
