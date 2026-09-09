import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * A dev server on a port outside the allow-listed range cannot be driven by the
 * browser tools: navigation is refused as ERR_BLOCKED_BY_CLIENT, which reads as
 * "the page is broken", not "the origin was not allow-listed". That is how a
 * server ended up on 3111 with browser QA refused on the only server that
 * existed (PRP-191). `sandbox:pin` accepted any 2-5 digit port, so nothing
 * stopped it.
 */
const SCRIPT = join(process.cwd(), "scripts/pin-sandbox-port.mjs");

function run(port: string): { code: number; output: string } {
  try {
    const output = execFileSync("node", [SCRIPT, port], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, output };
  } catch (error) {
    const e = error as { status?: number; stderr?: string; stdout?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/**
 * The pin is appended to a real .env.local holding real credentials, so getting
 * the separator wrong does not just misplace a line - it rewrites the value of
 * whatever variable happened to be last. That is what happened: the separator
 * was chosen by testing the UNTRIMMED text for a trailing newline after
 * trimEnd() had already removed it, so a well-formed file (one that ends with a
 * newline, i.e. every normal file) got the pin glued onto its last line. It
 * also left no line starting with the key, so the next run appended again
 * rather than replacing.
 */
const dirs: string[] = [];
function pinInto(contents: string | null, port = "3009"): string {
  const dir = mkdtempSync(join(tmpdir(), "axis-pin-"));
  dirs.push(dir);
  if (contents !== null) writeFileSync(join(dir, ".env.local"), contents, "utf8");
  execFileSync("node", [SCRIPT, port], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  return readFileSync(join(dir, ".env.local"), "utf8");
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("sandbox:pin writes a whole line", () => {
  it("never appends onto the last variable of a newline-terminated file", () => {
    const out = pinInto("LINEAR_API_KEY=secret-value\n");
    expect(out).toContain("LINEAR_API_KEY=secret-value\n");
    expect(out).toContain("\nNEXT_PUBLIC_APP_URL=http://localhost:3009\n");
    expect(out).not.toContain("secret-valueNEXT_PUBLIC_APP_URL");
  });

  it("also separates correctly when the file has no trailing newline", () => {
    const out = pinInto("LINEAR_API_KEY=secret-value");
    expect(out).toContain("LINEAR_API_KEY=secret-value\n");
    expect(out).not.toContain("secret-valueNEXT_PUBLIC_APP_URL");
  });

  it("replaces the pin instead of accumulating one per run", () => {
    const dir = mkdtempSync(join(tmpdir(), "axis-pin-"));
    dirs.push(dir);
    writeFileSync(join(dir, ".env.local"), "SMS_COMM_UI_ENABLED=0\n", "utf8");
    for (const port of ["3007", "3009"]) {
      execFileSync("node", [SCRIPT, port], { cwd: dir, encoding: "utf8", stdio: "pipe" });
    }
    const out = readFileSync(join(dir, ".env.local"), "utf8");
    expect(out.match(/NEXT_PUBLIC_APP_URL=/g)).toHaveLength(1);
    expect(out).toContain("NEXT_PUBLIC_APP_URL=http://localhost:3009");
    expect(out).toContain("SMS_COMM_UI_ENABLED=0\n");
  });

  it("creates the file when there is none", () => {
    expect(pinInto(null)).toBe("NEXT_PUBLIC_APP_URL=http://localhost:3009\n");
  });
});

describe("sandbox:pin enforces the canonical port range", () => {
  it("refuses a port outside 3000-3014", () => {
    const { code, output } = run("3111");
    expect(code).not.toBe(0);
    expect(output).toContain("outside the sandbox range 3000-3014");
  });

  it("explains what would go wrong, not just that it refused", () => {
    // The whole cost of this bug was that the symptom did not name its cause.
    const { output } = run("3111");
    expect(output).toContain("ERR_BLOCKED_BY_CLIENT");
    expect(output).toContain("check:mcp");
  });

  it("names both files to widen, so the range cannot drift in one place", () => {
    const { output } = run("9999");
    expect(output).toContain(".mcp.json");
    expect(output).toContain(".cursor/mcp.json");
    expect(output).toContain("check-mcp-parity.mjs");
  });

  it("agrees with the range check:mcp actually asserts", () => {
    const parity = readFileSync(join(process.cwd(), "scripts/check-mcp-parity.mjs"), "utf8");
    expect(parity).toContain("port = 3000; port <= 3014");
    const pin = readFileSync(SCRIPT, "utf8");
    expect(pin).toContain("SANDBOX_PORT_MIN = 3000");
    expect(pin).toContain("SANDBOX_PORT_MAX = 3014");
  });
});
