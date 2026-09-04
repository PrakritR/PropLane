import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  // @ts-expect-error — plain-node seed helper, no types
  DOGFOOD_ACCOUNT_PASSWORD,
  // @ts-expect-error — plain-node seed helper, no types
  DOGFOOD_KEEP_EMAILS,
  // @ts-expect-error — plain-node seed helper, no types
  DOGFOOD_MANAGER_EMAIL,
  // @ts-expect-error — plain-node seed helper, no types
  DOGFOOD_RESIDENT_EMAIL,
} from "../helpers/canonical-test-accounts.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function readRepo(rel: string) {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

describe("captain dogfood accounts stay on the seed keep-list", () => {
  it("exports the manager and resident pair", () => {
    expect(DOGFOOD_MANAGER_EMAIL).toBe("akhil-manager@prop-lane.space");
    expect(DOGFOOD_RESIDENT_EMAIL).toBe("akhil-resident@prop-lane.space");
    expect(DOGFOOD_ACCOUNT_PASSWORD).toBe("Password123!");
    expect(DOGFOOD_KEEP_EMAILS).toContain(DOGFOOD_MANAGER_EMAIL);
    expect(DOGFOOD_KEEP_EMAILS).toContain(DOGFOOD_RESIDENT_EMAIL);
  });

  it("test:seed prune and recreate both reference the keep-list", () => {
    const seed = readRepo("tests/helpers/seed-test-db.mjs");
    expect(seed).toContain("DOGFOOD_KEEP_EMAILS");
    expect(seed).toContain("scripts/seed-akhil-dev-accounts.mjs");
  });

  it("nuclear wipe skips dogfood auth users instead of deleting them", () => {
    const wipe = readRepo("scripts/wipe-test-db-all.mjs");
    expect(wipe).toContain("DOGFOOD_KEEP_EMAILS");
    expect(wipe).toContain("kept dogfood auth user");
    expect(wipe).toMatch(/never automatic/i);
  });

  it("portal purges keep the dogfood pair", () => {
    const extra = readRepo("scripts/purge-extra-portal-accounts.mjs");
    const managers = readRepo("scripts/purge-non-demo-managers.mjs");
    expect(extra).toContain(DOGFOOD_MANAGER_EMAIL);
    expect(extra).toContain(DOGFOOD_RESIDENT_EMAIL);
    expect(managers).toContain(DOGFOOD_MANAGER_EMAIL);
  });
});
