import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** PRP-374 — lapsed client session must not leave a signed-in shell around dead panels. */
describe("PRP-374 portal client session guard", () => {
  const guard = read("src/components/portal/portal-client-session-guard.tsx");

  it("redirects to sign-in when the client session is gone but the shell rendered", () => {
    expect(guard).toContain("usePortalSession");
    expect(guard).toContain("clearStaleBrowserAuth");
    expect(guard).toContain("/auth/sign-in?next=");
  });

  it("is mounted on every portal shell layout", () => {
    for (const layout of [
      "src/app/portal/layout.tsx",
      "src/app/resident/layout.tsx",
      "src/app/vendor/layout.tsx",
      "src/app/admin/layout.tsx",
    ]) {
      expect(read(layout), layout).toContain("PortalClientSessionGuard");
    }
  });
});
