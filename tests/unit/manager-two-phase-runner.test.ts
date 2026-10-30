import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { proofEnvironment } from "../e2e/support/manager-proof-build.mjs";

describe("manager proof isolation", () => {
  it("blanks provider credentials while retaining DEV Auth configuration", () => {
    const env = proofEnvironment({ TWILIO_AUTH_TOKEN: "secret", CLAW_OTHER: "secret", STRIPE_SECRET_KEY: "secret", NEXT_PUBLIC_SUPABASE_URL: "https://emstjswhotsnyksqhqyf.supabase.co" });
    expect(env.TWILIO_AUTH_TOKEN).toBe(""); expect(env.CLAW_OTHER).toBe(""); expect(env.STRIPE_SECRET_KEY).toBe("");
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://emstjswhotsnyksqhqyf.supabase.co");
    expect(env.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3007");
  });
  it("requires build fingerprint and closed server before cleanup", () => {
    const runner = readFileSync("tests/e2e/support/manager-two-phase-runner.mjs", "utf8");
    expect(runner).toContain("marker.fingerprint !== productFingerprint()");
    expect(runner.indexOf("await Promise.race([serverExit")).toBeLessThan(runner.indexOf("manager-two-phase-cleanup.ts"));
    expect(runner).toContain("Proof port remains occupied; fixture retained");
  });
});
