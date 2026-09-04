import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("clearPortalBrowserCache", () => {
  const mod = readFileSync(path.join(process.cwd(), "src/lib/auth/clear-portal-browser-cache.ts"), "utf8");

  it("exports cache clearer and localhost guard", () => {
    expect(mod).toMatch(/export function clearPortalBrowserCache/);
    expect(mod).toMatch(/export function isLocalDevHost/);
    expect(mod).toMatch(/resetPropertyPipelineClientCache/);
  });

  it("matches axis and propplane cache key prefixes", () => {
    expect(mod).toMatch(/axis\[:_\]/);
    expect(mod).toMatch(/propplane\\\./);
  });
});

describe("wipe script browser-cache hint", () => {
  const script = readFileSync(path.join(process.cwd(), "scripts/wipe-test-db-all.mjs"), "utf8");

  it("prints clear_cache sign-in URL after wipe", () => {
    expect(script).toMatch(/clear_cache=1/);
    expect(script).toMatch(/sandbox:pin/);
  });
});
