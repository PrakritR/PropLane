import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validatedEnvironment } from "../e2e/support/manager-proof-build.mjs";
const token = (ref: string) => `x.${Buffer.from(JSON.stringify({ ref })).toString("base64url")}.x`;
describe("manager proof isolation", () => {
  it("pins both DEV credentials and blanks inherited and local provider keys", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "proof-env-"));
    try {
      const write = (anon: string, service: string) => writeFileSync(path.join(dir, ".env.test"), `NEXT_PUBLIC_SUPABASE_URL=https://emstjswhotsnyksqhqyf.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=${anon}\nSUPABASE_SERVICE_ROLE_KEY=${service}\n`);
      const good = token("emstjswhotsnyksqhqyf");
      write(good, good); writeFileSync(path.join(dir, ".env.local"), "TWILIO_LOCAL_SECRET=bad\nCLAW_LOCAL_SECRET=bad\n");
      const env = validatedEnvironment({ TWILIO_INHERITED_SECRET: "bad", CLAW_INHERITED_SECRET: "bad" }, dir);
      expect(env.TWILIO_LOCAL_SECRET).toBe(""); expect(env.CLAW_LOCAL_SECRET).toBe("");
      expect(env.TWILIO_INHERITED_SECRET).toBe(""); expect(env.CLAW_INHERITED_SECRET).toBe("");
      expect(env.SUPABASE_URL).toBe("https://emstjswhotsnyksqhqyf.supabase.co"); expect(env.NODE_ENV).toBe("production"); expect(env.E2E_TESTS_ENABLED).toBe("1");
      write(token("wrong"), good); expect(() => validatedEnvironment({}, dir)).toThrow(/credential/i);
      write(good, token("wrong")); expect(() => validatedEnvironment({}, dir)).toThrow(/credential/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("requires build fingerprint and closed server before cleanup", () => {
    const runner = readFileSync("tests/e2e/support/manager-two-phase-runner.mjs", "utf8");
    expect(runner).toContain("marker.fingerprint !== productFingerprint()");
    expect(runner).toContain("marker.envDigest !== envDigest()");
    expect(runner.indexOf("await Promise.race([serverExit")).toBeLessThan(runner.indexOf("manager-two-phase-cleanup.ts"));
    expect(runner).toContain("Proof port remains occupied; fixture retained");
  });
});
