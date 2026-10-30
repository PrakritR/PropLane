import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The repository is public: a password written in source is a password anyone can read.
describe("approved-resident provisioning", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/auth/provision-approved-resident.ts"), "utf8");

  it("never creates an account with a known password", () => {
    expect(source).not.toMatch(/AUTO_RESIDENT_PASSWORD/);
    expect(source).not.toMatch(/password:\s*["'`]/);
    expect(source).toMatch(/password:\s*randomBytes\(32\)\.toString\("base64url"\)/);
  });
});
