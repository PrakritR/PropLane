import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function run(env: NodeJS.ProcessEnv): { status: number; stderr: string } {
  try {
    execFileSync("node", ["scripts/assert-nonprod-supabase-url.mjs"], {
      env: { ...process.env, ...env },
      stdio: "pipe",
    });
    return { status: 0, stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stderr?: Buffer };
    return { status: err.status ?? 1, stderr: String(err.stderr) };
  }
}

describe("assert-nonprod-supabase-url.mjs", () => {
  const prodRef = "qahnczmilgptcedaqype";

  it("fails when the URL is the live production project", () => {
    const result = run({
      AXIS_PROD_SUPABASE_REF: prodRef,
      NEXT_PUBLIC_SUPABASE_URL: `https://${prodRef}.supabase.co`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/live production/i);
  });

  it("fails when the URL is missing", () => {
    const result = run({
      AXIS_PROD_SUPABASE_REF: prodRef,
      NEXT_PUBLIC_SUPABASE_URL: "",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/empty/i);
  });

  it("passes for the shared dev/test project", () => {
    const result = run({
      AXIS_PROD_SUPABASE_REF: prodRef,
      NEXT_PUBLIC_SUPABASE_URL: "https://emstjswhotsnyksqhqyf.supabase.co",
    });
    expect(result.status).toBe(0);
  });
});
