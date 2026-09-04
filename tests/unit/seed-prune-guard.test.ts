import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `npm run seed:dev` silently deleted twelve accounts other people were
 * actively using, including two `@prop-lane.space` addresses (PRP-190). The
 * prune's model — "the canonical set is the truth, everything else is litter" —
 * is right for a CI run against a disposable database and wrong for the shared
 * dev project several lanes work in at once. The failure a teammate then saw
 * was "Invalid login credentials", which reads like a product bug.
 */
const SEED = readFileSync(join(process.cwd(), "tests/helpers/seed-test-db.mjs"), "utf8");

function pruneSection(): string {
  const start = SEED.indexOf("const { data: allUsersData, error: allUsersErr }");
  expect(start).toBeGreaterThan(-1);
  return SEED.slice(start, SEED.indexOf("const prunedAccounts = []", start) + 200);
}

describe("the seed's account prune", () => {
  it("only ever considers the test namespace", () => {
    const section = pruneSection();
    expect(section).toContain('TEST_ACCOUNT_DOMAIN = "@test.proplane.local"');
    expect(section).toContain("email.endsWith(TEST_ACCOUNT_DOMAIN)");
  });

  it("reports what it left alone, so a surprising exclusion is visible", () => {
    expect(pruneSection()).toContain("Left ${outOfNamespace.length} non-test account(s) alone");
  });

  it("does not delete outside CI unless asked explicitly", () => {
    const section = pruneSection();
    expect(section).toContain('process.argv.includes("--prune")');
    expect(section).toContain('process.env.SEED_PRUNE_STRAYS === "1"');
    expect(section).toContain('process.env.CI === "true"');
  });

  it("names what it skipped and how to get it, rather than staying silent", () => {
    const section = pruneSection();
    expect(section).toContain("Skipped pruning");
    expect(section).toContain("Re-run with --prune");
  });

  it("still empties the list it skipped, so nothing downstream deletes it anyway", () => {
    // The delete loop reads `strayUsers`; leaving it populated would make the
    // guard cosmetic.
    expect(pruneSection()).toContain("strayUsers.length = 0;");
  });
});
