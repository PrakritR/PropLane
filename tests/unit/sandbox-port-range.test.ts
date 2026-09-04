import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
