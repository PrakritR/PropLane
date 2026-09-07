import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** PRP-361 — failed portal-roles fetch must not leave "Loading…" stuck forever. */
describe("PRP-361 choose-portal roles load", () => {
  const source = read("src/app/auth/choose-portal/page.tsx");

  it("redirects 401 to sign-in with the chooser preserved in next", () => {
    expect(source).toContain('res.status === 401');
    expect(source).toContain("/auth/sign-in?next=");
    expect(source).toContain("choosePortalSignInNext");
  });

  it("clears the loading state on error and offers retry", () => {
    expect(source).toContain('result.kind === "error"');
    expect(source).toContain("setRoles([])");
    expect(source).toContain("choose-portal-retry");
    expect(source).not.toMatch(/setError\([^)]+\);\s*return;/);
  });
});
