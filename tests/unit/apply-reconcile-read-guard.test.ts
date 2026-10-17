import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every visit to an apply link minted a new draft when the reconcile read failed: a failed or timed-out
 * read leaves the resident's drafts out of the cache, and "nothing matches" then meant "fresh target".
 * The portal reconcile must retry a failed read and look at its status before it concludes that.
 */
describe("portal apply reconcile read", () => {
  const source = readFileSync("src/components/marketing/rental-application-wizard.tsx", "utf8");

  it("reads the resident's applications with their status and retries a failed read", () => {
    expect(source).toContain("syncManagerApplicationsFromServerWithStatus({ force: true })");
    expect(source).toMatch(/RECONCILE_READ_ATTEMPTS\s*=\s*[2-9]/);
    expect(source).toContain("if (result.ok) break;");
  });

  it("never reconciles through the status-blind sync", () => {
    expect(source).not.toMatch(/syncManagerApplicationsFromServer\(\{ force: true \}\)\.then/);
  });
});
